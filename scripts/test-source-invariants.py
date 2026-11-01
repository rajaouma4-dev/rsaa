#!/usr/bin/env python3
"""Static safety/regression checks for invariants that cannot be exercised offline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
read = lambda p: (ROOT / p).read_text(encoding="utf-8")

main = read("backend/src/main.rs")
peer = read("backend/src/webrtc_peer.rs")
protocol = read("backend/src/protocol.rs")
mobile_app = read("mobile/App.tsx")
signaling = read("mobile/src/services/signaling.ts")
config = read("mobile/src/config.ts")
session_store = read("mobile/src/services/session.ts")
rtc_client = read("mobile/src/services/rtc.ts")

assert "let mut session_expired = false;" in main
assert "store.authenticate(&token).await" in main
assert "if session_expired" in main and "continue;" in main.split("if session_expired", 1)[1].split("match frame", 1)[0]
assert "contacts.contains(&item.uid) && connected.contains_key(&item.uid)" in main
assert "DataChannelServerFrame::NewConversation" in main
assert "pub async fn send_to_user" in peer
assert "E2EE_NOT_CONFIGURED" in peer
assert "db.save_ciphertext" not in peer, "unverified custom clients must not bypass the E2EE gate"
assert "Secure messaging not enabled" in mobile_app and "Signal Protocol E2EE" in mobile_app
assert "NewConversation { conversation_id: String, user: UserSummary }" in protocol
assert "TLS_CERT_SHA256_PINS" in signaling and "fingerprint256" in signaling
assert "TcpSocket.connectTLS(" in signaling and "TcpSocket.createConnection(" not in signaling
assert "getPeerCertificate" in signaling
assert "import {C} from './src/theme'" in mobile_app
assert "saveLiveSession" in mobile_app and "type: 'resume'" in mobile_app
assert "react-native-keychain" in session_store and "AsyncStorage.setItem(DEMO_KEY" in session_store
assert "ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY" in session_store
assert "sendEncryptedEnvelope" in rtc_client and "Only an E2EE ciphertext envelope can be sent" in rtc_client
assert "heartbeatTimer" in signaling and '{"type":"ping"}' in signaling
assert "MAX_SIGNAL_FRAME_BYTES" in signaling and "this.close();" in signaling
assert "DEMO_MODE: true" in config

for path in ["backend/.env", "backend/certs/server.key", "backend/certs/server.crt", "mobile/.env"]:
    assert not (ROOT / path).exists(), f"secret/deployment artifact must not be bundled: {path}"

print("PASS: session revocation, contact-only presence, conversation notifications, verified TLS API/pinning, Keychain sessions, frame bounds and server-side E2EE fail-closed invariants")
