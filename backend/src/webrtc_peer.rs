//! One Rust WebRTC peer per connected mobile client. Users never P2P-connect to each other.
use crate::{
    db::Store,
    protocol::{DataChannelClientFrame, DataChannelServerFrame, ServerFrame},
};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use async_trait::async_trait;
use serde_json::json;
use std::{collections::HashMap, sync::{Arc, LazyLock}};
use tokio::{sync::mpsc, time::{sleep, Duration}};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
        RTCConfigurationBuilder, RTCIceServer, RTCPeerConnectionIceEvent,
        RTCSessionDescription,
    },
};

pub type LiveChannels = Arc<tokio::sync::RwLock<HashMap<String, Arc<dyn DataChannel>>>>;
pub type LiveSignaling = Arc<tokio::sync::RwLock<HashMap<String, mpsc::Sender<ServerFrame>>>>;

static MESSAGE_SENDERS: LazyLock<tokio::sync::Mutex<HashMap<String, String>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::with_capacity(8192)));

static CONVERSATION_RECIPIENTS: LazyLock<tokio::sync::RwLock<HashMap<(String, String), String>>> =
    LazyLock::new(|| tokio::sync::RwLock::new(HashMap::with_capacity(8192)));

#[derive(Clone)]
pub struct ServerPeerHandler {
    pub uid: String,
    pub db: Store,
    pub channels: LiveChannels,
    pub live_signaling: LiveSignaling,
    pub signal_tx: mpsc::Sender<ServerFrame>,
}

#[async_trait]
impl PeerConnectionEventHandler for ServerPeerHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(candidate) = event.candidate.to_json() {
            let candidate_str = &candidate.candidate;
            let cand_type = if candidate_str.contains("typ srflx") {
                "srflx (Google STUN)"
            } else if candidate_str.contains("typ host") {
                "host"
            } else if candidate_str.contains("typ relay") {
                "relay"
            } else {
                "unknown"
            };
            tracing::info!(user_id = %self.uid, candidate_type = %cand_type, "server gathered ICE candidate");
            let _ = self.signal_tx.send(ServerFrame::IceCandidate {
                candidate: serde_json::to_value(candidate).unwrap_or(json!({})),
            }).await;
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let uid = self.uid.clone();
        let db = self.db.clone();
        let channels = self.channels.clone();
        let live_signaling = self.live_signaling.clone();
        tokio::spawn(async move {
            loop {
                let poll_result = tokio::time::timeout(std::time::Duration::from_secs(90), channel.poll()).await;
                let event = match poll_result {
                    Ok(Some(ev)) => ev,
                    Ok(None) => break,
                    Err(_) => {
                        tracing::info!(user_id = %uid, "client DataChannel inactive for 90s, closing session");
                        break;
                    }
                };
                match event {
                    DataChannelEvent::OnOpen => {
                        let previous = channels.write().await.insert(uid.clone(), channel.clone());
                        if let Some(previous) = previous {
                            let _ = previous.close().await;
                        }
                        tracing::info!(user_id = %uid, "client DataChannel opened");
                        broadcast_presence(&db, &channels, &live_signaling, &uid, true).await;

                        // Immediately deliver all queued offline messages to this recipient
                        deliver_all_pending(&db, &channel, &uid).await;

                        // Immediately inform this user about all currently connected users
                        let other_online: Vec<String> = {
                            let connected = channels.read().await;
                            connected.keys().filter(|other_uid| *other_uid != &uid).cloned().collect()
                        };
                        for contact_uid in other_online {
                            let frame = DataChannelServerFrame::PresenceUpdate {
                                uid: contact_uid,
                                online: true,
                            };
                            if let Ok(text) = serde_json::to_string(&frame) {
                                let _ = channel.send_text(&text).await;
                            }
                        }
                    }
                    DataChannelEvent::OnMessage(message) => {
                        let parsed = serde_json::from_slice::<DataChannelClientFrame>(&message.data);
                        let Ok(frame) = parsed else {
                            send_dc_error(&channel, "BAD_FRAME", "invalid data-channel frame").await;
                            continue;
                        };
                        match frame {
                            DataChannelClientFrame::Chunk {
                                transfer_id,
                                index,
                                total,
                                data,
                            } => {
                                let assembled = {
                                    let mut lock = INCOMING_CHUNKS.lock().await;
                                    if lock.len() > 1000 { lock.clear(); }
                                    let entry = lock.entry(transfer_id.clone()).or_insert_with(|| (total, HashMap::new()));
                                    entry.1.insert(index, data);
                                    if entry.1.len() == entry.0 {
                                        let mut full_string = String::new();
                                        for i in 0..entry.0 {
                                            if let Some(c) = entry.1.get(&i) {
                                                full_string.push_str(c);
                                            }
                                        }
                                        lock.remove(&transfer_id);
                                        Some(full_string)
                                    } else {
                                        None
                                    }
                                };
                                if let Some(full_str) = assembled {
                                    if let Ok(inner_frame) = serde_json::from_str::<DataChannelClientFrame>(&full_str) {
                                        handle_client_frame(inner_frame, Some(&channel), None, &db, &channels, &live_signaling, &uid).await;
                                    }
                                }
                            }
                            other => {
                                handle_client_frame(other, Some(&channel), None, &db, &channels, &live_signaling, &uid).await;
                            }
                        }
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
            let mut guard = channels.write().await;
            let removed = if guard.get(&uid).is_some_and(|existing| Arc::ptr_eq(existing, &channel)) {
                guard.remove(&uid);
                true
            } else {
                false
            };
            drop(guard);
            if removed {
                let still_online = live_signaling.read().await.contains_key(&uid);
                if !still_online {
                    broadcast_presence(&db, &channels, &live_signaling, &uid, false).await;
                }
            }
            tracing::info!(user_id = %uid, "client DataChannel closed");
        });
    }
}

static INCOMING_CHUNKS: LazyLock<tokio::sync::Mutex<HashMap<String, (usize, HashMap<usize, String>)>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

async fn reply_to_sender(
    channel: Option<&Arc<dyn DataChannel>>,
    signal_tx: Option<&mpsc::Sender<ServerFrame>>,
    frame: &DataChannelServerFrame,
) {
    if let Some(ch) = channel {
        if let Ok(text) = serde_json::to_string(frame) {
            send_safe_text(ch, &text).await;
            return;
        }
    }
    if let Some(tx) = signal_tx {
        if let Ok(payload) = serde_json::to_value(frame) {
            let _ = tx.send(ServerFrame::DataFrame { payload }).await;
        }
    }
}

async fn reply_error(
    channel: Option<&Arc<dyn DataChannel>>,
    signal_tx: Option<&mpsc::Sender<ServerFrame>>,
    code: &str,
    message: &str,
) {
    let frame = DataChannelServerFrame::Error {
        code: code.to_owned(),
        message: message.chars().take(240).collect(),
    };
    reply_to_sender(channel, signal_tx, &frame).await;
}

pub async fn handle_client_frame(
    frame: DataChannelClientFrame,
    channel: Option<&Arc<dyn DataChannel>>,
    signal_tx: Option<&mpsc::Sender<ServerFrame>>,
    db: &Store,
    channels: &LiveChannels,
    live_signaling: &LiveSignaling,
    uid: &str,
) {
    match frame {
        DataChannelClientFrame::CallSignal { to_uid, payload } => {
            let from_uid = uid.to_string();
            let mut sent = false;
            // 1. Try sending via target's DataChannel
            {
                let target_dc = { channels.read().await.get(&to_uid).cloned() };
                if let Some(target_dc) = target_dc {
                    let s_frame = DataChannelServerFrame::CallSignal {
                        from_uid: from_uid.clone(),
                        payload: payload.clone(),
                    };
                    if let Ok(text) = serde_json::to_string(&s_frame) {
                        send_safe_text(&target_dc, &text).await;
                        sent = true;
                    }
                }
            }
            // 2. If not sent via DataChannel, try sending via target's signaling socket
            if !sent {
                let target_tx = { live_signaling.read().await.get(&to_uid).cloned() };
                if let Some(target_tx) = target_tx {
                    let _ = target_tx.send(ServerFrame::CallSignal {
                        from_uid: from_uid.clone(),
                        payload: payload.clone(),
                    }).await;
                    sent = true;
                }
            }
            if !sent && payload.get("type").and_then(|t| t.as_str()) == Some("call_invite") {
                let s_frame = DataChannelServerFrame::CallSignal {
                    from_uid: to_uid.clone(),
                    payload: serde_json::json!({
                        "type": "call_busy",
                        "callId": payload.get("callId"),
                        "reason": "offline"
                    }),
                };
                reply_to_sender(channel, signal_tx, &s_frame).await;
            }
        }
        DataChannelClientFrame::SendMessage {
            message_id,
            conversation_id,
            recipient_uid: frame_recipient_uid,
            ciphertext_b64,
            msg_type,
            created_at: _,
        } => {
            if ciphertext_b64.is_empty() || ciphertext_b64.len() > 10 * 1024 * 1024 {
                reply_error(channel, signal_tx, "INVALID_CIPHERTEXT", "ciphertext envelope is empty or too large").await;
                return;
            }
            let ciphertext = match STANDARD.decode(&ciphertext_b64) {
                Ok(b) if !b.is_empty() => b,
                _ => {
                    reply_error(channel, signal_tx, "BAD_CIPHERTEXT", "ciphertext is not valid base64").await;
                    return;
                }
            };

            let version_byte = ciphertext[0];
            let min_version = version_byte & 0x0f;
            let max_version = version_byte >> 4;
            if min_version > 3 || max_version < 3 {
                reply_error(
                    channel,
                    signal_tx,
                    "E2EE_NOT_CONFIGURED",
                    "message relay requires a valid Signal Protocol V3 ciphertext envelope",
                ).await;
                return;
            }

            {
                let mut cache = MESSAGE_SENDERS.lock().await;
                if cache.len() > 20_000 { cache.clear(); }
                cache.insert(message_id.clone(), uid.to_string());
            }

            // ZERO-DELAY REAL-TIME FORWARDING:
            // Determine recipient UID from frame or fast in-memory routing cache without blocking on DB
            let recipient_uid = if let Some(r) = frame_recipient_uid {
                let mut cache = CONVERSATION_RECIPIENTS.write().await;
                if cache.len() > 20_000 { cache.clear(); }
                cache.insert((conversation_id.clone(), uid.to_string()), r.clone());
                Some(r)
            } else {
                let cached = {
                    let cache = CONVERSATION_RECIPIENTS.read().await;
                    cache.get(&(conversation_id.clone(), uid.to_string())).cloned()
                };
                if let Some(r) = cached {
                    Some(r)
                } else {
                    match db.get_conversation_recipient(&conversation_id, uid).await {
                        Ok(r) => {
                            let mut cache = CONVERSATION_RECIPIENTS.write().await;
                            cache.insert((conversation_id.clone(), uid.to_string()), r.clone());
                            Some(r)
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "could not determine recipient");
                            None
                        }
                    }
                }
            };

            if let Some(target_uid) = recipient_uid {
                // 1. Instantly acknowledge sender (< 0.1ms)
                let saved_ack = DataChannelServerFrame::SavedAck { message_id: message_id.clone() };
                reply_to_sender(channel, signal_tx, &saved_ack).await;

                // 2. Instantly forward message to recipient in memory via WebRTC DataChannel / WebSocket (< 0.1ms)
                let msg = crate::protocol::MessageEnvelope {
                    message_id: message_id.clone(),
                    conversation_id: conversation_id.clone(),
                    sender_uid: uid.to_string(),
                    ciphertext_b64: ciphertext_b64.clone(),
                    msg_type,
                    created_at: crate::db::now_epoch_string(),
                    status: "SAVED".to_string(),
                };
                let frame = DataChannelServerFrame::NewMessage { message: msg };
                send_to_user(channels, live_signaling, &target_uid, &frame).await;

                // 3. Persist to database asynchronously in the background
                let db_clone = db.clone();
                let m_id = message_id.clone();
                let c_id = conversation_id.clone();
                let s_uid = uid.to_string();
                let r_uid = target_uid;
                let ct = ciphertext;
                tokio::spawn(async move {
                    if let Err(err) = db_clone.save_ciphertext_direct(&m_id, &c_id, &s_uid, &r_uid, &ct, msg_type).await {
                        tracing::warn!(error = %err, "async save_ciphertext_direct failed");
                    }
                });
            } else {
                reply_error(channel, signal_tx, "RECIPIENT_NOT_FOUND", "conversation recipient could not be found").await;
            }
        }
        DataChannelClientFrame::SessionRepair { peer_uid } => {
            let frame = DataChannelServerFrame::SessionRepair { from_uid: uid.to_string() };
            send_to_user(channels, live_signaling, &peer_uid, &frame).await;
        }
        DataChannelClientFrame::DeliveredAck { message_id } => {
            let cached_sender = {
                let cache = MESSAGE_SENDERS.lock().await;
                cache.get(&message_id).cloned()
            };
            if let Some(sender_uid) = cached_sender {
                let ack = DataChannelServerFrame::DeliveredAck { message_id: message_id.clone() };
                send_to_user(channels, live_signaling, &sender_uid, &ack).await;
                let db_clone = db.clone();
                let r_uid = uid.to_string();
                let m_id = message_id.clone();
                tokio::spawn(async move {
                    let _ = db_clone.mark_delivered(&m_id, &r_uid).await;
                });
            } else {
                match db.mark_delivered(&message_id, uid).await {
                    Ok(Some(sender_uid)) => {
                        let ack = DataChannelServerFrame::DeliveredAck { message_id };
                        send_to_user(channels, live_signaling, &sender_uid, &ack).await;
                    }
                    Ok(None) => {}
                    Err(err) => tracing::warn!(error = %err, "failed to record delivered receipt"),
                }
            }
        }
        DataChannelClientFrame::SeenAck { message_id } => {
            let cached_sender = {
                let cache = MESSAGE_SENDERS.lock().await;
                cache.get(&message_id).cloned()
            };
            if let Some(sender_uid) = cached_sender {
                let ack = DataChannelServerFrame::SeenAck { message_id: message_id.clone() };
                send_to_user(channels, live_signaling, &sender_uid, &ack).await;
                let db_clone = db.clone();
                let r_uid = uid.to_string();
                let m_id = message_id.clone();
                tokio::spawn(async move {
                    let _ = db_clone.mark_seen(&m_id, &r_uid).await;
                });
            } else {
                match db.mark_seen(&message_id, uid).await {
                    Ok(Some(sender_uid)) => {
                        let ack = DataChannelServerFrame::SeenAck { message_id };
                        send_to_user(channels, live_signaling, &sender_uid, &ack).await;
                    }
                    Ok(None) => {}
                    Err(err) => tracing::warn!(error = %err, "failed to record seen receipt"),
                }
            }
        }
        DataChannelClientFrame::Ping => {
            reply_to_sender(channel, signal_tx, &DataChannelServerFrame::Pong).await;
        }
        DataChannelClientFrame::PresenceOffline => {
            tracing::info!(user_id = %uid, "client explicitly reported offline");
        }
        DataChannelClientFrame::Chunk { .. } => {}
    }
}

pub async fn send_safe_text(channel: &Arc<dyn DataChannel>, text: &str) {
    const CHUNK_SIZE: usize = 12 * 1024;
    if text.len() <= CHUNK_SIZE {
        let _ = channel.send_text(text).await;
    } else {
        let transfer_id = format!("srv_{}", uuid::Uuid::new_v4().simple());
        let total = (text.len() + CHUNK_SIZE - 1) / CHUNK_SIZE;
        for i in 0..total {
            let start = i * CHUNK_SIZE;
            let end = (start + CHUNK_SIZE).min(text.len());
            let chunk_str = &text[start..end];
            let frame = DataChannelServerFrame::Chunk {
                transfer_id: transfer_id.clone(),
                index: i,
                total,
                data: chunk_str.to_string(),
            };
            if let Ok(msg) = serde_json::to_string(&frame) {
                if channel.send_text(&msg).await.is_err() { break; }
                tokio::time::sleep(tokio::time::Duration::from_millis(2)).await;
            }
        }
    }
}

pub async fn deliver_all_pending(db: &Store, channel: &Arc<dyn DataChannel>, uid: &str) {
    let pending = match db.pending_deliveries(uid, 100).await {
        Ok(items) => items,
        Err(err) => {
            tracing::warn!(user_id = %uid, error = %err, "could not query pending deliveries on connect");
            return;
        }
    };
    for item in pending {
        let claimed = match db.claim_delivery_attempt(&item.message.message_id, uid).await {
            Ok(value) => value,
            Err(_) => false,
        };
        if !claimed { continue; }
        let frame = DataChannelServerFrame::NewMessage { message: item.message.clone() };
        let Ok(text) = serde_json::to_string(&frame) else { continue; };
        send_safe_text(channel, &text).await;
    }
}

async fn deliver_one(db: &Store, channels: &LiveChannels, recipient_uid: &str, message_id: &str) {
    let Some(receiver) = channels.read().await.get(recipient_uid).cloned() else { return; };
    let pending = match db.pending_deliveries(recipient_uid, 100).await {
        Ok(items) => items,
        Err(err) => { tracing::warn!(error = %err, "could not load pending deliveries"); return; }
    };
    for item in pending.into_iter().filter(|item| item.message.message_id == message_id) {
        let claimed = match db.claim_delivery_attempt(message_id, recipient_uid).await {
            Ok(value) => value,
            Err(err) => { tracing::warn!(error = %err, "could not claim outbox event"); false }
        };
        if !claimed { continue; }
        let frame = DataChannelServerFrame::NewMessage { message: item.message.clone() };
        if let Ok(text) = serde_json::to_string(&frame) {
            send_safe_text(&receiver, &text).await;
        }
    }
}

pub async fn deliver_all_pending_via_signal(db: &Store, signal_tx: &mpsc::Sender<ServerFrame>, uid: &str) {
    let pending = match db.pending_deliveries(uid, 100).await {
        Ok(items) => items,
        Err(err) => {
            tracing::warn!(user_id = %uid, error = %err, "could not query pending deliveries on signal connect");
            return;
        }
    };
    for item in pending {
        let claimed = match db.claim_delivery_attempt(&item.message.message_id, uid).await {
            Ok(value) => value,
            Err(_) => false,
        };
        if !claimed { continue; }
        let frame = DataChannelServerFrame::NewMessage { message: item.message.clone() };
        if let Ok(payload) = serde_json::to_value(&frame) {
            let _ = signal_tx.send(ServerFrame::DataFrame { payload }).await;
        }
    }
}

pub async fn run_delivery_worker(db: Store, channels: LiveChannels, live_signaling: LiveSignaling) {
    loop {
        let mut recipients: std::collections::HashSet<String> = {
            channels.read().await.keys().cloned().collect()
        };
        {
            let sig = live_signaling.read().await;
            recipients.extend(sig.keys().cloned());
        }
        for uid in recipients {
            let pending = match db.pending_deliveries(&uid, 100).await {
                Ok(items) => items,
                Err(err) => {
                    tracing::warn!(user_id = %uid, error = %err, "outbox polling failed");
                    continue;
                }
            };
            for item in pending {
                let claimed = match db.claim_delivery_attempt(&item.message.message_id, &uid).await {
                    Ok(value) => value,
                    Err(err) => { tracing::warn!(message_id = %item.message.message_id, error = %err, "outbox claim failed"); false }
                };
                if !claimed { continue; }
                let frame = DataChannelServerFrame::NewMessage { message: item.message.clone() };
                send_to_user(&channels, &live_signaling, &uid, &frame).await;
            }
        }
        sleep(Duration::from_secs(1)).await;
    }
}

pub async fn broadcast_presence(_db: &Store, channels: &LiveChannels, live_signaling: &LiveSignaling, changed_uid: &str, online: bool) {
    let frame = DataChannelServerFrame::PresenceUpdate {
        uid: changed_uid.to_owned(),
        online,
    };
    let Ok(text) = serde_json::to_string(&frame) else { return; };
    let Ok(payload) = serde_json::to_value(&frame) else { return; };

    // 1. Send to WebRTC DataChannel peers
    let dc_recipients: Vec<Arc<dyn DataChannel>> = {
        let connected = channels.read().await;
        connected.iter().filter(|(uid, _)| *uid != changed_uid).map(|(_, channel)| Arc::clone(channel)).collect()
    };
    for channel in dc_recipients {
        if let Err(err) = channel.send_text(&text).await {
            tracing::debug!(error = %err, "presence update could not be sent to DataChannel");
        }
    }

    // 2. Send to WebSocket signaling peers
    let sig_recipients: Vec<mpsc::Sender<ServerFrame>> = {
        let sig = live_signaling.read().await;
        sig.iter().filter(|(uid, _)| *uid != changed_uid).map(|(_, tx)| tx.clone()).collect()
    };
    for tx in sig_recipients {
        let _ = tx.send(ServerFrame::DataFrame { payload: payload.clone() }).await;
    }
}

pub async fn send_initial_presence_via_signal(
    channels: &LiveChannels,
    live_signaling: &LiveSignaling,
    signal_tx: &mpsc::Sender<ServerFrame>,
    current_uid: &str,
) {
    let mut online_uids: std::collections::HashSet<String> = {
        channels.read().await.keys().cloned().collect()
    };
    {
        let sig = live_signaling.read().await;
        online_uids.extend(sig.keys().cloned());
    }
    online_uids.remove(current_uid);

    for other_uid in online_uids {
        let frame = DataChannelServerFrame::PresenceUpdate {
            uid: other_uid,
            online: true,
        };
        if let Ok(payload) = serde_json::to_value(&frame) {
            let _ = signal_tx.send(ServerFrame::DataFrame { payload }).await;
        }
    }
}

pub async fn send_to_user(
    channels: &LiveChannels,
    live_signaling: &LiveSignaling,
    uid: &str,
    frame: &DataChannelServerFrame,
) {
    // 1. Prefer active WebRTC DataChannel
    let dc = { channels.read().await.get(uid).cloned() };
    if let Some(channel) = dc {
        if let Ok(text) = serde_json::to_string(frame) {
            send_safe_text(&channel, &text).await;
            return;
        }
    }

    // 2. Fall back to active WebSocket signaling connection
    let sig = { live_signaling.read().await.get(uid).cloned() };
    if let Some(tx) = sig {
        if let Ok(payload) = serde_json::to_value(frame) {
            let _ = tx.send(ServerFrame::DataFrame { payload }).await;
        }
    }
}

async fn send_dc_error(channel: &Arc<dyn DataChannel>, code: &str, message: &str) {
    let frame = DataChannelServerFrame::Error { code: code.to_owned(), message: message.chars().take(240).collect() };
    if let Ok(text) = serde_json::to_string(&frame) { let _ = channel.send_text(&text).await; }
}

pub async fn build_answerer(
    uid: String,
    db: Store,
    channels: LiveChannels,
    live_signaling: LiveSignaling,
    signal_tx: mpsc::Sender<ServerFrame>,
    offer_sdp: String,
    _ice_urls: Vec<String>,
) -> Result<(Arc<dyn PeerConnection>, String)> {
    let handler = ServerPeerHandler { uid, db, channels, live_signaling, signal_tx };
    let ice_servers = vec![
        RTCIceServer {
            urls: vec![
                "stun:stun.l.google.com:19302".to_string(),
                "stun:stun1.l.google.com:19302".to_string(),
            ],
            ..Default::default()
        },
    ];
    let config = RTCConfigurationBuilder::default().with_ice_servers(ice_servers).build();
    let peer = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_handler(Arc::new(handler))
        .with_udp_addrs(vec!["0.0.0.0:0"])
        .with_data_channel_send_buffer_limit(256 * 1024)
        .build().await.context("build WebRTC peer")?;
    let offer = RTCSessionDescription::offer(offer_sdp)?;
    peer.set_remote_description(offer).await?;
    let answer = peer.create_answer(None).await?;
    peer.set_local_description(answer).await?;
    let local = peer.local_description().await.context("local SDP unavailable")?;
    Ok((Arc::new(peer), local.sdp))
}

