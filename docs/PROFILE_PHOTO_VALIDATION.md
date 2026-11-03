# Profile photos — 4 November 2026

Version 1.0.8, code 9. Profile has Change photo (automatically saves after selecting) and confirmed Remove. The shared Avatar component displays UID-scoped photos in own profile/header, inbox, people/stories/search, chat header/message groups, call history and audio/incoming-call placeholder. Initials remain the fallback when no photo exists or image rendering fails.

Android processes images off the UI thread, samples the decode, handles EXIF orientation, center-crops a square and bounds the thumbnail to 256 pixels and 16,000 JPEG bytes. The server enforces JPEG byte/dimension bounds. No full-size photo is uploaded. An authenticated upload can modify only the current account; data persists in `profile_avatars` with a content-derived version. Identical uploads retain their version.

Realtime events carry only UID/version to connected clients. Visible avatars fetch a new image once; duplicate requests share a promise. Matching cached versions receive no image payload. Public avatar cache persists in AsyncStorage; offline reads retain the previous photo. Hot image records are capped with visible subscribers protected. Reconnect refreshes visible versions; old in-flight responses cannot overwrite a newer photo. Users running older clients need this APK to display profile images. Background push wakeup is not added.

## Verification

- TypeScript typecheck passed. Avatar tests passed for deduplicated loads, version-only refresh, realtime subscribers, stale response protection, removal and persistent offline cache.
- Rust suite: 20 passed, 2 opt-in tests skipped. New DB regression covers photo roundtrip, identical-upload version reuse, unchanged-version omission, separate users, removal and invalid/oversized image rejection. SQL migration regression: 32 statements passed.
- Android release build (four ABI splits + universal) and APK v2 signature passed using the existing test signer. All three existing MuMu devices updated with data retained.
- Runtime server `accea37` was confirmed live. On disposable QA C, a supplied mountain artwork was selected through the Android system picker and saved. Database verification measured 7,102 bytes at 192×192, down from the 501,417-byte source.
- B's already-open C conversation changed from initials to the photo without navigation/refresh. Its header, incoming message avatar and final-build call-history avatar showed the new image. After app update/restart, C's own photo remained and A's inbox could fetch the saved photo. Removal restored initials on B; restoring the image updated B again. People search and incoming audio-call placeholder also displayed C's photo; the test call was declined cleanly.
- This verifies the profile-photo flow on the test emulators, not all possible devices/networks or a blanket absence of bugs. Existing gray video/audio-quality and other release limitations remain recorded separately.

Universal test APK: `mobile/android/app/build/outputs/apk/release/app-universal-release.apk`, 143,610,142 bytes.
SHA-256: `fb6de84e01513bf81dae3a411481578cb5a425c6ff6c05a6e2b822c4958c2a79`.
Screenshots: `docs/profile-photo-v108.png`, `docs/profile-photo-chat-v108.png`, `docs/profile-photo-call-v108.png`.
