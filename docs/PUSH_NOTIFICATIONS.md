# Android message notifications

Implementation date: 4 November 2026. App version 1.0.11 (code 12).

## Behavior

- While any app activity is visible, no message notification is posted. Existing message notifications clear when the app returns to the foreground.
- In the background, native Android code posts a private generic message alert with sound/vibration and a high-importance channel. Heads-up display depends on the user's channel, permission and Do Not Disturb settings.
- FCM's native service can post without the React Native engine running. Swiping the app away is different from explicitly Force stopping it in Android Settings.
- Offline FCM wakeups have a seven-day TTL. Server push jobs persist in the database, retry network/provider failures with backoff, honor numeric Retry-After responses, and recover across server restarts. Encrypted message storage/delivery remains independent of push delivery.
- Notification payloads contain recipient, conversation and message IDs, never plaintext, media, sender names, passwords or encryption keys.
- Recent message IDs are deduplicated across the live connection and FCM, including foreground deliveries. Tapping an alert opens the corresponding conversation after session restoration and inbox loading.
- Registration is authenticated and bound to the current login session and installation. Logout clears the native account; revoked/expired server sessions cannot receive new server pushes. Token rotation requeues recent unread IDs, and invalid tokens are disabled until registration refreshes.
- A short renewable foreground lease avoids unnecessary pushes while the app is open. If a process disappears without a background update, the lease expires within 90 seconds.
- Android 13+ asks for notification permission once after sign-in. Denial does not block chat or trigger repeated prompts. Profile → Notification settings opens the system settings page.

## Firebase configuration

Android package: `com.securemessenger`. Firebase project: `nexachet-ea741`.

The supplied Android `google-services.json` was copied to `mobile/android/app/google-services.json` and validated against the package name. Google Services Gradle plugin 4.5.0 processes it. This file is locally ignored; on another checkout supply it before building. GitHub Actions accepts its content in repository secret or variable **FIREBASE_ANDROID_CONFIG**. CI warns if it builds without push configuration.

The private service-account file stays outside this repository. Local `backend/.env` references the supplied file with **FIREBASE_SERVICE_ACCOUNT_FILE**. Do not put that private key in Android resources, the APK, source control or chat.

For Render, deploy the new backend and supply one of:

1. A Render secret file containing the service-account JSON, with **FIREBASE_SERVICE_ACCOUNT_FILE** pointing to its deployed absolute path; or
2. A secret environment variable **FIREBASE_SERVICE_ACCOUNT_JSON** containing the JSON.

The Firebase Cloud Messaging HTTP v1 API must be enabled for the project and the service account must have permission to send messages. The server signs a short-lived OAuth assertion, caches the resulting access token, and sends via HTTP v1. It does not use a legacy server key.

Existing live backend code cannot accept the new device-registration frames or create push jobs until deployed. Local configuration does not change Render's environment.

## Verification

- TypeScript semantic check: passed.
- `mobile/test-notifications.cjs`: passed foreground/background race, reconnect, token rotation, permission denial/revocation, notification-open routing and account cleanup.
- Rust suite: 22 passed, 3 opt-in integration tests ignored by default. Push tests cover atomic enqueue/idempotency, foreground lease, ownership, provider retry timing, reopening the on-disk database, token rotation, seen messages, account switch and session revocation.
- Configured Android release and separate instrumentation test APK builds: passed; universal and four ABI APKs generated.
- Real Firebase HTTP v1 → existing Android 15 MuMu device: accepted foreground push reached native code without posting a notification; a new push posted a high-importance private notification after `am kill` removed the app process; repeating the same push retained the existing notification record.
- Offline/reconnect testing was attempted but is not certified: airplane mode also stalled MuMu's ADB connection, and a later host-control test could not retrieve the offline connectivity snapshot. The emulator's network was recovered using MuMu's documented host shell. Physical-device offline verification remains required.

The opt-in Rust `push::tests::firebase_real_device_transport` sends one real push only when explicitly run with **FIREBASE_SERVICE_ACCOUNT_FILE**, **NEXA_FCM_SMOKE_FIXTURE** and **NEXA_FCM_SMOKE_ID** set. Its device fixture is exported by the separately signed Android instrumentation test APK; it is not an exported component in the normal app. Keep fixtures in ignored test-output directories and do not print registration tokens.

## Supported scope

The current Android project supports Android 7.0/API 24 and later. FCM requires working Google Play services; other push providers are not implemented. Android Force stop, denied permissions, disabled channels, aggressive manufacturer battery controls, expired TTLs, and provider/network outages can prevent or delay alerts. iOS push is not implemented in this Android change. Physical-device and mobile-network validation is still required; no universal-delivery guarantee is made.

Primary references: [Android FCM client setup](https://firebase.google.com/docs/cloud-messaging/android/get-started), [native message handling](https://firebase.google.com/docs/cloud-messaging/android/receive-messages), [HTTP v1 sender authentication](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [offline lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan).
