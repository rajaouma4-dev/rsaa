# Nexa Chat — React Native + Rust + WebRTC + Turso

বাংলা setup: [`START_HERE_BN.md`](START_HERE_BN.md) · বাস্তব build/test status: [`BUILD_STATUS.md`](BUILD_STATUS.md)

This is a development source project, **not yet a production secure messenger and not an installable APK**. The repository contains a React Native Android-first UI, a Rust TLS/WebRTC backend, Turso schema/connection code, DataChannel/outbox logic, validation scripts and a CI workflow.

## Implemented in source

- React Native login/register UI, inbox, people search, 1:1 conversation UI and profile editor.
- Local demo mode. It is on by default and does not create real accounts or send network messages.
- Live client path for raw TLS/TCP signaling, registration/login, inbox fetch, user search, profile update, 1:1 conversation creation and WebRTC offer/answer/ICE setup.
- Rust/Turso Argon2id account storage, hashed session tokens, profile/search/conversation/history queries and backward-compatible outbox migration.
- Rust WebRTC peer/DataChannel handler, membership-derived recipient, bounded payload frames, durable message+outbox transaction, `SAVED_ACK` after commit, retry worker and delivered/seen receipt handlers.
- Online/offline presence updates scoped to existing conversation contacts on the same single Rust process.
- New-conversation notifications to an already-connected peer and a 25-second TLS signaling heartbeat so the server can revalidate active sessions periodically.
- Server-Driven UI allowlist renderer and schema validation scaffolding.
- Local SQL regression tests, TypeScript syntax check, Android bootstrap/build scripts and GitHub Actions jobs for Rust and Android.

## Deliberately blocked / not production complete

- **Live message relay is blocked in both the app and Rust server.** Signal Protocol/E2EE device initialization, key storage, identity verification, one-time prekeys and relay APIs are not integrated. A modified client must not be allowed to bypass the UI and submit plaintext or arbitrary bytes. Do not remove this guard until the full E2EE path is implemented and tested on two real devices.
- Passwords travel inside TLS to the Rust server and are hashed using Argon2id. OPAQUE is not implemented.
- The mobile signaling client uses `react-native-tcp-socket.connectTLS()` and enforces normal TLS validation plus a configured SHA-256 fingerprint pin of the leaf certificate. Live session tokens use `react-native-keychain` rather than AsyncStorage. The primary/backup values are placeholders and certificate rotation has not been tested; this is not SPKI pinning.
- Signaling is newline-delimited JSON over raw TLS/TCP, not a binary CBOR protocol and not HTTP/REST.
- WebRTC server mapping is in-memory, one active channel per UID per process. It is not multi-node or robust multi-device routing.
- Presence is process-local and limited to existing conversation contacts; Redis/NATS, push notifications, dynamic TURN credentials and app-background delivery are not implemented.
- Live signed Server-Driven UI config retrieval, Ed25519 signature verification and key rotation are not connected. The verifier intentionally fails closed.
- A live Turso account, deployed hostname/certificate, matching primary/backup certificate fingerprints, TURN service and production keystore were not supplied.

## Validate and build

Run local source checks:

```bash
./scripts/check-project.sh
```

It parses JSON, TypeScript/TSX syntax, tests split-UTF-8 TLS signaling frame decoding, exercises database SQL against local SQLite, checks critical source invariants, parses workflow YAML and reports unavailable compilers instead of pretending they ran.

Requirements for a real Android release build:

- Node.js 22.13+
- JDK 17
- Android SDK Platform 37 and matching build tools
- Rust stable + Cargo for backend build/tests
- A trusted TLS certificate for the real signaling hostname
- Turso database URL/auth token (backend only)

Build Android:

```bash
./scripts/build-android.sh
```

Output path:

```text
mobile/android/app/build/outputs/apk/release/app-release.apk
```

The script does not create a production keystore or sign using your private release key. Configure your own Android signing credentials before distribution. The 6 MB APK target is not guaranteed; React Native and native WebRTC make that target very difficult.

## Architecture

```text
React Native A ─ TLS/TCP signaling ─ Rust WebRTC peer A
                                         │
                                membership / validation
                                         │
                          Turso: message + outbox commit
                                         │
                                durable retry worker
                                         │
React Native B ─ WebRTC DataChannel ─ Rust WebRTC peer B
```

Each client connects to the Rust server; A and B do not create a direct P2P chat. DTLS protects each DataChannel hop, but the Rust endpoint terminates transport encryption. True server-blind confidentiality requires device-to-device E2EE before bytes enter the DataChannel.

Turso `libsql` remote connections use Turso's remote HTTP(S)-based database protocol from the Rust server. The Android client does not call an HTTP REST API directly. If the requirement is “no HTTP anywhere in the system,” remote Turso does not satisfy that stricter requirement.

## Local validation status

See [`BUILD_STATUS.md`](BUILD_STATUS.md) for the exact checks performed in the supplied workspace. Rust/Cargo and Android SDK/Gradle are not installed here, so neither backend compilation nor an APK build was performed in this environment.
