# Call delivery recovery — 4 November 2026

Version 1.0.6 (code 7). Tested against Render runtime revision `1d843f55d05d22a9cc4835b653da47df20c96cea`, confirmed through public health before updating the three existing MuMu test apps.

## Reproduced problem and fix

Before this change all three test apps were idle while recent call attempts displayed “User was on another call.” The server call registry renewed an answered reservation on ordinary connection pings, without knowing that an app had crashed/restarted and lost the actual media call. Reconnected idle clients could therefore keep abandoned calls busy indefinitely.

Authenticated clients now send actual `call_state` immediately after authentication and alongside heartbeat. Idle/ended reports null; active calls report their ID. Only the current registered connection may reconcile its authenticated UID. A mismatched answered reservation (or an abandoned outgoing reservation) is released and the peer receives call_end. An idle callee report cannot cancel a newly queued unanswered incoming invite. Ordinary pings cannot resurrect an expired call. Matching active reports preserve active calls.

Dialing now reconnects signaling before starting when needed, uses authenticated signaling, and fails call startup if neither signaling nor DataChannel accepts the invite. This avoids silently displaying an outgoing call whose invite was dropped. Existing call UI and chat UI are retained.

## Verification

- Rust suite: 19 passed, 2 opt-in tests skipped. New tests cover abandoned-call busy release, peer end notification, subsequent invite forwarding, active-call preservation, incoming-invite/heartbeat race, and expired-call non-resurrection.
- TypeScript typecheck, call/session recovery and multi-user call regressions passed. Mobile tests cover reconnect/heartbeat call-state reporting and explicit transport failure not leaving a phantom outgoing call.
- Release APK build and v2 signature verification passed (existing test signer). All three existing devices updated with data retained.
- Live A→C audio: caller displayed Ringing, C displayed Incoming audio call; accepting connected both. A timer reached 00:29 and C 00:34 during the test. While connected, B called A and received busy; A/C continued.
- A was force-stopped and relaunched without sending a normal end. It restored login; C left the abandoned call. B then called A: B displayed Ringing and A displayed Incoming audio call. Accepting connected both; B reached 00:19 before manual end. The old false-busy state did not block this redial.
- Live C→B video: caller displayed Ringing and B displayed Incoming video call. Accepting connected both; observed timers reached C 00:23 / B 00:29. C manually ended; B left the call. No graphics termination was observed in this recovery retest.
- Video surfaces still showed gray emulator camera input. Timers/connection are not evidence of real-picture or audible-content quality. Those remain unverified.

Both calling devices should install 1.0.6 to report actual call state; this is a coordinated client/server recovery change. No background push wakeup is added.

Universal test APK: `mobile/android/app/build/outputs/apk/release/app-universal-release.apk` (143,579,930 bytes).
SHA-256: `355f3025804c454b835f08bc008a023d7065976761a45b1b28e899ed6d8944e4`.
Screenshots of the live test are in ignored `backend/target/call-recovery-qa/`.
