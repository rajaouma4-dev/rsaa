//! Opt-in local test using real DTLS/SCTP DataChannels. No emulators or public service.
use super::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use webrtc::{data_channel::{DataChannel, DataChannelEvent}, peer_connection::{PeerConnectionBuilder, PeerConnectionEventHandler, RTCPeerConnectionIceEvent, RTCSessionDescription, RTCIceCandidateInit}};
use tokio::sync::{mpsc, RwLock};

struct Handler(mpsc::UnboundedSender<Value>);

#[tokio::test]
async fn batched_outbox_is_fair_and_claims_are_idempotent() -> Result<()> {
    let users = vec!["a".into(), "b".into(), "c".into(), "d".into()];
    let store = Store::load_test_store(&format!("target/fair-{}.db", uuid::Uuid::new_v4()), &users).await?;
    for (a, b, count) in [("a", "b", 9), ("c", "d", 2)] {
        store.create_or_get_conversation(a, b).await?;
        let conversation = store.get_conversation_id(a, b).await?;
        for i in 0..count { store.save_ciphertext(&format!("message_{a}_{i}"), &conversation, a, &[0x33, 1, 2, 3], Some(1)).await?; }
    }
    let pending = store.pending_online_deliveries(&["b".into()]).await?;
    assert_eq!(pending.len(), 4);
    assert!(pending.iter().all(|m| m.recipient_uid == "b"));
    assert_eq!(store.pending_online_deliveries(&["b".into(), "d".into()]).await?.len(), 6);
    let claimed = futures_util::future::join_all((0..10).map(|_| store.claim_delivery_attempt("message_a_0", "b"))).await;
    assert_eq!(claimed.into_iter().filter(|r| matches!(r, Ok(true))).count(), 1);
    store.mark_delivered("message_a_1", "b").await?;
    assert!(store.pending_online_deliveries(&["b".into()]).await?.iter().all(|m| m.message.message_id != "message_a_1"));
    Ok(())
}
#[async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(candidate) = event.candidate.to_json() {
            let _ = self.0.send(serde_json::to_value(candidate).unwrap());
        }
    }
}
struct Client { pc: Arc<dyn PeerConnection>, server: Arc<dyn PeerConnection>, dc: Arc<dyn DataChannel>, frames: mpsc::UnboundedReceiver<Value> }

async fn connect(uid: String, store: Store, channels: webrtc_peer::LiveChannels, signals: webrtc_peer::LiveSignaling) -> Result<Client> {
    let (ice_tx, mut ice_rx) = mpsc::unbounded_channel();
    let pc: Arc<dyn PeerConnection> = Arc::new(PeerConnectionBuilder::new()
        .with_handler(Arc::new(Handler(ice_tx))).with_udp_addrs(vec!["0.0.0.0:0"]).build().await?);
    let dc = pc.create_data_channel("nexa", None).await?;
    let offer = pc.create_offer(None).await?;
    pc.set_local_description(offer).await?;
    let (signal_tx, mut signal_rx) = mpsc::channel(256);
    let (server, answer) = webrtc_peer::build_answerer(uid, store, channels, signals, signal_tx,
        pc.local_description().await.unwrap().sdp, Vec::new()).await?;
    pc.set_remote_description(RTCSessionDescription::answer(answer)?).await?;
    let server_ice = server.clone();
    tokio::spawn(async move { while let Some(candidate) = ice_rx.recv().await {
        if let Ok(candidate) = serde_json::from_value::<RTCIceCandidateInit>(candidate) { let _ = server_ice.add_ice_candidate(candidate).await; }
    }});
    let client_ice = pc.clone();
    tokio::spawn(async move { while let Some(frame) = signal_rx.recv().await {
        if let ServerFrame::IceCandidate { candidate } = frame {
            if let Ok(candidate) = serde_json::from_value(candidate) { let _ = client_ice.add_ice_candidate(candidate).await; }
        }
    }});
    let (tx, rx) = mpsc::unbounded_channel();
    let polling = dc.clone();
    tokio::spawn(async move { while let Some(event) = polling.poll().await {
        match event {
            DataChannelEvent::OnOpen => { let _ = tx.send(json!({"type":"open"})); },
            DataChannelEvent::OnMessage(message) => {
                if let Ok(frame) = serde_json::from_slice::<Value>(&message.data) { let _ = tx.send(frame); }
            },
            DataChannelEvent::OnClose => break,
            _ => {},
        }
    }});
    let mut client = Client { pc, server, dc, frames: rx };
    tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(frame) = client.frames.recv().await { if frame["type"] == "open" { return; } }
        panic!("DataChannel closed before opening");
    }).await.context("DataChannel open deadline")?;
    Ok(client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Run via mobile/test-multi-user.cjs; creates bounded local WebRTC test clients"]
async fn multi_user_datachannels() -> Result<()> {
    let _ = tracing_subscriber::fmt().with_env_filter("nexa_messenger_server=warn").with_test_writer().try_init();
    let fixture_path = env::var("NEXA_LOAD_FIXTURE")?;
    let output_path = env::var("NEXA_LOAD_OUTPUT")?;
    let fixture: Value = serde_json::from_slice(&std::fs::read(&fixture_path)?)?;
    let users: Vec<String> = serde_json::from_value(fixture["users"].clone())?;
    anyhow::ensure!((2..=100).contains(&users.len()), "test is capped at 100 clients");
    let started = Instant::now();
    let db_path = format!("target/load-{}.db", uuid::Uuid::new_v4());
    let store = Store::load_test_store(&db_path, &users).await?;
    let channels = Arc::new(RwLock::new(HashMap::new()));
    let signals = Arc::new(RwLock::new(HashMap::new()));
    let worker = tokio::spawn(run_delivery_worker(store.clone(), channels.clone(), signals.clone()));
    let mut conversations = HashMap::new();
    for pair in users.chunks(2) {
        store.create_or_get_conversation(&pair[0], &pair[1]).await?;
        let id = store.get_conversation_id(&pair[0], &pair[1]).await?;
        conversations.insert(pair[0].clone(), id.clone()); conversations.insert(pair[1].clone(), id);
    }
    let mut clients = Vec::new();
    for batch in users.chunks(4) {
        let results = futures_util::future::join_all(batch.iter().map(|uid| connect(uid.clone(), store.clone(), channels.clone(), signals.clone()))).await;
        for result in results { clients.push(result?); }
        println!("local WebRTC clients open: {}", clients.len());
    }
    tokio::time::timeout(Duration::from_secs(10), async { while channels.read().await.len() != users.len() { tokio::time::sleep(Duration::from_millis(20)).await; } }).await?;
    let connect_ms = started.elapsed().as_millis();
    let send_started = Instant::now();
    let outbound = fixture["messages"].as_array().context("messages missing")?;
    for message in outbound {
        let sender = message["sender"].as_u64().context("sender index")? as usize;
        let mut envelope = message["envelope"].clone();
        envelope["conversation_id"] = json!(conversations[&users[sender]]);
        clients[sender].dc.send_text(&envelope.to_string()).await?;
    }
    // Retry the first envelope with the same ID; it must not create another row.
    let mut duplicate = outbound[0]["envelope"].clone();
    duplicate["conversation_id"] = json!(conversations[&users[0]]);
    clients[0].dc.send_text(&duplicate.to_string()).await?;
    let mut received = Vec::new();
    let mut saved = std::collections::HashSet::new();
    let mut unique = std::collections::HashSet::new();
    tokio::time::timeout(Duration::from_secs(60), async {
        while saved.len() < outbound.len() || unique.len() < outbound.len() {
            for (index, client) in clients.iter_mut().enumerate() {
                while let Ok(frame) = client.frames.try_recv() {
                    match frame["type"].as_str() {
                        Some("error") => panic!("server rejected test envelope: {}", frame),
                        Some("saved_ack") => { saved.insert(frame["message_id"].as_str().unwrap().to_owned()); },
                        Some("new_message") => {
                            let message = &frame["message"];
                            let id = message["message_id"].as_str().unwrap();
                            if unique.insert(id.to_owned()) {
                                received.push(json!({"recipient":index,"message":message,"arrival_ms":send_started.elapsed().as_millis()}));
                            }
                            client.dc.send_text(&json!({"type":"delivered_ack","message_id":id}).to_string()).await.unwrap();
                        },
                        _ => {},
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.context("message delivery deadline")?;
    let chat_ms = send_started.elapsed().as_millis();
    // Persist a real ciphertext while its recipient is disconnected, then resume.
    clients[0].pc.close().await?; clients[0].server.close().await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        while channels.read().await.contains_key(&users[0]) { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await?;
    let mut offline = fixture["offline"]["envelope"].clone();
    let offline_id = offline["message_id"].as_str().unwrap().to_owned();
    offline["conversation_id"] = json!(conversations[&users[1]]);
    clients[1].dc.send_text(&offline.to_string()).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(frame) = clients[1].frames.recv().await {
            if frame["type"] == "saved_ack" && frame["message_id"] == offline_id {
                saved.insert(offline_id.clone()); return;
            }
            assert_ne!(frame["type"], "error", "offline message rejected: {frame}");
        }
        panic!("sender channel closed");
    }).await?;
    assert!(store.pending_deliveries(&users[0], 100).await?.iter().any(|m| m.message.message_id == offline_id));
    clients[0] = connect(users[0].clone(), store.clone(), channels.clone(), signals.clone()).await?;
    clients[0].dc.send_text("{\"type\":\"ping\"}").await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut pong = false;
        while let Some(frame) = clients[0].frames.recv().await {
            if frame["type"] == "pong" { pong = true; }
            if frame["type"] == "new_message" && frame["message"]["message_id"] == offline_id {
                if unique.insert(offline_id.clone()) {
                    received.push(json!({"recipient":0,"message":frame["message"],"arrival_ms":send_started.elapsed().as_millis()}));
                }
                clients[0].dc.send_text(&json!({"type":"delivered_ack","message_id":offline_id}).to_string()).await.unwrap();
            }
            if pong && unique.contains(&offline_id) { return; }
        }
        panic!("reconnected channel closed");
    }).await?;
    std::fs::write(output_path, serde_json::to_vec_pretty(&json!({"users":users.len(),"messages":outbound.len()+1,"saved":saved.len(),"unique_received":unique.len(),"connect_ms":connect_ms,"chat_ms":chat_ms,"reconnected":true,"received":received}))?)?;
    for client in clients { let _ = client.pc.close().await; let _ = client.server.close().await; }
    worker.abort();
    println!("local DataChannel load: {} users, {} messages, all saved/received, reconnect passed", users.len(), outbound.len());
    Ok(())
}
