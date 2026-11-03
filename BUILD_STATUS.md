# Current profile-photo update — 4 November 2026

Version 1.0.8 (code 9) adds compact persistent profile photos and realtime version notifications. Photo change/remove, cache, restart persistence, remote chat/message/call-history avatars, People and incoming-call photo were verified. A 501 KB test artwork uploaded as a 7,102-byte thumbnail. Server feature `accea37` was verified live. See [profile-photo validation](docs/PROFILE_PHOTO_VALIDATION.md) for exact evidence, limits and APK hash. New APK is required on each client to display photos.

---

# Current chat design — 4 November 2026

Version 1.0.7 (code 8) adds the redesigned conversation/composer/call cards and database-backed wallpapers with persistent caching. Overflow menu offers Background and Bubble color, live preview, hex presets and solid/gradient/glow effects. Four supplied images are stored in Turso. Theme loading, saved appearance after restart and text delivery were verified on the updated app. See [chat appearance validation](docs/CHAT_APPEARANCE_VALIDATION.md) for exact tests, screenshots and APK hash. Preferences apply to this chat on this device.

---

# Current call delivery fix — 4 November 2026

Version 1.0.6 (code 7) fixes abandoned server busy reservations after app restart and reconnects signaling before dialing. Server fix `1d843f5` was confirmed live on Render. Three-emulator testing verified audio ringing/accept/connect, third-caller busy without disrupting an active call, force-stop/restart then successful redial, and video ringing/accept/connect. Gray emulator camera content and real audio/video quality remain unresolved. Install 1.0.6 on both calling devices. See [call recovery verification](docs/CALL_RECOVERY_VALIDATION.md) for evidence, checks and APK hash.

---

# Current call UI update — 4 November 2026

Version 1.0.5 (code 6) adds the user's purple call design with draggable local-camera preview, retaining existing call controls. Chat UI is unchanged. Release APK build, signature and typecheck passed; all three existing test emulators were updated. Live audio-call UI and preview movement were observed. A fresh final-build video test was interrupted by MuMu graphics termination (error 901), so full video rendering/quality is not certified. See [call UI validation](docs/CALL_UI_VALIDATION.md) for exact evidence, APK hash and remaining checks.

---

# Continuation verification — 4 November 2026

- Re-read the interrupted chat and retained the unfinished account-scoping changes. Version 1.0.4 (code 5) is being validated locally.
- Public GitHub main and Render health both reported `93e9fb560e7267f7fde65b4c74e30213d52b7684`; health status was `ok`. The new client fix is not included in that deployed revision.
- Fixed a restart bug in the unfinished account-scoping implementation: a saved scoped login could claim the unscoped legacy namespace and replace its identity. Scoped identity/ownership now wins; namespace selection is persisted before provisioning. Legacy restoration is limited to an unclaimed saved account with actual legacy keys.
- Production-service regression tests cover account A/B isolation, returning to the original ratchet, peer trust isolation, scoped restart and interrupted fresh-login restart in the presence of legacy keys. These tests passed, together with typecheck, native-provider harness, E2EE security/upgrade, queue/latency, session recovery, storage concurrency and call regressions.
- Rust unit suite: 15 passed, 2 opt-in tests skipped. Local real DTLS/SCTP integration: 4 clients, 13/13 messages persisted, delivered and decrypted, including offline/reconnect recovery. The initial sandboxed run timed out opening the DataChannel; the same test passed with loopback networking available outside the sandbox.
- SQL migration regression and split-UTF-8 framing tests passed. `scripts/test-source-invariants.py` still fails on a pre-existing contact-presence assertion; it also contains obsolete assumptions about demo mode and disabled E2EE relay. It is not counted as passed.
- Exactly the three existing MuMu emulators are available (16384, 16416, 16448); their initial app screens showed ONLINE. This alone does not establish message or media delivery.
- The deployed revision's GitHub workflow completed successfully: https://github.com/rajaouma4-dev/rsaa/actions/runs/41669690731 . New local regression commands were added to CI; they have not run remotely yet.
- Default Android build hit a pre-existing Windows QuickCrypto/Nitro prefab cache path failure. Rebuild using the existing short native-staging option succeeded (all four ABI APKs plus universal); the Windows release script now supplies this setting automatically.
- Current universal test APK: `mobile/android/app/build/outputs/apk/release/app-universal-release.apk`, 143,574,018 bytes; SHA-256 `939fede09c63088cc2673687a54f13ff74f8aa58e5c77d8759581c95cab4812d`. APK v2 signature verification passed. Existing test signing remains in use.
- 1.0.4 installed successfully on all three existing emulators with data retained; all restored their logins and displayed ONLINE. C to B synthetic text and B to C reply appeared as plaintext on both devices. B was then force-stopped; C submitted another synthetic message; after both apps restarted, B displayed that message in the conversation with E2EE CONNECTED. This tests foreground recovery after explicit relaunch, not background push.
- A's historical mixed-account ratchet and live calls/video were not revalidated in this continuation. Do not extrapolate the C/B result to all historical sessions.
- No saved GitHub credential is available (`push --dry-run` could not authenticate). The chat-exposed PAT was not used. New changes have not been pushed.

Remaining release limitations include gray emulator video, audible media quality, call identity authentication, server-side device lifecycle, embedded TURN credentials, encrypted local history, production signing and background delivery. Existing mixed-account legacy ratchets cannot be safely repaired by silently clearing peer trust; local regression success does not certify those historical live sessions.

---

# Current status: GitHub push and three-emulator validation

Updated 3 November 2026. Current app source version: 1.0.3 (code 4).

Application changes are pushed to `rajaouma4-dev/rsaa`. Render deployment is verified through its public `build_revision` health response. The live test found credential-less TURN entries breaking server peer configuration; the server now uses TURN credentials when present and otherwise retains valid STUN configuration. Startup also distinguishes temporary network/auth-service failure from explicit session expiry so deployment reconnects do not erase a valid saved login.

Three existing MuMu emulators are used, with no additional instances. A–B audio call remained connected for at least 2m 41s while C called B and received the busy outcome. Chat/reconnect verification after the TURN fix and final 1.0.3 install is being completed; see `docs/LIVE_DEPLOYMENT_TEST.md` for the live test record. Backend local suite: 15 passed, 2 opt-in integrations. Session-recovery, call and storage-concurrency tests pass.

The 100-client local result remains 301/301 encrypted messages including offline delivery. It is not a public capacity guarantee. Prior APK hashes and observations below are historical. Production signing, background notifications, real audio/video quality and release security gaps remain open.

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
