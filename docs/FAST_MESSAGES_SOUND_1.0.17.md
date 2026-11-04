# Faster text, Discover and Moonlit Bubble — 1.0.17

5 November 2026. Android version code 18. Update the existing APK in place to retain the account and local messages.

## Changes

- Small, already-encrypted text envelopes use the authenticated TLS/WebSocket connection immediately. They no longer wait for WebRTC ICE to open. The same backend handler still validates the Signal V3 envelope, checks membership and persists ciphertext before returning `saved_ack`. Media stays on the bounded, chunked DataChannel path; ciphertext is never replaced by plaintext.
- Server delivery and recovery now include authenticated signaling clients, even when they have no DataChannel. Small messages and receipts use that connection; oversized media cannot overflow its frame limit. Existing DataChannel clients remain supported.
- Incoming encrypted data waits until the signed-in account's crypto/history restoration is ready. Early data is left unacknowledged for durable retry, and queued work is ignored after logout/account changes; fast TLS delivery cannot initialize or use the wrong account's ratchet store.
- Local media writes no longer hold the entire outgoing flush open and block later text. Per-message writes stay tracked, and unsent encrypted envelopes remain in the durable account-scoped outbox. A closing WebSocket no longer looks ready for sending.
- A real server acknowledgement updates the visible Sending/Sent state before the potentially large local queue rewrite completes. This changes display timing after a real ACK; it does not invent delivery or mark unsent messages as sent.
- Discover waits 150 ms after typing instead of 350 ms. Searches and key requests bypass queued avatar downloads; obsolete queued searches are replaced. Protocol request/response pairs stay serial to avoid ambiguous errors. Push registration takes priority over avatars. Repeated searches have an account-keyed, bounded 15-second cache, and stale query results are not displayed as current results.
- The supplied `03_Moonlit_Bubble.wav` is bundled unchanged as `res/raw/moonlit_bubble.wav`: valid stereo PCM WAV, 48 kHz, approximately 1.18 seconds.
- **You → Message notifications → Notification sound** selects Moonlit Bubble or sound off. Both choices preserve visible notifications. Audible and quiet Android channels are separate because Android channel sound behavior is immutable after creation. Their initial importance/block and vibration settings respect the previous message channel. The resource URI uses the stable raw resource name rather than a changing numeric resource ID.
- The selected channel is saved locally and registered for this installation on the server. The switch remains busy until the current preference has been acknowledged over the authenticated connection; offline/setup problems are shown rather than claiming the remote preference has synced. Old APKs retain `nexa_messages_v1` and their existing default sound.
- The system-first notification policy remains in place. There is no return to the eight-second native-renderer wait, no profile-photo download on the push critical path, and no new push content preview.

## Validation

- TypeScript semantic check and regression harnesses for text-without-ICE, media frame limits, search priority/coalescing, preserved error codes, closing connections, notification settings, reconnect, permission recovery, monotonic receipts, durable storage and foreground read acknowledgement passed.
- Rust: **31 passed**, 3 opt-in integrations skipped. Added TLS-only encrypted send/receipt, duplicate ID, recipient-hint/membership rejection, invalid ciphertext, media bounds, installation-owned sound selection and quiet-notification payload checks. Existing durable push/lease and bounded queue tests passed.
- Android builds and real-device observations are recorded in the live follow-up below. No claim is made that the earlier cold-emulator delivery misses or all Android/provider restrictions have been eliminated by this change.

References: [Android notification channels](https://developer.android.com/develop/ui/views/notifications/channels), [FCM sound/channel fields](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#androidnotification).
