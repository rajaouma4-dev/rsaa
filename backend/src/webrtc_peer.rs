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
use tokio::{sync::{mpsc, Mutex}, time::{sleep, Duration}};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
        RTCConfigurationBuilder, RTCIceServer, RTCPeerConnectionIceEvent,
        RTCSessionDescription,
    },
};

pub type LiveChannels = Arc<Mutex<HashMap<String, Arc<dyn DataChannel>>>>;
pub type LiveSignaling = Arc<Mutex<HashMap<String, mpsc::Sender<ServerFrame>>>>;

static MESSAGE_SENDERS: LazyLock<tokio::sync::Mutex<HashMap<String, String>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::with_capacity(4096)));

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
                        let previous = channels.lock().await.insert(uid.clone(), channel.clone());
                        if let Some(previous) = previous {
                            let _ = previous.close().await;
                        }
                        tracing::info!(user_id = %uid, "client DataChannel opened");
                        broadcast_presence(&db, &channels, &uid, true).await;

                        // Immediately deliver all queued offline messages to this recipient
                        deliver_all_pending(&db, &channel, &uid).await;

                        // Immediately inform this user about all currently connected users
                        let other_online: Vec<String> = {
                            let connected = channels.lock().await;
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
                                        handle_client_frame(inner_frame, &channel, &db, &channels, &live_signaling, &uid).await;
                                    }
                                }
                            }
                            other => {
                                handle_client_frame(other, &channel, &db, &channels, &live_signaling, &uid).await;
                            }
                        }
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
            let mut guard = channels.lock().await;
            let removed = if guard.get(&uid).is_some_and(|existing| Arc::ptr_eq(existing, &channel)) {
                guard.remove(&uid);
                true
            } else {
                false
            };
            drop(guard);
            if removed {
                broadcast_presence(&db, &channels, &uid, false).await;
            }
            tracing::info!(user_id = %uid, "client DataChannel closed");
        });
    }
}

static INCOMING_CHUNKS: LazyLock<tokio::sync::Mutex<HashMap<String, (usize, HashMap<usize, String>)>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

async fn handle_client_frame(
    frame: DataChannelClientFrame,
    channel: &Arc<dyn DataChannel>,
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
                let dc_guard = channels.lock().await;
                if let Some(target_dc) = dc_guard.get(&to_uid) {
                    let s_frame = DataChannelServerFrame::CallSignal {
                        from_uid: from_uid.clone(),
                        payload: payload.clone(),
                    };
                    if let Ok(text) = serde_json::to_string(&s_frame) {
                        send_safe_text(target_dc, &text).await;
                        sent = true;
                    }
                }
            }
            // 2. If not sent via DataChannel, try sending via target's TCP signaling socket
            if !sent {
                let sig_guard = live_signaling.lock().await;
                if let Some(target_tx) = sig_guard.get(&to_uid) {
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
                if let Ok(text) = serde_json::to_string(&s_frame) {
                    send_safe_text(channel, &text).await;
                }
            }
        }
        DataChannelClientFrame::SendMessage {
            message_id,
            conversation_id,
            ciphertext_b64,
            created_at: _,
        } => {
            if ciphertext_b64.is_empty() || ciphertext_b64.len() > 10 * 1024 * 1024 {
                send_dc_error(channel, "INVALID_CIPHERTEXT", "ciphertext envelope is empty or too large").await;
                return;
            }
            let ciphertext = match STANDARD.decode(&ciphertext_b64) {
                Ok(b) if !b.is_empty() => b,
                _ => {
                    send_dc_error(channel, "BAD_CIPHERTEXT", "ciphertext is not valid base64").await;
                    return;
                }
            };

            let version_byte = ciphertext[0];
            let min_version = version_byte & 0x0f;
            let max_version = version_byte >> 4;
            if min_version > 3 || max_version < 3 {
                send_dc_error(
                    channel,
                    "E2EE_NOT_CONFIGURED",
                    "message relay requires a valid Signal Protocol V3 ciphertext envelope",
                ).await;
                return;
            }

            {
                let mut cache = MESSAGE_SENDERS.lock().await;
                if cache.len() > 10_000 { cache.clear(); }
                cache.insert(message_id.clone(), uid.to_string());
            }

            match db.save_ciphertext(&message_id, &conversation_id, uid, &ciphertext).await {
                Ok((recipient_uid, is_new)) => {
                    let saved_ack = DataChannelServerFrame::SavedAck { message_id: message_id.clone() };
                    if let Ok(text) = serde_json::to_string(&saved_ack) {
                        send_safe_text(channel, &text).await;
                    }

                    if is_new {
                        let msg = crate::protocol::MessageEnvelope {
                            message_id: message_id.clone(),
                            conversation_id: conversation_id.clone(),
                            sender_uid: uid.to_string(),
                            ciphertext_b64: ciphertext_b64.clone(),
                            created_at: crate::db::now_epoch_string(),
                            status: "SAVED".to_string(),
                        };
                        let frame = DataChannelServerFrame::NewMessage { message: msg };
                        send_to_user(channels, &recipient_uid, &frame).await;
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "save_ciphertext failed");
                    send_dc_error(channel, "SAVE_FAILED", &err.to_string()).await;
                }
            }
        }
        DataChannelClientFrame::DeliveredAck { message_id } => {
            let cached_sender = {
                let cache = MESSAGE_SENDERS.lock().await;
                cache.get(&message_id).cloned()
            };
            if let Some(sender_uid) = cached_sender {
                let ack = DataChannelServerFrame::DeliveredAck { message_id: message_id.clone() };
                send_to_user(channels, &sender_uid, &ack).await;
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
                        send_to_user(channels, &sender_uid, &ack).await;
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
                send_to_user(channels, &sender_uid, &ack).await;
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
                        send_to_user(channels, &sender_uid, &ack).await;
                    }
                    Ok(None) => {}
                    Err(err) => tracing::warn!(error = %err, "failed to record seen receipt"),
                }
            }
        }
        DataChannelClientFrame::Ping => {
            if let Ok(text) = serde_json::to_string(&DataChannelServerFrame::Pong) {
                let _ = channel.send_text(&text).await;
            }
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
    let Some(receiver) = channels.lock().await.get(recipient_uid).cloned() else { return; };
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

/// Polls only currently connected recipients. The database outbox remains the source of truth;
/// a missed ACK causes capped exponential-backoff retries after the channel reconnects.
pub async fn run_delivery_worker(db: Store, channels: LiveChannels) {
    loop {
        let recipients: Vec<String> = channels.lock().await.keys().cloned().collect();
        for uid in recipients {
            let channel = channels.lock().await.get(&uid).cloned();
            let Some(channel) = channel else { continue; };
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
                let Ok(text) = serde_json::to_string(&frame) else { continue; };
                send_safe_text(&channel, &text).await;
            }
        }
        sleep(Duration::from_secs(1)).await;
    }
}

pub async fn broadcast_presence(_db: &Store, channels: &LiveChannels, changed_uid: &str, online: bool) {
    let frame = DataChannelServerFrame::PresenceUpdate {
        uid: changed_uid.to_owned(),
        online,
    };
    let Ok(text) = serde_json::to_string(&frame) else { return; };
    let recipients: Vec<Arc<dyn DataChannel>> = {
        let connected = channels.lock().await;
        connected.iter().filter(|(uid, _)| *uid != changed_uid).map(|(_, channel)| Arc::clone(channel)).collect()
    };
    for channel in recipients {
        if let Err(err) = channel.send_text(&text).await {
            tracing::debug!(error = %err, "presence update could not be sent");
        }
    }
}

pub async fn send_to_user(channels: &LiveChannels, uid: &str, frame: &DataChannelServerFrame) {
    let Some(channel) = channels.lock().await.get(uid).cloned() else { return; };
    if let Ok(text) = serde_json::to_string(frame) {
        send_safe_text(&channel, &text).await;
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
    ice_urls: Vec<String>,
) -> Result<(Arc<dyn PeerConnection>, String)> {
    let handler = ServerPeerHandler { uid, db, channels, live_signaling, signal_tx };
    // Google STUN only: filter out any non-STUN or TURN URLs.
    let stun_urls: Vec<String> = ice_urls
        .into_iter()
        .filter(|url| url.starts_with("stun:") || url.starts_with("turn:") || url.starts_with("turns:"))
        .collect();
    let effective_urls = if stun_urls.is_empty() {
        vec!["stun:stun.l.google.com:19302".to_string()]
    } else {
        stun_urls
    };
    let turn_user = std::env::var("TURN_USERNAME").unwrap_or_else(|_| "openrelayproject".into());
    let turn_pass = std::env::var("TURN_CREDENTIAL").unwrap_or_else(|_| "openrelayproject".into());
    let ice_servers: Vec<RTCIceServer> = effective_urls
        .into_iter()
        .map(|url| {
            let is_turn = url.starts_with("turn:") || url.starts_with("turns:");
            RTCIceServer {
                urls: vec![url],
                username: if is_turn { turn_user.clone() } else { String::new() },
                credential: if is_turn { turn_pass.clone() } else { String::new() },
                ..Default::default()
            }
        })
        .collect();
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

