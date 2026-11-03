//! One Rust WebRTC peer per connected mobile client. Users never P2P-connect to each other.
use crate::{
    db::Store,
    protocol::{DataChannelClientFrame, DataChannelServerFrame, ServerFrame},
};
use anyhow::{Context, Result};
use futures_util::{stream, StreamExt};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use async_trait::async_trait;
use serde_json::json;
use std::{collections::{HashMap, HashSet}, sync::{Arc, LazyLock}};
use tokio::{sync::{mpsc, Semaphore}, time::{sleep, Duration}};
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

// Large forwards run outside the message/receipt polling loop, with a strict
// process-wide bound. The durable outbox retries when all slots are occupied.
static MEDIA_IN_FLIGHT: LazyLock<tokio::sync::Mutex<HashSet<String>>> = LazyLock::new(|| tokio::sync::Mutex::new(HashSet::new()));
static MEDIA_SEND_SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

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
        let signal_tx = self.signal_tx.clone();
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

                        send_initial_presence_via_signal(&db, &channels, &live_signaling, &signal_tx, &uid).await;
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
                                if total == 0 || total > 1024 || index >= total || data.len() > 12 * 1024 || transfer_id.len() > 128 {
                                    send_dc_error(&channel, "BAD_CHUNK", "invalid chunk bounds").await;
                                    continue;
                                }
                                let chunk_key = format!("{uid}:{transfer_id}");
                                let assembled = {
                                    let mut lock = INCOMING_CHUNKS.lock().await;
                                    if lock.len() > 1000 { lock.clear(); }
                                    let entry = lock.entry(chunk_key.clone()).or_insert_with(|| (total, HashMap::new()));
                                    entry.1.insert(index, data);
                                    if entry.1.len() == entry.0 {
                                        let mut full_string = String::new();
                                        for i in 0..entry.0 {
                                            if let Some(c) = entry.1.get(&i) {
                                                full_string.push_str(c);
                                            }
                                        }
                                        lock.remove(&chunk_key);
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

pub async fn route_call_signal(from: &str, to: &str, payload: serde_json::Value, channels: &LiveChannels, live_signaling: &LiveSignaling) {
    use crate::calls::{CALLS, Decision};
    let decision = CALLS.lock().await.decide(from, to, &payload);
    let reason = match decision {
        Decision::Ignore => return,
        Decision::Busy => Some("in_call"),
        Decision::RateLimited => Some("rate_limited"),
        Decision::Forward => {
            let mut sent = false;
            let target = live_signaling.read().await.get(to).cloned();
            if let Some(tx) = target {
                sent = tx.try_send(ServerFrame::CallSignal { from_uid: from.to_owned(), payload: payload.clone() }).is_ok();
            }
            let dc = channels.read().await.get(to).cloned();
            if let Some(dc) = dc {
                let frame = DataChannelServerFrame::CallSignal { from_uid: from.to_owned(), payload: payload.clone() };
                if let Ok(text) = serde_json::to_string(&frame) {
                    sent |= matches!(tokio::time::timeout(Duration::from_secs(2), dc.send_text(&text)).await, Ok(Ok(_)));
                }
            }
            if sent || payload.get("type").and_then(|v| v.as_str()) != Some("call_invite") { return; }
            if let Some(id) = payload.get("callId").and_then(|v| v.as_str()) { CALLS.lock().await.undelivered(id); }
            Some("offline")
        }
    };
    let frame = DataChannelServerFrame::CallSignal { from_uid: to.to_owned(), payload: json!({"type":"call_busy","callId":payload.get("callId"),"reason":reason}) };
    let _ = tokio::time::timeout(Duration::from_secs(2), send_to_user(channels, live_signaling, from, &frame)).await;
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
    if channel.is_none() && matches!(&frame, DataChannelClientFrame::SendMessage { .. }) {
        reply_error(channel, signal_tx, "DATACHANNEL_REQUIRED", "chat messages require WebRTC DataChannel").await;
        return;
    }
    match frame {
        DataChannelClientFrame::CallSignal { to_uid, payload } => {
            route_call_signal(uid, &to_uid, payload, channels, live_signaling).await;
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

            // Authenticate membership and persist before acknowledging. Never trust
            // the client's recipient hint or acknowledge an in-memory-only message.
            let _ = frame_recipient_uid;
            match db.save_ciphertext(&message_id, &conversation_id, uid, &ciphertext, msg_type).await {
                Ok((recipient_uid, _)) => {
                    reply_to_sender(channel, signal_tx, &DataChannelServerFrame::SavedAck {
                        message_id: message_id.clone(),
                    }).await;
                    // The committed outbox provides retries. Forward the already
                    // available envelope immediately instead of querying it back
                    // from the remote database before the first delivery.
                    let frame = DataChannelServerFrame::NewMessage { message: crate::protocol::MessageEnvelope {
                        message_id: message_id.clone(), conversation_id: conversation_id.clone(),
                        sender_uid: uid.to_owned(), ciphertext_b64: ciphertext_b64.clone(),
                        msg_type, created_at: crate::db::now_epoch_string(), status: "SAVED".to_owned(),
                    }};
                    send_to_user(channels, live_signaling, &recipient_uid, &frame).await;
                }
                Err(err) => {
                    tracing::warn!(error = %err, "message persistence failed");
                    reply_error(channel, signal_tx, "SAVE_FAILED", "message not saved; retry with the same message id").await;
                }
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
            crate::calls::CALLS.lock().await.touch(uid);
            reply_to_sender(channel, signal_tx, &DataChannelServerFrame::Pong).await;
        }
        DataChannelClientFrame::PresenceOffline => {
            tracing::info!(user_id = %uid, "client explicitly reported offline");
        }
        DataChannelClientFrame::Chunk { .. } => {}
    }
}

async fn dispatch_channel_text(channel: Arc<dyn DataChannel>, text: String, message_id: &str) {
    if text.len() <= 12 * 1024 {
        send_safe_text(&channel, &text).await;
        return;
    }
    let mut active = MEDIA_IN_FLIGHT.lock().await;
    if active.contains(message_id) { return; }
    let Ok(permit) = MEDIA_SEND_SLOTS.clone().try_acquire_owned() else { return; };
    let message_id = message_id.to_owned();
    active.insert(message_id.clone());
    drop(active);
    tokio::spawn(async move {
        let _permit = permit;
        send_safe_text(&channel, &text).await;
        MEDIA_IN_FLIGHT.lock().await.remove(&message_id);
    });
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
                tokio::task::yield_now().await;
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
        dispatch_channel_text(channel.clone(), text, &item.message.message_id).await;
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
            dispatch_channel_text(receiver.clone(), text, &item.message.message_id).await;
        }
    }
}

pub async fn deliver_all_pending_via_signal(_db: &Store, _signal_tx: &mpsc::Sender<ServerFrame>, _uid: &str) {
    // Chat delivery waits for the authenticated WebRTC DataChannel.
}

pub async fn run_delivery_worker(db: Store, channels: LiveChannels, live_signaling: LiveSignaling) {
    loop {
        let mut recipients: Vec<String> = channels.read().await.keys().cloned().collect();
        recipients.sort();
        // At most four queries and sixteen claims/forwards run concurrently.
        stream::iter(recipients.chunks(100).map(|batch| batch.to_vec()))
            .for_each_concurrent(4, |batch| {
                let db = db.clone(); let channels = channels.clone(); let live_signaling = live_signaling.clone();
                async move {
                    let pending = match db.pending_online_deliveries(&batch).await {
                        Ok(items) => items,
                        Err(err) => { tracing::warn!(error = %err, "outbox batch polling failed"); return; }
                    };
                    stream::iter(pending).for_each_concurrent(4, |item| {
                        let db = db.clone(); let channels = channels.clone(); let live_signaling = live_signaling.clone();
                        async move {
                            if !channels.read().await.contains_key(&item.recipient_uid) { return; }
                            match db.claim_delivery_attempt(&item.message.message_id, &item.recipient_uid).await {
                                Ok(true) => {
                                    let frame = DataChannelServerFrame::NewMessage { message: item.message };
                                    send_to_user(&channels, &live_signaling, &item.recipient_uid, &frame).await;
                                },
                                Ok(false) => {},
                                Err(err) => tracing::warn!(error = %err, "outbox claim failed"),
                            }
                        }
                    }).await;
                }
            }).await;
        sleep(Duration::from_secs(1)).await;
    }
}

pub async fn broadcast_presence(db: &Store, channels: &LiveChannels, live_signaling: &LiveSignaling, changed_uid: &str, online: bool) {
    let contacts = match db.conversation_contacts(changed_uid).await {
        Ok(contacts) => contacts,
        Err(err) => { tracing::warn!(error = %err, "presence contacts unavailable"); return; }
    };
    let frame = DataChannelServerFrame::PresenceUpdate { uid: changed_uid.to_owned(), online };
    stream::iter(contacts).for_each_concurrent(16, |uid| {
        let frame = frame.clone();
        async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), send_to_user(channels, live_signaling, &uid, &frame)).await;
        }
    }).await;
}

pub async fn send_initial_presence_via_signal(
    db: &Store,
    channels: &LiveChannels,
    live_signaling: &LiveSignaling,
    signal_tx: &mpsc::Sender<ServerFrame>,
    current_uid: &str,
) {
    let Ok(contacts) = db.conversation_contacts(current_uid).await else { return; };
    let online: HashSet<String> = {
        let dc = channels.read().await;
        let sig = live_signaling.read().await;
        contacts.into_iter().filter(|uid| dc.contains_key(uid) || sig.contains_key(uid)).collect()
    };
    for uid in online {
        let frame = DataChannelServerFrame::PresenceUpdate { uid, online: true };
        if let Ok(payload) = serde_json::to_value(frame) {
            if signal_tx.try_send(ServerFrame::DataFrame { payload }).is_err() { break; }
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
            if let DataChannelServerFrame::NewMessage { message } = frame {
                dispatch_channel_text(channel, text, &message.message_id).await;
            } else {
                send_safe_text(&channel, &text).await;
            }
            return;
        }
    }

    if matches!(frame, DataChannelServerFrame::NewMessage { .. }) { return; }

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
    ice_urls: Vec<String>,
) -> Result<(Arc<dyn PeerConnection>, String)> {
    let handler = ServerPeerHandler { uid, db, channels, live_signaling, signal_tx };
    let ice_servers = ice_urls.into_iter().map(|url| RTCIceServer { urls: vec![url], ..Default::default() }).collect();
    let config = RTCConfigurationBuilder::default().with_ice_servers(ice_servers).build();
    let peer = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_handler(Arc::new(handler))
        .with_udp_addrs(vec!["0.0.0.0:0"])
        .with_data_channel_send_buffer_limit(256 * 1024)
        .build().await.context("build WebRTC peer")?;
    let offer = RTCSessionDescription::offer(offer_sdp).context("parse client SDP")?;
    peer.set_remote_description(offer).await.context("apply client SDP")?;
    let answer = peer.create_answer(None).await.context("create WebRTC answer")?;
    peer.set_local_description(answer).await.context("apply local SDP")?;
    let local = peer.local_description().await.context("local SDP unavailable")?;
    Ok((Arc::new(peer), local.sdp))
}

