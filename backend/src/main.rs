mod db;
mod protocol;
mod webrtc_peer;

use anyhow::{anyhow, Context, Result};
use db::Store;
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientFrame, DataChannelServerFrame, ServerFrame};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::{collections::{HashMap, VecDeque}, env, fs::File, io::BufReader, net::IpAddr, pin::Pin, sync::Arc, task::{Context as TaskContext, Poll}};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader as TokioBufReader, ReadBuf},
    net::TcpListener,
    sync::{mpsc, Mutex, Semaphore},
    time::{timeout, Duration, Instant},
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;
use webrtc::peer_connection::PeerConnection;
use webrtc_peer::{build_answerer, run_delivery_worker, send_to_user, LiveChannels, LiveSignaling};

const MAX_SIGNAL_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Default)]
struct AuthRateLimiter {
    attempts: Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>,
}

impl AuthRateLimiter {
    async fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut all = self.attempts.lock().await;
        if all.len() > 10_000 {
            all.retain(|_, entries| entries.back().is_some_and(|last| now.duration_since(*last) < Duration::from_secs(60)));
        }
        let entries = all.entry(ip).or_default();
        while entries.front().is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60)) {
            entries.pop_front();
        }
        if entries.len() >= 10 { return false; }
        entries.push_back(now);
        true
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().with_env_filter(
        env::var("RUST_LOG").unwrap_or_else(|_| "nexa_messenger_server=info,webrtc=warn".into()),
    ).init();

    let url = env::var("TURSO_DATABASE_URL").context("TURSO_DATABASE_URL missing")?;
    let token = env::var("TURSO_AUTH_TOKEN").context("TURSO_AUTH_TOKEN missing")?;
    let store = Store::connect(&url, &token).await?;
    store.migrate().await?;

    let channels: LiveChannels = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let live_signaling: LiveSignaling = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let auth_limiter = AuthRateLimiter::default();
    let max_connections = env::var("MAX_SIGNAL_CONNECTIONS").ok().and_then(|value| value.parse::<usize>().ok()).unwrap_or(100_000).clamp(10, 1_000_000);
    let connection_slots = Arc::new(Semaphore::new(max_connections));
    tokio::spawn(run_delivery_worker(store.clone(), channels.clone(), live_signaling.clone()));
    let ice_urls: Vec<String> = env::var("ICE_URLS")
        .unwrap_or_else(|_| "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302".into())
        .split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();

    // 1. WebSocket listener (Port 80/443 on Render via $PORT, or 7444 for local dev)
    let ws_bind = env::var("PORT")
        .map(|p| format!("0.0.0.0:{}", p))
        .or_else(|_| env::var("WS_BIND"))
        .unwrap_or_else(|_| "0.0.0.0:7444".into());

    let ws_listener = match TcpListener::bind(&ws_bind).await {
        Ok(l) => {
            tracing::info!(%ws_bind, "Nexa WebSocket (WSS/WS) signaling listener started");
            Some(l)
        }
        Err(err) => {
            tracing::warn!(%ws_bind, error = %err, "Could not bind WebSocket listener");
            None
        }
    };

    if let Some(listener) = ws_listener {
        let store_ws = store.clone();
        let channels_ws = channels.clone();
        let live_sig_ws = live_signaling.clone();
        let ice_urls_ws = ice_urls.clone();
        let auth_limiter_ws = auth_limiter.clone();
        let slots_ws = connection_slots.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, peer_addr)) = listener.accept().await else { break; };
                let permit = match slots_ws.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let _ = stream.set_nodelay(true);
                let st = store_ws.clone();
                let ch = channels_ws.clone();
                let ls = live_sig_ws.clone();
                let iu = ice_urls_ws.clone();
                let al = auth_limiter_ws.clone();
                let client_ip = peer_addr.ip();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(err) = handle_ws_client(stream, st, ch, ls, iu, al, client_ip).await {
                        tracing::debug!(%peer_addr, error = %err, "WebSocket client ended");
                    }
                });
            }
        });
    }

    // 2. Raw TLS listener (Port 7443 for local LAN or VPS with custom certs)
    let cert_path = env::var("TLS_CERT_PATH").unwrap_or_else(|_| "./certs/server.crt".into());
    let key_path = env::var("TLS_KEY_PATH").unwrap_or_else(|_| "./certs/server.key".into());
    let tls_available = std::path::Path::new(&cert_path).exists() && std::path::Path::new(&key_path).exists();

    if tls_available {
        match build_tls_acceptor(&cert_path, &key_path) {
            Ok(tls) => {
                let bind = env::var("SIGNAL_BIND").unwrap_or_else(|_| "0.0.0.0:7443".into());
                if let Ok(listener) = TcpListener::bind(&bind).await {
                    tracing::info!(%bind, "Nexa TLS signaling listener started (raw TLS/TCP)");
                    let store_tcp = store.clone();
                    let channels_tcp = channels.clone();
                    let live_sig_tcp = live_signaling.clone();
                    let ice_urls_tcp = ice_urls.clone();
                    let auth_limiter_tcp = auth_limiter.clone();
                    let slots_tcp = connection_slots.clone();
                    tokio::spawn(async move {
                        loop {
                            let Ok((stream, peer_addr)) = listener.accept().await else { break; };
                            let permit = match slots_tcp.clone().acquire_owned().await {
                                Ok(p) => p,
                                Err(_) => break,
                            };
                            let _ = stream.set_nodelay(true);
                            let acceptor = tls.clone();
                            let st = store_tcp.clone();
                            let ch = channels_tcp.clone();
                            let ls = live_sig_tcp.clone();
                            let iu = ice_urls_tcp.clone();
                            let al = auth_limiter_tcp.clone();
                            let client_ip = peer_addr.ip();
                            tokio::spawn(async move {
                                let _permit = permit;
                                match timeout(Duration::from_secs(10), acceptor.accept(stream)).await {
                                    Ok(Ok(stream)) => {
                                        if let Err(err) = handle_client(stream, st, ch, ls, iu, al, client_ip).await {
                                            tracing::warn!(%peer_addr, error = %err, "signaling connection ended");
                                        }
                                    }
                                    Ok(Err(err)) => tracing::warn!(%peer_addr, error = %err, "TLS handshake failed"),
                                    Err(_) => tracing::warn!(%peer_addr, "TLS handshake timed out"),
                                }
                            });
                        }
                    });
                }
            }
            Err(err) => {
                tracing::info!(error = %err, "Raw TLS certs not loaded; running in cloud WebSocket mode");
            }
        }
    } else {
        tracing::info!("Raw TLS certs not found; running exclusively with cloud WebSocket signaling");
    }

    // Keep server process alive
    tokio::signal::ctrl_c().await?;
    tracing::info!("Nexa Messenger server shutting down");
    Ok(())
}

fn build_tls_acceptor(cert_path: &str, key_path: &str) -> Result<TlsAcceptor> {
    let cert_file = File::open(cert_path).with_context(|| format!("open TLS cert {cert_path}"))?;
    let key_file = File::open(key_path).with_context(|| format!("open TLS key {key_path}"))?;
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut BufReader::new(cert_file))
        .collect::<std::result::Result<_, _>>()?;
    anyhow::ensure!(!certs.is_empty(), "TLS certificate file contains no certificates");
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut BufReader::new(key_file))?
        .context("TLS private key file contains no private key")?;
    // Signaling is intentionally TLS 1.3 only. WebRTC's separate DTLS transport is
    // negotiated by the WebRTC implementation and is not affected by this setting.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("certificate and private key do not match")?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

async fn is_user_online(channels: &LiveChannels, live_signaling: &LiveSignaling, uid: &str) -> bool {
    channels.read().await.contains_key(uid) || live_signaling.read().await.contains_key(uid)
}

async fn handle_client<S>(stream: S, store: Store, channels: LiveChannels, live_signaling: LiveSignaling, ice_urls: Vec<String>, auth_limiter: AuthRateLimiter, client_ip: IpAddr) -> Result<()>
where
    S: AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = TokioBufReader::with_capacity(8 * 1024, reader);
    let (signal_tx, mut signal_rx) = mpsc::channel::<ServerFrame>(128);
    tokio::spawn(async move {
        while let Some(frame) = signal_rx.recv().await {
            let Ok(mut bytes) = serde_json::to_vec(&frame) else { continue; };
            bytes.push(b'\n');
            if writer.write_all(&bytes).await.is_err() { break; }
        }
    });

    let mut current_user: Option<protocol::UserSummary> = None;
    let mut current_session_token: Option<String> = None;
    let mut current_peer: Option<Arc<dyn PeerConnection>> = None;
    let mut last_session_check = Instant::now();

    while let Some(line) = read_bounded_line(&mut reader, MAX_SIGNAL_FRAME_BYTES).await? {
        if line.trim().is_empty() { continue; }
        let frame: ClientFrame = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(_) => {
                send_error(&signal_tx, "BAD_FRAME", "invalid signaling frame").await?;
                continue;
            }
        };

        // A long-lived TLS socket must not outlive a revoked or expired session forever.
        // Revalidate once per minute to bound the revocation window without querying Turso
        // for every ICE candidate or application frame.
        let mut session_expired = false;
        if let Some(token) = current_session_token.clone() {
            if last_session_check.elapsed() >= Duration::from_secs(60) {
                last_session_check = Instant::now();
                match store.authenticate(&token).await {
                    Ok(user) => current_user = Some(user),
                    Err(_) => {
                        if let Some(u) = current_user.as_ref() { live_signaling.write().await.remove(&u.uid); }
                        current_user = None;
                        current_session_token = None;
                        if let Some(peer) = current_peer.take() { let _ = peer.close().await; }
                        session_expired = true;
                    }
                }
            }
        }
        if session_expired {
            send_error(&signal_tx, "SESSION_EXPIRED", "session expired or revoked; sign in again").await?;
            continue;
        }

        match frame {
            ClientFrame::Register { username, display_name, password } => {
                if current_user.is_some() {
                    send_error(&signal_tx, "ALREADY_AUTHENTICATED", "logout before changing account").await?;
                    continue;
                }
                if !auth_limiter.allow(client_ip).await {
                    send_error(&signal_tx, "RATE_LIMITED", "too many login attempts; try again in one minute").await?;
                    continue;
                }
                match store.register(&username, &display_name, &password).await {
                    Ok((user, token)) => {
                        current_user = Some(user.clone());
                        current_session_token = Some(token.clone());
                        last_session_check = Instant::now();
                        live_signaling.write().await.insert(user.uid.clone(), signal_tx.clone());
                        send_auth_ok(&signal_tx, user.clone(), token).await?;
                        crate::webrtc_peer::deliver_all_pending_via_signal(&store, &signal_tx, &user.uid).await;
                        crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                        crate::webrtc_peer::send_initial_presence_via_signal(&channels, &live_signaling, &signal_tx, &user.uid).await;
                    }
                    Err(err) => send_error(&signal_tx, "REGISTER_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Login { username, password } => {
                if current_user.is_some() {
                    send_error(&signal_tx, "ALREADY_AUTHENTICATED", "logout before changing account").await?;
                    continue;
                }
                if !auth_limiter.allow(client_ip).await {
                    send_error(&signal_tx, "RATE_LIMITED", "too many login attempts; try again in one minute").await?;
                    continue;
                }
                match store.login(&username, &password).await {
                    Ok((user, token)) => {
                        current_user = Some(user.clone());
                        current_session_token = Some(token.clone());
                        last_session_check = Instant::now();
                        live_signaling.write().await.insert(user.uid.clone(), signal_tx.clone());
                        send_auth_ok(&signal_tx, user.clone(), token).await?;
                        crate::webrtc_peer::deliver_all_pending_via_signal(&store, &signal_tx, &user.uid).await;
                        crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                        crate::webrtc_peer::send_initial_presence_via_signal(&channels, &live_signaling, &signal_tx, &user.uid).await;
                    }
                    Err(err) => send_error(&signal_tx, "LOGIN_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Resume { token } => {
                if current_user.is_some() {
                    send_error(&signal_tx, "ALREADY_AUTHENTICATED", "logout before changing account").await?;
                    continue;
                }
                match store.authenticate(&token).await {
                    Ok(user) => {
                        current_user = Some(user.clone());
                        current_session_token = Some(token.clone());
                        last_session_check = Instant::now();
                        live_signaling.write().await.insert(user.uid.clone(), signal_tx.clone());
                        send_auth_ok(&signal_tx, user.clone(), token).await?;
                        crate::webrtc_peer::deliver_all_pending_via_signal(&store, &signal_tx, &user.uid).await;
                        crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                        crate::webrtc_peer::send_initial_presence_via_signal(&channels, &live_signaling, &signal_tx, &user.uid).await;
                    }
                    Err(err) => send_error(&signal_tx, "AUTH_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Logout => {
                if let Some(user) = current_user.as_ref() {
                    live_signaling.write().await.remove(&user.uid);
                }
                if let Some(token) = current_session_token.as_ref() {
                    if let Err(err) = store.revoke_session(token).await {
                        tracing::error!(error = %err, "session revocation failed");
                        send_error(&signal_tx, "LOGOUT_FAILED", "could not revoke session; try again").await?;
                        continue;
                    }
                }
                current_session_token = None;
                current_user = None;
                if let Some(peer) = current_peer.take() { let _ = peer.close().await; }
                signal_tx.send(ServerFrame::LoggedOut).await.map_err(|_| anyhow!("signaling writer closed"))?;
            }
            ClientFrame::SearchUsers { query } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.search_users(&user.uid, &query).await {
                    Ok(mut users) => {
                        for item in &mut users {
                            item.online = is_user_online(&channels, &live_signaling, &item.uid).await;
                        }
                        signal_tx.send(ServerFrame::Users { users }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "SEARCH_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::ListConversations => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.list_conversations(&user.uid, 100).await {
                    Ok(mut conversations) => {
                        for item in &mut conversations {
                            item.user.online = is_user_online(&channels, &live_signaling, &item.user.uid).await;
                        }
                        signal_tx.send(ServerFrame::Conversations { conversations }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "CONVERSATIONS_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::UpdateProfile { display_name, about } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.update_profile(&user.uid, &display_name, &about).await {
                    Ok(updated) => {
                        current_user = Some(updated.clone());
                        signal_tx.send(ServerFrame::ProfileUpdated { user: updated }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "PROFILE_UPDATE_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::CreateConversation { other_uid } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.create_or_get_conversation(&user.uid, &other_uid).await {
                    Ok(()) => {
                        let result = async {
                            let conversation_id = store.get_conversation_id(&user.uid, &other_uid).await?;
                            let mut other = store.get_user(&other_uid).await?;
                            other.online = is_user_online(&channels, &live_signaling, &other_uid).await;
                            Ok::<_, anyhow::Error>((conversation_id, other))
                        }.await;
                        match result {
                            Ok((conversation_id, other)) => {
                                let notification = DataChannelServerFrame::NewConversation {
                                    conversation_id: conversation_id.clone(),
                                    user: user.clone(),
                                };
                                send_to_user(&channels, &live_signaling, &other_uid, &notification).await;
                                crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                                signal_tx.send(ServerFrame::Conversation { conversation_id, user: other }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                            }
                            Err(err) => send_error(&signal_tx, "CONVERSATION_FAILED", &safe_error(&err)).await?,
                        }
                    }
                    Err(err) => send_error(&signal_tx, "CONVERSATION_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::ConversationHistory { conversation_id, before } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.history(&user.uid, &conversation_id, before.as_deref(), 100).await {
                    Ok(messages) => {
                        signal_tx.send(ServerFrame::History { conversation_id, messages }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "HISTORY_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Offer { sdp } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login before WebRTC offer").await?;
                    continue;
                };
                if let Some(old_peer) = current_peer.take() { let _ = old_peer.close().await; }
                match build_answerer(user.uid.clone(), store.clone(), channels.clone(), live_signaling.clone(), signal_tx.clone(), sdp, ice_urls.clone()).await {
                    Ok((peer, answer_sdp)) => {
                        current_peer = Some(peer);
                        signal_tx.send(ServerFrame::Answer { sdp: answer_sdp }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "WEBRTC_NEGOTIATION_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::CallSignal { to_uid, payload } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required for call signaling").await?;
                    continue;
                };
                let from_uid = user.uid.clone();
                let mut sent = false;
                // 1. Send via TCP signaling socket (guaranteed delivery)
                {
                    let target_tx = { live_signaling.read().await.get(&to_uid).cloned() };
                    if let Some(tx) = target_tx {
                        let _ = tx.send(ServerFrame::CallSignal {
                            from_uid: from_uid.clone(),
                            payload: payload.clone(),
                        }).await;
                        sent = true;
                    }
                }
                // 2. Also forward via DataChannel if active
                {
                    let target_dc = { channels.read().await.get(&to_uid).cloned() };
                    if let Some(dc) = target_dc {
                        let frame = DataChannelServerFrame::CallSignal {
                            from_uid: from_uid.clone(),
                            payload: payload.clone(),
                        };
                        if let Ok(json_str) = serde_json::to_string(&frame) {
                            crate::webrtc_peer::send_safe_text(&dc, &json_str).await;
                            sent = true;
                        }
                    }
                }
                tracing::info!(from = %from_uid, to = %to_uid, signal_type = ?payload.get("type"), sent = %sent, "call_signal dispatched");
                if !sent && payload.get("type").and_then(|t| t.as_str()) == Some("call_invite") {
                    let _ = signal_tx.send(ServerFrame::CallSignal {
                        from_uid: to_uid,
                        payload: serde_json::json!({
                            "type": "call_busy",
                            "callId": payload.get("callId"),
                            "reason": "offline"
                        }),
                    }).await;
                }
            }
            ClientFrame::IceCandidate { candidate } => {
                if let Some(peer) = current_peer.as_ref() {
                    match serde_json::from_value::<webrtc::peer_connection::RTCIceCandidateInit>(candidate) {
                        Ok(cand_init) => {
                            tracing::info!(candidate = %cand_init.candidate, "server accepted client ICE candidate");
                            let _ = peer.add_ice_candidate(cand_init).await;
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "could not parse client ICE candidate");
                        }
                    }
                }
            }
            ClientFrame::PublishPrekeys { bundle } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                let bundle_str = bundle.to_string();
                match store.save_prekey_bundle(&user.uid, &bundle_str).await {
                    Ok(()) => {
                        signal_tx.send(ServerFrame::PrekeysPublished).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "PREKEY_SAVE_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::GetPrekeyBundle { uid } => {
                let Some(_) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.get_prekey_bundle(&uid).await {
                    Ok(Some(bundle_str)) => {
                        let bundle: serde_json::Value = serde_json::from_str(&bundle_str).unwrap_or(serde_json::Value::Null);
                        signal_tx.send(ServerFrame::PrekeyBundle { uid, bundle }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Ok(None) => send_error(&signal_tx, "PREKEY_NOT_FOUND", "user has not published prekeys").await?,
                    Err(err) => send_error(&signal_tx, "PREKEY_FETCH_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::DataFrame { payload } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                if let Ok(dc_frame) = serde_json::from_value::<protocol::DataChannelClientFrame>(payload) {
                    crate::webrtc_peer::handle_client_frame(
                        dc_frame,
                        None,
                        Some(&signal_tx),
                        &store,
                        &channels,
                        &live_signaling,
                        &user.uid,
                    ).await;
                }
            }
            ClientFrame::Ping => {
                signal_tx.send(ServerFrame::Pong).await.map_err(|_| anyhow!("signaling writer closed"))?;
            }
        }
    }

    if let Some(peer) = current_peer { let _ = peer.close().await; }
    if let Some(user) = current_user {
        // A superseded socket must not remove the new login's sender/channel.
        let mut connected = live_signaling.write().await;
        if connected.get(&user.uid).is_some_and(|tx| tx.same_channel(&signal_tx)) {
            connected.remove(&user.uid);
        }
        drop(connected);
        let still_online = is_user_online(&channels, &live_signaling, &user.uid).await;
        if !still_online {
            crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, false).await;
        }
    }
    Ok(())
}

struct PrefixedStream<S> {
    prefix: Vec<u8>,
    pos: usize,
    inner: S,
}

impl<S> PrefixedStream<S> {
    fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self { prefix, pos: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.pos < self.prefix.len() {
            let available = &self.prefix[self.pos..];
            let to_copy = std::cmp::min(available.len(), buf.remaining());
            buf.put_slice(&available[..to_copy]);
            self.pos += to_copy;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

async fn handle_ws_client(
    mut stream: tokio::net::TcpStream,
    store: Store,
    channels: LiveChannels,
    live_signaling: LiveSignaling,
    ice_urls: Vec<String>,
    auth_limiter: AuthRateLimiter,
    client_ip: IpAddr,
) -> Result<()> {
    // Read initial data from stream (waiting up to 5 seconds for client probe or websocket headers)
    let mut initial_buf = Vec::new();
    let mut temp = [0u8; 1024];
    loop {
        let n = match timeout(Duration::from_secs(5), stream.read(&mut temp)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => break,
        };
        initial_buf.extend_from_slice(&temp[..n]);
        if initial_buf.windows(4).any(|w| w == b"\r\n\r\n") || initial_buf.len() >= 4096 {
            break;
        }
    }

    if initial_buf.is_empty() {
        return Ok(());
    }

    let req_str = String::from_utf8_lossy(&initial_buf);
    let is_ws_upgrade = req_str.to_lowercase().contains("upgrade: websocket");

    // If Render port scanner, health check probe, or web browser sends a plain HTTP request
    if !is_ws_upgrade {
        let body = b"{\"status\":\"ok\",\"service\":\"nexa-messenger-server\"}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
        return Ok(());
    }

    let prefixed = PrefixedStream::new(initial_buf, stream);
    let ws_stream = tokio_tungstenite::accept_async(prefixed).await
        .context("WebSocket handshake failed")?;
    let (mut ws_writer, mut ws_reader) = ws_stream.split();

    let (signal_tx, mut signal_rx) = mpsc::channel::<ServerFrame>(128);
    tokio::spawn(async move {
        while let Some(frame) = signal_rx.recv().await {
            let Ok(text) = serde_json::to_string(&frame) else { continue; };
            if ws_writer.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let mut current_user: Option<protocol::UserSummary> = None;
    let mut current_session_token: Option<String> = None;
    let mut current_peer: Option<Arc<dyn PeerConnection>> = None;
    let mut last_session_check = Instant::now();

    while let Some(msg_res) = ws_reader.next().await {
        let msg = match msg_res {
            Ok(m) => m,
            Err(_) => break,
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };
        if text.trim().is_empty() { continue; }
        let frame: ClientFrame = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(_) => {
                send_error(&signal_tx, "BAD_FRAME", "invalid signaling frame").await?;
                continue;
            }
        };

        let mut session_expired = false;
        if let Some(token) = current_session_token.clone() {
            if last_session_check.elapsed() >= Duration::from_secs(60) {
                last_session_check = Instant::now();
                match store.authenticate(&token).await {
                    Ok(user) => current_user = Some(user),
                    Err(_) => {
                        if let Some(u) = current_user.as_ref() { live_signaling.write().await.remove(&u.uid); }
                        current_user = None;
                        current_session_token = None;
                        if let Some(peer) = current_peer.take() { let _ = peer.close().await; }
                        session_expired = true;
                    }
                }
            }
        }
        if session_expired {
            send_error(&signal_tx, "SESSION_EXPIRED", "session expired or revoked; sign in again").await?;
            continue;
        }

        match frame {
            ClientFrame::Register { username, display_name, password } => {
                if current_user.is_some() {
                    send_error(&signal_tx, "ALREADY_AUTHENTICATED", "logout before changing account").await?;
                    continue;
                }
                if !auth_limiter.allow(client_ip).await {
                    send_error(&signal_tx, "RATE_LIMITED", "too many login attempts; try again in one minute").await?;
                    continue;
                }
                match store.register(&username, &display_name, &password).await {
                    Ok((user, token)) => {
                        current_user = Some(user.clone());
                        current_session_token = Some(token.clone());
                        last_session_check = Instant::now();
                        live_signaling.write().await.insert(user.uid.clone(), signal_tx.clone());
                        send_auth_ok(&signal_tx, user.clone(), token).await?;
                        crate::webrtc_peer::deliver_all_pending_via_signal(&store, &signal_tx, &user.uid).await;
                        crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                        crate::webrtc_peer::send_initial_presence_via_signal(&channels, &live_signaling, &signal_tx, &user.uid).await;
                    }
                    Err(err) => send_error(&signal_tx, "REGISTER_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Login { username, password } => {
                if current_user.is_some() {
                    send_error(&signal_tx, "ALREADY_AUTHENTICATED", "logout before changing account").await?;
                    continue;
                }
                if !auth_limiter.allow(client_ip).await {
                    send_error(&signal_tx, "RATE_LIMITED", "too many login attempts; try again in one minute").await?;
                    continue;
                }
                match store.login(&username, &password).await {
                    Ok((user, token)) => {
                        current_user = Some(user.clone());
                        current_session_token = Some(token.clone());
                        last_session_check = Instant::now();
                        live_signaling.write().await.insert(user.uid.clone(), signal_tx.clone());
                        send_auth_ok(&signal_tx, user.clone(), token).await?;
                        crate::webrtc_peer::deliver_all_pending_via_signal(&store, &signal_tx, &user.uid).await;
                        crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                        crate::webrtc_peer::send_initial_presence_via_signal(&channels, &live_signaling, &signal_tx, &user.uid).await;
                    }
                    Err(err) => send_error(&signal_tx, "LOGIN_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Resume { token } => {
                if current_user.is_some() {
                    send_error(&signal_tx, "ALREADY_AUTHENTICATED", "logout before changing account").await?;
                    continue;
                }
                match store.authenticate(&token).await {
                    Ok(user) => {
                        current_user = Some(user.clone());
                        current_session_token = Some(token.clone());
                        last_session_check = Instant::now();
                        live_signaling.write().await.insert(user.uid.clone(), signal_tx.clone());
                        send_auth_ok(&signal_tx, user.clone(), token).await?;
                        crate::webrtc_peer::deliver_all_pending_via_signal(&store, &signal_tx, &user.uid).await;
                        crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                        crate::webrtc_peer::send_initial_presence_via_signal(&channels, &live_signaling, &signal_tx, &user.uid).await;
                    }
                    Err(err) => send_error(&signal_tx, "AUTH_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Logout => {
                if let Some(user) = current_user.as_ref() {
                    live_signaling.write().await.remove(&user.uid);
                }
                if let Some(token) = current_session_token.as_ref() {
                    if let Err(err) = store.revoke_session(token).await {
                        tracing::error!(error = %err, "session revocation failed");
                        send_error(&signal_tx, "LOGOUT_FAILED", "could not revoke session; try again").await?;
                        continue;
                    }
                }
                current_session_token = None;
                current_user = None;
                if let Some(peer) = current_peer.take() { let _ = peer.close().await; }
                signal_tx.send(ServerFrame::LoggedOut).await.map_err(|_| anyhow!("signaling writer closed"))?;
            }
            ClientFrame::SearchUsers { query } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.search_users(&user.uid, &query).await {
                    Ok(mut users) => {
                        for item in &mut users {
                            item.online = is_user_online(&channels, &live_signaling, &item.uid).await;
                        }
                        signal_tx.send(ServerFrame::Users { users }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "SEARCH_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::ListConversations => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.list_conversations(&user.uid, 100).await {
                    Ok(mut conversations) => {
                        for item in &mut conversations {
                            item.user.online = is_user_online(&channels, &live_signaling, &item.user.uid).await;
                        }
                        signal_tx.send(ServerFrame::Conversations { conversations }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "CONVERSATIONS_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::UpdateProfile { display_name, about } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.update_profile(&user.uid, &display_name, &about).await {
                    Ok(updated) => {
                        current_user = Some(updated.clone());
                        signal_tx.send(ServerFrame::ProfileUpdated { user: updated }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "PROFILE_UPDATE_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::CreateConversation { other_uid } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.create_or_get_conversation(&user.uid, &other_uid).await {
                    Ok(()) => {
                        let result = async {
                            let conversation_id = store.get_conversation_id(&user.uid, &other_uid).await?;
                            let mut other = store.get_user(&other_uid).await?;
                            other.online = is_user_online(&channels, &live_signaling, &other_uid).await;
                            Ok::<_, anyhow::Error>((conversation_id, other))
                        }.await;
                        match result {
                            Ok((conversation_id, other)) => {
                                let notification = DataChannelServerFrame::NewConversation {
                                    conversation_id: conversation_id.clone(),
                                    user: user.clone(),
                                };
                                send_to_user(&channels, &live_signaling, &other_uid, &notification).await;
                                crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, true).await;
                                signal_tx.send(ServerFrame::Conversation { conversation_id, user: other }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                            }
                            Err(err) => send_error(&signal_tx, "CONVERSATION_FAILED", &safe_error(&err)).await?,
                        }
                    }
                    Err(err) => send_error(&signal_tx, "CONVERSATION_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::ConversationHistory { conversation_id, before } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                match store.history(&user.uid, &conversation_id, before.as_deref(), 100).await {
                    Ok(messages) => {
                        signal_tx.send(ServerFrame::History { conversation_id, messages }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "HISTORY_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::Offer { sdp } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login before WebRTC offer").await?;
                    continue;
                };
                if let Some(old_peer) = current_peer.take() { let _ = old_peer.close().await; }
                match build_answerer(user.uid.clone(), store.clone(), channels.clone(), live_signaling.clone(), signal_tx.clone(), sdp, ice_urls.clone()).await {
                    Ok((peer, answer_sdp)) => {
                        current_peer = Some(peer);
                        signal_tx.send(ServerFrame::Answer { sdp: answer_sdp }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "WEBRTC_NEGOTIATION_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::CallSignal { to_uid, payload } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required for call signaling").await?;
                    continue;
                };
                let from_uid = user.uid.clone();
                let mut sent = false;
                // 1. Send via WebSocket signaling socket (guaranteed delivery)
                {
                    let target_tx = { live_signaling.read().await.get(&to_uid).cloned() };
                    if let Some(tx) = target_tx {
                        let _ = tx.send(ServerFrame::CallSignal {
                            from_uid: from_uid.clone(),
                            payload: payload.clone(),
                        }).await;
                        sent = true;
                    }
                }
                // 2. Also forward via DataChannel if active
                {
                    let target_dc = { channels.read().await.get(&to_uid).cloned() };
                    if let Some(dc) = target_dc {
                        let frame = DataChannelServerFrame::CallSignal {
                            from_uid: from_uid.clone(),
                            payload: payload.clone(),
                        };
                        if let Ok(json_str) = serde_json::to_string(&frame) {
                            crate::webrtc_peer::send_safe_text(&dc, &json_str).await;
                            sent = true;
                        }
                    }
                }
                tracing::info!(from = %from_uid, to = %to_uid, signal_type = ?payload.get("type"), sent = %sent, "call_signal dispatched");
                if !sent && payload.get("type").and_then(|t| t.as_str()) == Some("call_invite") {
                    let _ = signal_tx.send(ServerFrame::CallSignal {
                        from_uid: to_uid,
                        payload: serde_json::json!({
                            "type": "call_busy",
                            "callId": payload.get("callId"),
                            "reason": "offline"
                        }),
                    }).await;
                }
            }
            ClientFrame::IceCandidate { candidate } => {
                if let Some(peer) = current_peer.as_ref() {
                    match serde_json::from_value::<webrtc::peer_connection::RTCIceCandidateInit>(candidate) {
                        Ok(cand_init) => {
                            tracing::info!(candidate = %cand_init.candidate, "server accepted client ICE candidate");
                            let _ = peer.add_ice_candidate(cand_init).await;
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "could not parse client ICE candidate");
                        }
                    }
                }
            }
            ClientFrame::PublishPrekeys { bundle } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                let bundle_str = bundle.to_string();
                match store.save_prekey_bundle(&user.uid, &bundle_str).await {
                    Ok(()) => {
                        signal_tx.send(ServerFrame::PrekeysPublished).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Err(err) => send_error(&signal_tx, "PREKEY_SAVE_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::GetPrekeyBundle { uid } => {
                match store.get_prekey_bundle(&uid).await {
                    Ok(Some(bundle_str)) => {
                        let bundle: serde_json::Value = serde_json::from_str(&bundle_str).unwrap_or(serde_json::Value::Null);
                        signal_tx.send(ServerFrame::PrekeyBundle { uid, bundle }).await.map_err(|_| anyhow!("signaling writer closed"))?;
                    }
                    Ok(None) => send_error(&signal_tx, "PREKEY_NOT_FOUND", "user has not published prekeys").await?,
                    Err(err) => send_error(&signal_tx, "PREKEY_FETCH_FAILED", &safe_error(&err)).await?,
                }
            }
            ClientFrame::DataFrame { payload } => {
                let Some(user) = current_user.as_ref() else {
                    send_error(&signal_tx, "AUTH_REQUIRED", "login required").await?;
                    continue;
                };
                if let Ok(dc_frame) = serde_json::from_value::<protocol::DataChannelClientFrame>(payload) {
                    crate::webrtc_peer::handle_client_frame(
                        dc_frame,
                        None,
                        Some(&signal_tx),
                        &store,
                        &channels,
                        &live_signaling,
                        &user.uid,
                    ).await;
                }
            }
            ClientFrame::Ping => {
                signal_tx.send(ServerFrame::Pong).await.map_err(|_| anyhow!("signaling writer closed"))?;
            }
        }
    }

    if let Some(peer) = current_peer { let _ = peer.close().await; }
    if let Some(user) = current_user {
        // A superseded socket must not remove the new login's sender/channel.
        let mut connected = live_signaling.write().await;
        if connected.get(&user.uid).is_some_and(|tx| tx.same_channel(&signal_tx)) {
            connected.remove(&user.uid);
        }
        drop(connected);
        let still_online = is_user_online(&channels, &live_signaling, &user.uid).await;
        if !still_online {
            crate::webrtc_peer::broadcast_presence(&store, &channels, &live_signaling, &user.uid, false).await;
        }
    }
    Ok(())
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R, max: usize) -> Result<Option<String>> {
    let mut bytes = Vec::with_capacity(1024);
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if bytes.is_empty() { return Ok(None); }
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let payload_len = newline.map_or(consumed, |index| index);
        anyhow::ensure!(bytes.len() + payload_len <= max, "signaling frame exceeds {max} bytes");
        bytes.extend_from_slice(&available[..payload_len]);
        reader.consume(consumed);
        if newline.is_some() { break; }
    }
    Ok(Some(String::from_utf8(bytes).context("signaling frame is not UTF-8")?))
}

async fn send_auth_ok(tx: &mpsc::Sender<ServerFrame>, user: protocol::UserSummary, token: String) -> Result<()> {
    tx.send(ServerFrame::AuthOk {
        uid: user.uid,
        username: user.username,
        display_name: user.display_name,
        about: user.about,
        token,
    }).await.map_err(|_| anyhow!("signaling writer closed"))
}

async fn send_error(tx: &mpsc::Sender<ServerFrame>, code: &str, message: &str) -> Result<()> {
    tx.send(ServerFrame::Error {
        code: code.to_owned(),
        message: message.chars().take(240).collect(),
    }).await.map_err(|_| anyhow!("signaling writer closed"))
}

fn safe_error<E: std::fmt::Display>(err: &E) -> String {
    // Avoid exposing SQL, filesystem and cryptographic internals to untrusted clients.
    let message = err.to_string();
    if message.contains("username") || message.contains("password") || message.contains("characters") || message.contains("conversation") || message.contains("user not found") {
        message.chars().take(200).collect()
    } else {
        "request could not be completed".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::read_bounded_line;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn bounded_reader_handles_multiple_lines_and_eof() {
        let input = b"one\ntwo\n";
        let mut reader = BufReader::new(&input[..]);
        assert_eq!(read_bounded_line(&mut reader, 8).await.unwrap().as_deref(), Some("one"));
        assert_eq!(read_bounded_line(&mut reader, 8).await.unwrap().as_deref(), Some("two"));
        assert_eq!(read_bounded_line(&mut reader, 8).await.unwrap(), None);
    }

    #[tokio::test]
    async fn bounded_reader_rejects_oversized_frame() {
        let input = b"12345\n";
        let mut reader = BufReader::new(&input[..]);
        assert!(read_bounded_line(&mut reader, 4).await.is_err());
    }

    #[test]
    fn test_candidate_deserialization() {
        let json_val = serde_json::json!({
            "candidate": "candidate:1 1 UDP 2013266431 192.168.1.1 50000 typ host",
            "sdpMid": "0",
            "sdpMLineIndex": 0
        });
        let res = serde_json::from_value::<webrtc::peer_connection::RTCIceCandidateInit>(json_val);
        assert!(res.is_ok(), "Failed to deserialize camelCase candidate: {:?}", res.err());
    }
}
