# Nexa Chat Rust backend

Android clients connect over a custom newline-delimited JSON signaling protocol carried by TLS/TCP. The listener is not an HTTP REST API. The main user-data channel is WebRTC DataChannel; each mobile client connects to a Rust peer and the server relays between its connected clients after persistence.

## Configure

Copy `.env.example` to `.env` and set:

- `TURSO_DATABASE_URL`: database connection URL from Turso, commonly `libsql://...turso.io`; not `https://app.turso.tech`.
- `TURSO_AUTH_TOKEN`: backend-only auth token. Never bundle this in the app.
- `TLS_CERT_PATH` / `TLS_KEY_PATH`: certificate chain and private key for the actual signaling hostname.

The signaling TLS listener is configured for TLS 1.3 with an explicitly selected rustls ring crypto provider. The server creates/updates the schema during startup using `Store::migrate()`. The remote DB connection enables foreign keys, requests full synchronous writes, sets a 5-second busy timeout, and upgrades older outbox retry columns without dropping existing rows. Actual remote durability/backups are governed by Turso service settings and must be tested in the deployed account.

## Run

```bash
cargo generate-lockfile
cargo check
cargo test
cargo run --release
```

## Current implemented paths

- Account register/login with Argon2id password hashes and random opaque account UIDs.
- Session token hash storage, validation, expiry, revocation on logout and periodic revalidation while a client sends signaling heartbeats.
- Username/display-name search, profile update, 1:1 conversation creation/listing, and member-checked history reads.
- WebRTC offer/answer and ICE candidate signaling; one active in-memory DataChannel per UID in a single server process.
- Contact-scoped presence updates to currently connected DataChannel clients; username search does not disclose global online status.
- New-conversation notifications to a connected peer.
- Message persistence, membership validation, atomic outbox and ACK routines exist in the store/worker code, but the DataChannel message-ingress handler currently rejects every `send_message` frame with `E2EE_NOT_CONFIGURED`. This prevents a modified client from bypassing the disabled UI and submitting plaintext before E2EE is implemented.
- Pending outbox retries with atomic claim and capped backoff; recipient-controlled delivered/seen receipts.
- Per-IP auth rate limit, concurrent signaling connection limit, bounded signaling frames and bounded DataChannel frames.

## Security and deployment limits

- The app deliberately blocks live message sending because a vetted Signal Protocol/E2EE implementation and key/prekey relay are not integrated. The backend cannot prove that arbitrary bytes supplied by an untrusted custom client are encrypted.
- Password is sent inside TLS to the Rust server and hashed with Argon2id. OPAQUE is not integrated.
- Mobile signaling validates normal TLS certificates and enforces a configured SHA-256 leaf-certificate fingerprint pin. Supply primary + backup fingerprints and test rotation; this is certificate pinning, not SPKI pinning.
- Signaling is newline-framed JSON, not a binary CBOR protocol. It is raw TLS/TCP, not HTTP.
- The in-memory presence/channel map is single-process only; it is not a multi-node or multi-device system. Redis/NATS routing, push notifications and TURN ephemeral credential delivery are not complete.
- Turso's remote libSQL connector talks to Turso using its remote HTTP(S)-based protocol from the backend. No Android REST API is used.
- This source was not compiled in the supplied workspace because Cargo/Rust was not installed. Run the CI workflow or `cargo check && cargo test` before deploying.

Do not expose this server to production users until E2EE, TURN, pinning/rotation, backup/restore, multi-device policy, abuse controls and two-device security tests are complete.
