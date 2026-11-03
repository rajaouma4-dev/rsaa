> Historical audit before the multi-user continuation. Several findings below have since been addressed; see [current validation](MULTI_USER_VALIDATION.md). Durable server missed-call history, background delivery, physical media quality and listed release security gaps remain open.

# Messenger logic audit and feature roadmap

Reviewed: 3 November 2026. Scope: mobile call service, app send/receive and lifecycle logic, local storage, call UI, Android manifest, Rust protocol/routing, delivery worker and database paths. This is a focused source review with isolated production-service reproductions, not a full security audit or a three-device/load certification. No application code was changed for this review.

## Current capabilities

- One-to-one Signal-encrypted text, image and voice-note messages over the server WebRTC DataChannel.
- Durable server message/outbox commit, saved/delivered/seen acknowledgements and same-ID retry.
- One-to-one WebRTC audio/video, camera toggle, screen share, quality control, timer and local call-history bubbles.
- Client-side busy response while already ringing or in a call. A third caller does not automatically replace the existing call.
- Foreground reconnection and contact-scoped presence.

## Reproduced logic problems

| Priority | Scenario and observation | Required change | Source |
|---|---|---|---|
| P0 | A-B active; C sends call_end with the same call ID: B transitions to ended even though C is not B's current peer. This reproduction assumes C knows the ID. | Check both current peer UID and call ID for every state-changing signal; authorize participants server-side. | mobile/src/services/callService.ts:977,1240; backend/src/webrtc_peer.rs:226 |
| P1 | A-B active; C calls B: busy is returned and A-B stays connected, but B creates no attempted-call record for C. | Persist a separate busy attempt; optionally show a non-disruptive in-call banner. | mobile/src/services/callService.ts:1003 |
| P1 | C receives busy: caller history becomes completed, duration 0. | Preserve terminal outcome and add busy/offline/unanswered/failed outcomes. | mobile/src/services/callService.ts:863,1210 |
| P1 | Caller receives call_reject with Missed call: caller history becomes completed. | Carry normalized outcome through end handling; do not overwrite previous state before classification. | mobile/src/services/callService.ts:1225 |
| P1 | An invite for a just-ended call arrives late: it starts incoming ringing again. | Retain bounded recently-ended call IDs; add invite expiry and sequence/version checks. | mobile/src/services/callService.ts:993 |
| P1 | Concurrent appendLocalMessage calls for one conversation retained only one of two distinct messages in the production storage module. | Serialize read/modify/write per conversation or use transactional local storage. | mobile/src/services/messageStore.ts:54 |

Reproductions used transpiled production modules with mocked React Native/media/storage and timers. They did not place a live third-user call. No claim that every theoretical race has been reproduced on Android is made.

## Other gaps found in source

1. **Busy UI:** endReason is not rendered. The caller sees a timer-like ended state rather than a clear busy/offline explanation (CallModal.tsx:122). Do not disclose whom the recipient is speaking with.
2. **Server call authority:** the server forwards arbitrary call payloads and has no durable call-session state machine, participant lock, transition validation or call-event history. Add atomic user reservation, TTL/lease cleanup and normalized events. This is necessary to make simultaneous A-B/C-B attempts consistent across devices/processes.
3. **Offline missed calls:** offline invites get a call_busy response with reason offline; no durable recipient call log or later missed-call notification is created. Persist the attempt with an expiry; never replay an expired invite as a fresh ring.
4. **Background delivery:** Android manifest has notification permission but no implemented FCM receive service/incoming-call notification flow was found in the app. Foreground AppState reconnect is not background wake delivery. Add push wakeup, Android call notifications and proper ongoing-call lifecycle integration. Push payloads should contain only opaque identifiers/minimal metadata, with chat content remaining E2EE/DataChannel.
5. **Call reliability:** no call-event delivery ACK/retry protocol; server may mark a dispatch sent even after ignoring a channel-send error. Add idempotent event IDs, limited retries, acknowledgements and explicit delivery-versus-ringing states.
6. **Call recovery:** disconnected gets a 15-second grace then ends; no dedicated call ICE-restart/recovery flow. Add a visible reconnecting state and bounded network-switch recovery. Concurrent outgoing taps/accept operations also need an operation guard across permission/media awaits.
7. **Ringtone/audio routing:** app-level ringtone/vibration, speaker selection, Bluetooth/wired-headset controls and explicit audio-focus/telephone-interruption handling were not found. Library default behavior is not a complete app call experience.
8. **Outgoing crash durability:** outboxRef is memory-only; process death loses the encrypted send queue. Persist ciphertext, recipient, conversation, ID and attempt state before indicating queued success; resume the same envelope after restart (App.tsx:246).
9. **Receipt truth:** optimistic outgoing messages begin as saved before a server saved ACK; errors are only logged. Add queued/sending/saved/delivered/seen/failed, a visible failure reason and manual retry (App.tsx:1056).
10. **Receive durability:** delivered ACK is sent after decryption but before local message persistence, and local persistence is debounced by 300ms. A crash can lose an acknowledged message while the ratchet has advanced. Persist message/deduplication state durably before ACK; treat receive processing as a crash-recovery workflow (App.tsx:379; messageStore.ts:32).
11. **Seen truth:** isCurrentChat checks selected conversation but not AppState, screen visibility or an open call overlay. A selected chat can be marked seen while the user is not viewing it. Track foreground and actual conversation visibility (App.tsx:364).
12. **Cross-conversation receipts:** receipt frames have only message ID; the client falls back to the currently selected conversation for disk status updates. An ACK for chat A while viewing B can leave A's stored status stale. Maintain a message-ID-to-conversation index or include canonical conversation ID (App.tsx:307).
13. **False presence:** every finished call marks its peer online, including offline/busy/failure paths. Presence should come from server liveness, not call completion (App.tsx:170).
14. **Account switch:** logout does not clear the in-memory outbox/presence or end the call; E2EE identity/session storage is not scoped by signed-in UID. Add complete lifecycle cleanup and account-scoped key/queue/cache storage. Do not treat this finding as proof of cross-account plaintext disclosure without further tests (App.tsx:1213; e2ee.ts).
15. **Multiple devices and server instances:** live maps use UID as the single key in one process. Add a deliberate single-device policy or UID/device/session fanout; for multiple backend instances, use coordinated presence, call locks and event routing (webrtc_peer.rs:21).
16. **Many-user performance:** delivery worker queries connected recipients serially each cycle, then sleeps a second; slow DB calls lengthen the cycle. Measure at target concurrency, use bounded parallel/event-driven dispatch and monitor queue age. No 100/1000/10000-user capacity is established by a config constant (webrtc_peer.rs:474).
17. **History:** local storage trims at 500 messages; server history has a before cursor but mobile openChat requests only the initial page. Add upward pagination, efficient encrypted local persistence and clear restore behavior. Inbox also needs pagination beyond the server's current limit.
18. **Media limits:** images/audio are base64 embedded in JSON and full conversation records, with a 10MB backend ciphertext limit. Add client byte/duration limits, resize/compress feedback, cancellation, resumable transfer and bounded media storage. Preserve content encryption.
19. **Security release gaps:** local decrypted history/media in AsyncStorage, client TURN provider credential, unauthenticated peer identity for call negotiation, limited prekey lifecycle and missing complete device registration/recovery remain. See BUILD_STATUS.md.
20. **Real quality:** gray video and audible quality still require known camera/audio input and physical-device tests. Render FPS alone is not evidence of useful camera content or low conversational latency.

## Product additions after reliability

- Call waiting banner with Reject or End current and answer; one active media call by default. Optional Call me back request.
- Calls tab: missed/incoming/outgoing/busy, grouped repeated attempts, callback and unread badge.
- Reply/quote, reactions, message edit and delete-for-everyone with authenticated versioned events and defined offline behavior.
- Typing/recording indicator with short expiry, throttling and privacy settings.
- Chat search, pin/archive, drafts, notification mute and mark unread.
- Block/report and message requests with server enforcement; rate limits for invites and abuse handling.
- Active/last-seen/read-receipt privacy controls enforced by the server.
- Voice playback speed, seeking, proximity/earpiece behavior and reliable playback completion.
- File/document/video sharing with size/progress/resume controls.
- Optional group chat and group calls as a separate architecture project: membership, group key lifecycle, media routing/SFU, permissions and moderation. Current code is one-to-one.
- Accessibility labels, larger text support, Bengali localization and reliable notification deep links.

## Recommended implementation order

1. Peer authorization and account isolation; durable incoming/outgoing messages and truthful receipts.
2. Call outcomes, busy UX, late-event rejection, server call lock, offline call history.
3. Push/lock-screen notifications, ongoing call lifecycle and audio routing.
4. Network-switch recovery, physical-device quality and many-user tests; complete release security gaps.
5. Conversation conveniences; group features only after the one-to-one path is reliable.

## Required scenario matrix

A-B connected while C calls A/B; A and B call each other simultaneously; two callers reach B at once; cancel versus accept race; duplicate/out-of-order/expired invite; busy/offline/declined/unanswered outcomes; app background/process death/restart; Wi-Fi/mobile switch; server restart; logout/login to another account; two devices per user; simultaneous sends/appends; ACK loss and storage failure; unread/seen with screen locked or call overlay; concurrent media and text; blocked caller; target-user load tests.

## Platform references

Android CallStyle: https://developer.android.com/reference/android/app/Notification.CallStyle
Firebase background message reception: https://firebase.google.com/docs/cloud-messaging/android/receive-messages
These document platform facilities, not proof that this project implements them or that a push notification is guaranteed under every device state.
