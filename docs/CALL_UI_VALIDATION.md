# Purple call UI — 4 November 2026

Version 1.0.5 (code 6). Based on the user's purple audio/video reference. Chat screens and call service signaling/media logic were not changed.

## Changes

- Dark plum/purple audio background, compact caller name and status/timer, central contact initials and translucent circular controls. The app currently has no profile-photo field; initials remain the real contact fallback, rather than embedding the mockup's fictional portraits.
- Full-screen remote camera uses cover; shared screens retain contain so content is not cropped. Compact top/bottom shading keeps controls readable.
- Existing mute, camera on/off, screen sharing, camera flip, quality cycling, accept, decline and end actions remain connected to their existing service methods. No inactive speaker/back button was added.
- Self-camera preview can be dragged with one finger; it stays within the screen and above controls. It keeps its position during call timer updates, clamps on layout changes, and starts at the lower right for each new call. Screen sharing hides the local camera preview as before.
- Remote RTCView uses Android zOrder 0; local preview uses zOrder 1. Local video is behind a touch-transparent view wrapper; gestures are handled by its Animated parent.

## Verification

- TypeScript typecheck, call lifecycle/multi-user regressions and preview drag geometry tests passed. Geometry checks cover portrait, landscape, small windows, extreme drags and rotation clamping. The preview test is included in Android CI.
- Release build passed; universal + four ABI APKs generated. Final universal APK v2 signature verification passed (existing test signer).
- Final APK installed with data retained on the three existing MuMu instances.
- An audio test call connected and remained active for approximately 3m 20s. Camera, screen-share, flip and quality controls remained visible as appropriate. During this call the self-preview was dragged in the emulator window from lower-right to upper-left, then to the bottom edge; it stopped above the call controls. Call continuity and preview movement were observed; audible content was not verified. This gesture test preceded only a handset-icon correction; drag code was unchanged in the final APK.
- A fresh video call was placed and accepted using the final build. MuMu then reported graphics rendering termination, error 901, and both call devices became unavailable over ADB. Full final video rendering and real camera quality are therefore NOT marked passed. Emulator graphics/system settings were left unchanged.
- Gray synthetic emulator camera input remains unresolved. Actual two-device camera content and audio quality require a separate test.

Universal test APK: `mobile/android/app/build/outputs/apk/release/app-universal-release.apk` (143,578,598 bytes).
SHA-256: `931c5fa3dea4c46ca94a39d2ad922feec61d16bdb5011b7aa80953a554ff1bf0`.

Design preview was generated with built-in imagegen from the user's supplied reference. It is a visual mockup, not a capture of real camera media. Actual audio-test screenshots are in ignored `backend/target/call-ui-qa/`.
