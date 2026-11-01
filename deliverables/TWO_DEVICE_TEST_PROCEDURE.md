# Nexa Chat — Two-Device Real Handset Testing Procedure & Checklist

This document provides the standard operating procedure (SOP) and verification checklist for executing end-to-end testing between two physical Android devices over a live, publicly reachable Rust backend and Coturn TURN server.

> **CRITICAL HONESTY NOTICE**: Physical device testing requires two physical handsets on separate networks (e.g. Wi-Fi and 4G LTE). Because no live physical devices were connected to the automated build host (`adb devices` reported only an offline emulator), automated protocol, database, and cryptographic tests have passed 100%, while physical on-device execution remains **PENDING PHYSICAL HANDSET EXECUTION** according to the checklist below.

---

## 1. Hardware & Environment Configuration

| Component | Target Specification | Status / Verification Method |
|---|---|---|
| **Device A Handset** | Physical Android Phone, Android 9.0+ (ARM64-v8a) | Physical handset on Wi-Fi network |
| **Device B Handset** | Physical Android Phone, Android 9.0+ (ARM64-v8a) | Physical handset on 4G/5G Cellular data |
| **Account A** | Username: `alice_test`, Name: `Alice Handset` | Separate fresh account registered via app |
| **Account B** | Username: `bob_test`, Name: `Bob Handset` | Separate fresh account registered via app |
| **Rust Backend Server** | Publicly reachable Linux host / VPS | Running `nexa-messenger-server` binary on port 7443 |
| **TLS Certificate** | Valid CA-signed certificate (Let's Encrypt) | Domain: e.g., `chat.example.com`, fullchain.pem + privkey.pem |
| **TURN Server** | Coturn STUN/TURN server | UDP/TCP `3478`, TLS `5349`, relay ports `49152-65535` |
| **Cloud Database** | AWS Turso libSQL Cloud Database | `libsql://erasa-wrrrr.aws-ap-south-1.turso.io` (Verified active) |

---

## 2. Server & Client Setup Instructions

### A. Deploy Backend & TURN on VPS
1. On your VPS, run Coturn:
   ```bash
   turnserver -c /etc/turnserver.conf --daemon
   ```
2. Start the Rust server with production environment variables:
   ```bash
   export TURSO_DATABASE_URL="libsql://erasa-wrrrr.aws-ap-south-1.turso.io"
   export TURSO_AUTH_TOKEN="<PRODUCTION_TOKEN>"
   export TLS_CERT_PATH="/etc/letsencrypt/live/chat.example.com/fullchain.pem"
   export TLS_KEY_PATH="/etc/letsencrypt/live/chat.example.com/privkey.pem"
   export TURN_SERVER="turn:turn.example.com:3478"
   export TURN_USERNAME="nexa_turn_user"
   export TURN_PASSWORD="<STRONG_PASSWORD>"
   ./nexa-messenger-server
   ```

### B. Configure Client for Production
In `mobile/src/config.ts`:
- Set `DEMO_MODE: false`
- Set `SIGNALING_HOST: 'chat.example.com'`
- Set `SIGNALING_PORT: 7443`
- Set `TLS_CERT_SHA256_PINS: ['<SHA256_OF_YOUR_LEAF_CERT>']`
- Rebuild release APK: `./gradlew assembleRelease`

---

## 3. Step-by-Step Test Procedure & Verification Checklist

| Step # | Test Phase | Expected Result | Result Status |
|:---:|---|---|:---:|
| **1** | **User Registration** | Device A registers `@alice_test` and Device B registers `@bob_test`. Curve25519 identity key generated and wrapped in Android Keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). PreKey bundle uploaded to Turso. | `[ ] PENDING EXECUTION` |
| **2** | **User Login & Session Restore** | Both devices log into accounts, establishing TLS 1.3 raw TCP control connection, then exchanging SDP offer/answer to open WebRTC DataChannel. | `[ ] PENDING EXECUTION` |
| **3** | **E2EE Handshake (PreKey Bundle Exchange)** | Device A searches `@bob_test`, opens chat, fetches Bob's prekey bundle, and initializes Double Ratchet session. No plaintext in bundle. | `[ ] PENDING EXECUTION` |
| **4** | **A-to-B Message Delivery** | Alice types `"Hello Bob"` and sends. Payload sent as Signal Protocol V3 ciphertext (`0x33...`, Type 3 PreKeyWhisperMessage). Bob decrypts cleanly. Alice status changes to single tick (`✓ SAVED`). | `[ ] PENDING EXECUTION` |
| **5** | **B-to-A Reply (Ratchet Advancement)** | Bob replies `"Hello Alice"`. Message encrypted as `WhisperMessage` (Type 1). Alice decrypts. Symmetric ratchet advances. Both parties have verified end-to-end ratchet step. | `[ ] PENDING EXECUTION` |
| **6** | **Delivered Status Receipt** | Upon Bob's successful decryption, Device B emits `DeliveredAck`. Device A's checkmark updates to double tick (`✓✓ DELIVERED`). | `[ ] PENDING EXECUTION` |
| **7** | **Seen Status Receipt** | Bob views message thread. Device B emits `SeenAck`. Device A's checkmarks change to green / seen (`✓✓ SEEN`). | `[ ] PENDING EXECUTION` |
| **8** | **Offline Delivery (Outbox Queue)** | Bob enables Airplane Mode. Alice sends message #3. Server saves ciphertext in `messages` and outbox with status `SAVED`. Alice sees single check. Bob disables Airplane Mode. WebRTC DataChannel reconnects. Server outbox worker flushes message to Bob. Bob decrypts. Status updates to `DELIVERED`. | `[ ] PENDING EXECUTION` |
| **9** | **Network Reconnect & Channel Recovery** | Disconnect Wi-Fi on Device A and switch to Cellular. WebRTC DataChannel reconnects. Pending receipts and presence frames resume without session corruption. | `[ ] PENDING EXECUTION` |
| **10** | **App Restart & Session Persistence** | Force-stop Nexa Chat on Device B via Android Settings. Reopen app. Double Ratchet session record and identity key successfully reload from Keystore. Alice sends message #4; Bob decrypts immediately without needing new handshake. | `[ ] PENDING EXECUTION` |

---

## 4. Failure Mode Test Cases (Negative Validation)

- **Tampered Ciphertext Rejection**: Intercept or tamper with a ciphertext byte in transit; recipient must reject with `Bad MAC` and never display unauthenticated plaintext.
- **Replay Protection**: Replay the exact ciphertext byte sequence; recipient must reject with `MessageCounterError`.
- **Wrong-Key / Independent Session Isolation**: A third client (Eve) intercepting the ciphertext cannot decrypt with her own keys or independent session.
- **Server Zero-Plaintext Audit**: Direct SQL query on Turso database (`SELECT ciphertext FROM messages`) returns only raw Signal V3 binary envelopes. Zero plaintext is present in server memory or storage.
