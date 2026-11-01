# Nexa Chat — Build and integration status

**Current deliverable: source ZIP only. No installable APK is included.**

## Current source state

| Area | Implemented in source | Verified in this workspace |
|---|---|---|
| React Native screens | Auth/register, inbox, people search, profile, chat UI | TS/TSX syntax parse only; no native app run |
| Live authentication | Mobile TLS signaling → Rust register/login; Argon2id; hashed server sessions; live token stored in Android Keystore/iOS Keychain | Not tested against a real server/Turso |
| User/conversation APIs | Search, create/list conversation, profile update, history | SQL regression checks; end-to-end not tested |
| WebRTC | React Native client and Rust answerer/DataChannel; ICE exchange scaffold | Not compiled or tested on two Android phones |
| Presence | Same-process contact-scoped online/offline updates; search hides global online state; new-conversation notification | Static source only; no network test |
| Message storage/outbox | Membership check, message+outbox transaction, post-commit ACK path and idempotency checks are in store code; relay is currently fail-closed | SQLite SQL regression; live DataChannel path intentionally rejects messages until E2EE exists |
| Delivered/seen | Recipient-bound backend receipt handlers | SQL path tested, client ACK intentionally not enabled |
| E2EE | No complete client E2EE/key-prekey relay | Not implemented; live send disabled |
| Password protocol | Argon2id over TLS | Source only; OPAQUE not implemented |
| TLS pinning | `react-native-tcp-socket.connectTLS()` + certificate validation + configured SHA-256 leaf-certificate fingerprint pin with primary/backup slots | API usage/source check only; real certificate pin and rotation not tested |
| SDUI | Allowlist renderer/schema validation | Signature verification and live config endpoint are not complete |
| Android APK | Bootstrap/build scripts + CI | Not built: Android SDK/Gradle unavailable |
| Rust backend | Store, TLS signaling, session revalidation, WebRTC answerer and outbox worker source + Cargo manifest | Not compiled: Rust/Cargo unavailable |

## Local checks performed

Run `./scripts/check-project.sh`. The latest successful local run reported:

- JSON config parsed.
- 16 TypeScript/TSX files parsed for syntax (not a semantic typecheck).
- TCP frame decoder test covers split Bengali UTF-8 characters, multiple frames, malformed JSON and oversized frames.
- Source invariant checks guard the documented TLS `connectTLS()` API, leaf fingerprint pinning, Keychain token storage, session resume and fail-closed E2EE behavior.
- 11 SQL migration statements exercised against SQLite, including current schema, old outbox migration, username search, conversation listing, contact-only presence lookup, history cursor, outbox retry claim, receipts and profile update.
- GitHub Actions YAML parsed.
- Rust compile/test skipped because `cargo` is not installed.
- Android build skipped because native shell/Gradle wrapper and Android SDK are not installed.

The GitHub Actions workflow is configured to run `cargo check`, `cargo test`, TypeScript semantic checking and Android `assembleRelease` after the source is pushed to a GitHub repository. Workflow success has not been observed yet.

## Blocking items before production

1. Integrate and test a maintained E2EE implementation on Android, including local encrypted state, identity/key distribution, prekey one-time consumption, relay and identity-change safety.
2. Compile and test Rust backend; validate the exact `webrtc` crate API against `0.21.1`.
3. Run two real Android clients through Wi-Fi, mobile data, CGNAT, reconnect and offline delivery tests.
4. Configure public TLS certificate, set primary/backup leaf-certificate pins, test pin rotation, deploy TURN and implement dynamic/ephemeral TURN credentials.
5. Configure Turso credentials on the deployed server; test transactions, concurrency, backups, PITR and restore.
6. Add device lifecycle, background delivery/push, multi-device session policy and account recovery. Secure token persistence in Keychain/Android Keystore is present in source but still needs an Android runtime test.
7. Wire signed SDUI config and Ed25519 verification/key rotation.
8. Add monitoring, abuse controls, dependency review and independent security testing.

The mobile app and backend both reject message sending until E2EE is implemented. Never distribute this starter as a finished secure messenger.
