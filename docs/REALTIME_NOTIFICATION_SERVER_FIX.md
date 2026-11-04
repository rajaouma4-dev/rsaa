# System-first notification delivery

5 November 2026. Server change; compatible with the existing 1.0.16 Android APK.

## Problem and resulting behavior

The rich notification path first sent a data-only push and waited eight seconds for a native receipt. The unopened Android 15 emulator did not handle that push; a later system fallback finally displayed the alert. A still-valid 90-second foreground lease could also defer a message after a process disappeared without sending its background state. A three-second polling loop and whole-batch completion added more latency.

Every first FCM request now contains the high-priority, private system notification plus chat routing data. Play services/Android can display it without starting the messenger process. Native rendering, receipt delivery and profile-photo downloads are no longer prerequisites. Background system cards show the sender/count without a profile-photo banner. Existing native rendering still works for live app deliveries. A device in the foreground suppresses its alert locally; an old server foreground lease no longer hides the push job.

## Queue correctness and bounded work

- A committed message wakes its process's worker immediately. A one-second recovery sweep handles other processes, retries, restarts and expired leases.
- Selection groups by installation/conversation before taking a 128-conversation batch. A hot chat contributes one current count, rather than occupying the batch with many individual messages.
- At most 32 provider sends run concurrently. Each completion frees a slot; slow requests do not hold an entire batch before new work can start.
- Transactional database leases serialize each installation/conversation across workers. A send completes only messages up to its captured sequence; a new arrival remains pending. A late response from an expired lease cannot finish or unlock its replacement.
- New messages cannot bypass a provider's Retry-After delay for the same conversation. Positive jitter spreads retries; network errors remain durable. Token/account changes invalidate the old lease, and stale token callbacks cannot complete new-token work.
- Added indexes support pending-device lookups and unread counts. Additive migration retains message/account data and legacy receipt compatibility.
- `/health` exposes `push.mode=system_first`, worker limits and process-local counts for FCM acceptance, retries, invalid tokens and state errors. FCM acceptance is not a device-delivery receipt.

## Validation

Local Rust suite, including the final health-counter addition: **28 passed, 3 opt-in integrations skipped**. New tests cover first-message wakeup despite a foreground lease, twelve concurrent claims with exactly one winner, newer arrivals, stale callbacks, crash/restart recovery, provider backoff, token rotation, account changes and legacy receipt ownership.

Queue fixture: **2,308 messages across 160 devices**, including one 400-message hot chat, completed in 160 coalesced dispatches in approximately 2.1 seconds on local SQLite. The first bounded batch covered 128 distinct devices; the remaining 32 followed. This tests queue behavior, not Firebase throughput, mobile delivery latency or a production capacity of hundreds of thousands of users.

## Operational scope

No new APK is required for this server policy. The new source must be pushed and the backend redeployed before the live app uses it. Additive tables/indexes are created on startup. A rollback can keep these unused additions.

The repository's Render blueprint specifies `plan: free`; this does not independently establish the live service's billing plan. Render Free services can sleep after 15 minutes of inactivity and take about a minute to restart. An always-on deployment is required for an always-available service; no paid-plan change is included. See [Render Free limitations](https://render.com/docs/free).

Millions of users, all devices, future Android versions and zero failures are not certified by these tests. End-to-end capacity also depends on hosting, the database, Firebase quota, networking and the rest of the messaging service. Android permission/channel settings, Force stop and provider restrictions still apply. Primary guidance: [FCM Android priority/delegation](https://firebase.google.com/docs/cloud-messaging/android-message-priority), [FCM scale and retries](https://firebase.google.com/docs/cloud-messaging/scale-fcm).
