# Nexa Chat — Complete Implementation & Verification Plan

## 1. System Architecture Overview

Nexa Chat is an Android-first secure messenger with strict transport isolation:
- **Mobile Client:** React Native (Bare CLI, TypeScript, Hermes, TLS 1.3 raw TCP socket signaling, WebRTC DataChannel application layer).
- **Relay Server:** Rust (`nexa-messenger-server`), Tokio async runtime, `webrtc` v0.21.1, `tokio-rustls`, `libsql` v0.10.
- **Database:** Turso / libSQL cloud database accessed exclusively by the Rust backend. Zero direct database access from mobile.
- **Topology:** Star topology with client-to-server WebRTC DataChannel (Client A <-> Rust Server <-> Client B). No direct P2P connections between clients.
- **Signaling:** Length-delimited UTF-8 JSON frames over authenticated raw TLS 1.3 socket with leaf-certificate SHA-256 fingerprint pinning. Zero HTTP/REST APIs for chat operations.

---

## 2. Comprehensive Audit Findings

### A. Rust Backend
1. **Compilation Failures (Resolved):**
   - `password_hash::Error` lacked `std::error::Error` implementation for `anyhow::Error` conversion. Resolved by enabling `std` feature in `backend/Cargo.toml`.
   - `safe_error(&anyhow::Error)` in `main.rs` failed to accept `webrtc::error::Error` and `serde_json::Error`. Resolved by making `safe_error<E: std::fmt::Display>` generic.
2. **Database Engine & Protocol (Resolved & Verified):**
   - Remote Turso over Hrana rejects certain server-managed SQLite PRAGMAs (`PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000`). Resolved by ensuring non-fatal execution on remote connections.
   - Live cloud connection to `libsql://erasa-wrrrr.aws-ap-south-1.turso.io` verified with all 15 required tables migrating successfully.
3. **Database Schema Completeness (Resolved):**
   - Added all 15 required relational schemas: `users`, `user_profiles`, `devices`, `device_identity_keys`, `auth_sessions`, `conversations`, `conversation_members`, `messages`, `message_delivery_status`, `user_presence`, `user_contacts`, `user_settings`, `sdui_configs`, `message_outbox`, `database_schema_version`.

### B. React Native Mobile Client
1. **Dependencies & Syntax (Resolved):**
   - Installed 575 packages cleanly via `npm install`.
   - Added `@types/jest` to devDependencies to satisfy `@react-native/typescript-config`.
2. **TypeScript Compilation (Resolved):**
   - `StatusBar` in React Native 0.88 does not accept `backgroundColor` prop on the component interface; removed prop, keeping native Android theme styling.
   - `JsonLineFrameDecoder` Buffer subarray typing adjusted to wrap `Buffer.from()` on slice boundaries.
   - `react-native-webrtc` does not export `RTCDataChannel` directly; resolved using `ReturnType<RTCPeerConnection['createDataChannel']>`.
   - `ServerDataChannel` ICE candidate callback typing corrected for nullable event candidates.
   - `TlsSignalingClient.connect()` typed strictly with `Promise<void>`.
   - `tsc --noEmit` now passes with 0 errors across all 123 source files.
3. **Framing & Invariant Tests (Resolved):**
   - `scripts/test-mobile-framing.cjs` fixed to load local `typescript` module without invoking external shell `npm`.
   - Framing test passes: multi-byte UTF-8 character splitting, oversized frames, and malformed JSON rejections verified.
   - Python schema & invariant tests pass.

---

## 3. Implementation Roadmap

### Phase 1: Environment & Android Tooling Setup (In Progress)
- [x] Node.js 24.12.0 & npm 11.6.2 verified.
- [x] Rust 1.98.1 & Cargo verified.
- [x] Android SDK present at `C:\Users\abc\AppData\Local\Android\Sdk`.
- [ ] Install JDK 17 (Microsoft OpenJDK 17 or Eclipse Temurin 17) via `winget`.
- [ ] Bootstrap native Android shell via `@react-native-community/cli@20.2.0 init` template extraction (`scripts/bootstrap-native.sh`).
- [ ] Configure `local.properties` pointing to `sdk.dir=C:\\Users\\abc\\AppData\\Local\\Android\\Sdk`.

### Phase 2: Database & Backend Verification
- [x] Turso credentials configured in ignored `backend/.env`.
- [x] Schema migration tests passing against remote Turso instance.
- [x] Rust backend unit tests passing (5/5).
- [ ] Wire full E2EE prekey distribution endpoints in protocol & store.

### Phase 3: WebRTC & Messaging Core
- [x] Client DataChannel connection lifecycle & keepalive.
- [x] Rust server answerer negotiation.
- [x] Outbox retry mechanism with exponential backoff.
- [ ] E2EE cipher envelope integration and key persistence in Android Keystore.

### Phase 4: Native Android Build
- [ ] Generate Android build files with Hermes and release optimizations.
- [ ] Compile debug APK: `gradlew assembleDebug`.
- [ ] Create release keystore, configure signing in `build.gradle`, and compile release APK: `gradlew assembleRelease`.
- [ ] Record SHA-256 and package into `deliverables/`.

### Phase 5: Delivery & Reports
- [ ] Generate comprehensive `TEST_REPORT.md`, `BUILD_REPORT.md`, Bengali setup guides.
- [ ] Package clean source ZIP (excluding `.env`, secrets, `.git`, `node_modules`, `target`, `build`).
