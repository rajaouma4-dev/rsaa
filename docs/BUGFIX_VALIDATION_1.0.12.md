# Bug-fix validation — 4 November 2026

Android **1.0.12**, version code **13**.

Three bugs were reproduced with failing assertions before their fixes:

1. A notification tap could wait behind an unfinished push-registration request. A warm intent also had no immediate native-to-JavaScript event. Notification opening now drains independently of registration and receives its own native event; resume and cold startup still recover stored intents.
2. A failed request using an obsolete FCM token could apply its Retry-After delay to a newly rotated token's pending job. Retry updates now require the current installation, account and token to match the request snapshot.
3. Disabling the server notification preference after a worker's due-job query did not stop that snapshot from being claimed. The atomic claim now rechecks the current preference, in addition to the existing token, account, session, foreground and seen-status checks.

## Verification

- All 12 existing client regression harnesses passed at baseline: native crypto, E2EE security/upgrade, session recovery, storage concurrency, queue latency, realtime/call races, call preview bounds, chat appearance, avatars and notifications.
- Expanded notification-controller tests passed with registration deliberately held unresolved; resume and warm native notification events opened their conversations without waiting for that request.
- Expanded durable push tests passed, including stale-token backoff and preference changes between query and claim.
- Full Rust suite: **22 passed**, 3 opt-in integrations skipped by default.
- TypeScript semantic check, SQL regression script, diff whitespace check and Android release build passed.
- Installed the new x86_64 release on the existing Android 15 emulator, retaining app data.
- A warm native notification intent opened an existing authorized conversation in **2.50 seconds including UI automation overhead**. This is an observation bound, not a network latency measurement. No chat message was sent.
- MuMu's UIAutomator wrote a fresh valid XML hierarchy but sometimes exited 139 during shutdown. The UI harness removes the prior file and requires a fresh success marker and parseable XML before using such output.

- Real Firebase HTTP v1 → the existing Android 15 emulator passed foreground receipt without notification, notification after process kill, and duplicate suppression on 1.0.12. A first 18-second foreground observation did not prove receipt; the subsequent bounded 60-second observation did. Provider acceptance is not an immediate-delivery guarantee.
- The FCM test can skip the unsupported offline scenario without changing network settings, and each new test run starts a fresh report so an earlier pass cannot mask a later failed attempt.

Live deployment is verified after publishing this patch. The offline/on-device limitation from the previous release remains: a reliable physical-device offline/reconnect pass has not been established.

## Artifact

`mobile/android/app/build/outputs/apk/release/app-universal-release.apk`

Size: **143,932,225 bytes**. APK v2 signature verification passed with the project's existing test signing configuration.

SHA-256: `3ba29aff512befb0191cf33ae8a082820f57a8a3fa9ef6573be9029d3274e749`.
