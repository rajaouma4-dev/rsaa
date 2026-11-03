# Current continuation: multi-user changes

Updated 3 November 2026. App source version 1.0.1 (code 2).

100 emulator-free real WebRTC clients exchanged 301/301 encrypted messages successfully, including an offline/reconnect delivery. Rust local tests: 14 passed, 2 opt-in integrations; the local DataChannel integration passed separately. Mobile semantic typecheck and storage/call/E2EE regressions passed. Rust optimized Windows build passed. See [full multi-user validation](docs/MULTI_USER_VALIDATION.md) for measured results, test scope and remaining release gaps.

The source and new builds are local. The updated Rust backend has not been pushed/deployed. Universal APK 1.0.1 (code 2): `mobile/android/app/build/outputs/apk/release/app-universal-release.apk`, 143,569,018 bytes. APK signature verification passed (v2, existing test signing key). SHA-256: `c21412b4848389b185c60ed12ad6c9601e06035292e4d374d6957d9ebc50304b`. Four ABI-specific APKs also built. As requested, this new build was not installed on or run in an emulator. Earlier two-emulator observations below describe the previous build, not this continuation's runtime Android verification.

---

# Nexa Chat — verified status

Updated: 3 November 2026, Asia/Kolkata.

## Current build

Universal APK: `mobile/android/app/build/outputs/apk/release/app-universal-release.apk` (143,560,154 bytes).
SHA-256: `6b5d5ea7e0d1f74dee646d1fb7b60b6b8ff9c8eee346ec137639d06f2fe40d0d`.
Android APK signature verification passed (v2). Uses the existing test signing configuration; this is a test release.
Four ABI-specific APKs also built successfully. Final x86_64 APK installed on both existing MuMu test devices with app data retained.

## Work completed in this continuation

- Verified the previously unfinished native crypto integration on Android: native AES/HMAC startup self-test passed on both devices.
- Serialized E2EE initialization so concurrent callers cannot generate competing identities.
- Made interrupted initial key provisioning retryable while retaining the existing identity.
- Reject failed identity persistence and update the in-memory ratchet only after secure persistence succeeds.
- Added production-service regression coverage for concurrent/interrupted initialization, old/new provider interoperability, persistent-session upgrades, replay/tampering and storage failures.

Existing uncommitted native-provider, identity-pin lookup/cache, RTC cleanup and Windows build-cache changes were retained. They are not deployed through a new Git commit in this continuation.

## Verification

| Check | Observed result |
|---|---|
| TypeScript semantic typecheck | Passed |
| Native-provider known-answer harness | Passed with Node WebCrypto; separate Android startup tests also passed |
| E2EE security and upgrade regressions | Passed |
| Low-latency queue/backpressure/media reassembly regression | Passed |
| Duplicate-answer, timer, early ICE and serialized call-signal regressions | Passed |
| Android assembleRelease, four ABIs plus universal | Passed |
| Existing session, native APK versus old APK | Four bidirectional text messages received; screenshots show seen receipts |
| Text UI observation bounds | 4.56–4.69 seconds, includes UI automation overhead; not a precise network-latency measurement |
| Audio call, native APK versus old APK | 1m 5s caller / 1m 6s receiver; manually ended; no immediate auto-end |
| Video call, final native APK on both | 1m 49s caller / 1m 50s receiver; manually ended; renderer logs approximately 24 FPS |
| Video picture | Still gray in both local and remote views; successful real-picture quality NOT established |
| Voice note, final APKs | 45-second recording received and displayed; audible quality not verified |
| HD image, final APKs | Existing synthetic fixture received and displayed |

Evidence screenshots: `docs/caller-video.png`, `docs/receiver-video.png`, `docs/voice-received.png`, `docs/image-received.png`.

## Remaining work before a public release

- Resolve gray video with a known camera source and validate actual audio/video content and latency on physical devices and mobile networks. Rendered FPS alone does not establish image quality.
- Authenticate call negotiation/fingerprints against verified peer identity. Current call signaling is not authenticated using the chat E2EE identity.
- Implement server-verified device registration/attestation, device lifecycle and replay controls as appropriate. The client replay regression above is not evidence of complete server replay protection.
- Move the TURN provider API credential out of the client, issue short-lived authenticated credentials server-side and rotate exposed credentials.
- Encrypt local message history/media at rest: current `messageStore.ts` uses AsyncStorage for decrypted messages.
- Persist the outgoing encrypted queue across process death; validate background delivery/push, offline recovery and account isolation.
- Address prekey lifecycle, identity verification/recovery and migration from legacy installations.
- Configure production signing, monitoring and independent security review.

No claim of production readiness or complete protection against interception, compromised devices or client automation is made. This continuation did not deploy a backend change; its changes are client-side. The live backend revision was not rechecked during this continuation.
