# Nexa Chat threat model and release gates

## Assets

- User credentials and session tokens.
- Device identity keys, ratchet state and prekeys (not yet integrated).
- Chat plaintext on endpoints.
- Opaque message envelopes and delivery metadata in the relay/database.
- User profile and conversation membership.
- TLS certificate/private key and Turso auth token.
- SDUI signing key and configuration (live signed config not yet integrated).

## Trust boundaries

- Android device: untrusted if rooted, hooked, instrumented or compromised. APK obfuscation does not make the client trusted.
- TLS/TCP signaling: credentials are protected in transit, but the Rust server endpoint sees passwords during login/register.
- WebRTC DataChannel: DTLS protects each client-to-server hop. The Rust server terminates DTLS and can see the DataChannel frame. This is not E2EE.
- Rust server: authenticates, authorizes, persists and routes. It should never receive message plaintext after E2EE is implemented.
- Turso: stores account/profile data and message-envelope bytes. The backend accesses it with a server-only auth token.

## Controls present in current source

- TLS certificate validation on the mobile signaling socket.
- Argon2id password hashing at the Rust server.
- Random account UID and high-entropy random session token; only the token hash is stored.
- Per-IP auth attempt limit, concurrent signaling connection cap, TLS handshake timeout, and bounded signaling/DataChannel frames.
- Parameterized SQL, 1:1 conversation membership check, recipient derived by server, message-ID collision check, message size limit and per-sender message quota.
- Message plus outbox written in one database transaction; `SAVED_ACK` only after commit; retry claims are atomic.
- DataChannel recipient receipts are bound to the stored message recipient.
- Server-driven UI component allowlist. Arbitrary code execution is not permitted.

## Controls not yet present — do not release until complete

1. Signal Protocol/E2EE implementation and independently reviewed client integration; secure local ratchet/key storage; public prekey relay with atomic one-time-prekey consumption; identity-change/safety-number UX.
2. OPAQUE or equivalent password-authentication protocol. Current password is sent to the server inside TLS and hashed with Argon2id.
3. TLS public-key/certificate pinning with primary/backup pin and rotation; real trusted certificate deployment.
4. Secure live-session token persistence (Android Keystore-backed storage), multi-device identity and revocation lifecycle.
5. TURN with ephemeral credentials, network-change recovery and reconnect logic.
6. Multi-node routing, cross-node presence, durable broker, push notifications and app-background delivery.
7. SDUI signature verification/key rotation and live config API; current verifier fails closed.
8. Encrypted backups/PITR, restore drills, monitoring, dependency review, abuse reporting and independent penetration/security testing.

## Release rule

Do not call this source a secure production messenger. Do not enable live message send until the client encrypts before DataChannel send, decrypts before display, persists decrypted content locally, and passes multi-device and adversarial tests. Never put Turso tokens, TLS private keys, TURN shared secrets or SDUI signing private keys in the APK.
