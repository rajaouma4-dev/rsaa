> Historical local-load validation. GitHub push and subsequent live deployment findings are recorded in [LIVE_DEPLOYMENT_TEST.md](LIVE_DEPLOYMENT_TEST.md).

# Multi-user implementation and validation

3 November 2026. Target for this iteration: 100 lightweight clients without Android emulators. Source and builds are local; backend has not been deployed by this continuation.

## Measured result

- 100 real Rust WebRTC clients connected to the production Rust answerer/DataChannel handler on the local machine. All 100 channels were open before the chat burst.
- 300 online messages (three per user, fifty independent pairs), plus one message persisted while its recipient was offline.
- 301/301 saved, 301/301 received by the expected recipient and decrypted to the expected Bengali/plaintext using the production mobile Signal service in a Node harness. Replay of one identical send ID did not create another delivered message.
- The disconnected recipient reconnected and received/decrypted its queued offline envelope; ping/pong on its replacement channel passed.
- Connection setup across batches of four: 21,144 ms. Initial 300-message chat batch completed in 3,498 ms. Batch arrival observation bounds: median 2,185 ms, p95 2,622 ms. These are local batch observations, NOT one-way message latency or Render performance.
- Node orchestrator RSS was about 103 MB. This excludes the Rust child process and is NOT total test memory. Rust test runtime used two worker threads. No emulator was launched or installed for this test.
- Users/conversations were seeded in a disposable local SQLite database. ICE/signaling setup was bridged inside the test. Real DTLS/SCTP and production backend message validation/storage/receipts/forwarding were exercised. This does NOT certify signup/login bursts, public WSS/TLS, production key distribution, Render/Turso latency, mobile radios or Android UI responsiveness.
- The Node harness uses Node WebCrypto and isolated in-memory Keychain doubles. Native Android crypto was verified during the earlier two-device continuation, not by this 100-user test.

## Changes

### Rust backend

- Pending delivery lookup batches up to 100 connected recipients per database query, instead of querying every idle user separately. Each recipient receives at most four pending envelopes per pass. Four batch operations and four claim/forward operations per batch bound concurrency.
- Existing durable outbox, membership validation, post-commit saved ACK and idempotent message IDs remain in place.
- Local SQLite connections get their own busy timeout; setting it only during migration did not configure later connections. A real two-client test exposed this lock contention before the fix.
- Argon2 password hashing/verification runs in spawn_blocking with two global permits and a bounded wait, so expensive login work does not run directly on async networking threads.
- Presence is limited to conversation contacts and uses bounded forwarding. Previously the implementation broadcast to all live accounts even though comments suggested contact scope.
- One shared call router serves raw TLS, WSS and DataChannel signaling. A single-instance registry reserves both participants, validates state-changing signal participants, rejects ended-call replay, expires stale reservations, and limits new-invite bursts. Expensive network operations run outside its lock.
- Configured ICE URLs are used by the server answerer instead of always replacing them with hardcoded STUN URLs. This does not provide a complete ephemeral TURN credential service.
- WSS frame/message limits and header/handshake deadlines bound untrusted connection input.
- Optional TRUSTED_PROXY_CIDRS determines which proxy hops may supply X-Forwarded-For for auth rate limiting. Empty means ignore forwarded headers. Configure only actual trusted proxy networks; never blindly trust an arbitrary client header. A reverse proxy sharing one socket IP needs this configured to avoid unrelated users sharing one per-IP quota.

### Mobile

- Local message mutations are serialized per conversation; durable writes complete before publishing cache state. One hundred concurrent appends retained all messages. Merge/status updates cannot downgrade seen receipts.
- Ciphertext-only outgoing queues are persisted per signed-in UID, bounded by count/bytes and restored on login/resume. ACK deletion is durable; failed disk writes keep entries pending. Flushes are bounded and small envelopes get priority.
- Outgoing optimistic UI uses functional state updates. It shows Sending until saved ACK; enqueue failure is surfaced. An account switch while encrypting cannot enqueue into the replacement account's queue.
- Received messages are persisted before delivered/seen ACK. Selected-chat seen requires foreground state with no active call overlay. This reduces acknowledged-message loss but does not make ratchet and local-history commits one atomic transaction; see remaining limits.
- Receipt storage looks up the actual conversation by message ID/outbox rather than assuming the currently open conversation.
- Call completion no longer forces the peer online. Logout ends the current call, detaches the outgoing queue and clears transient presence/receipt routing.
- Busy/offline/missed/declined/failed outcomes are classified and displayed, state-changing call signals are bound to the active peer, ended call IDs are remembered, and repeated outgoing/accept actions are guarded across awaits. A cancelled getUserMedia result is stopped and cannot replace or reset a newer call; stale track callbacks are rejected before mutating state.
- Native APK version incremented to 1.0.1 (code 2). Metro uses at most two workers; final Gradle build uses one worker.

## Checks

- TypeScript semantic typecheck passed.
- Mobile storage concurrency, call multi-user, realtime reliability, low-latency framing/backpressure, E2EE security, provider upgrade and native-provider known-answer harnesses passed.
- Rust default test suite: 14 passed, 2 explicitly ignored integration tests. The ignored DataChannel test was run separately through the Node driver; the remote Turso fixture-writing test was not certified. An earlier default run attempted the existing remote test and failed DNS; it is now opt-in so local test runs do not accidentally mutate a live database.
- Rust optimized release build passed on Windows. This is a compile check, not a Linux/Render deployment certification.
- One hundred competing call reservations result in exactly one accepted reservation. This is a registry test, not 100 simultaneous audio/video calls.
- Batch fairness/online-recipient filtering and concurrent duplicate claim tests passed.

## Reproduce without emulators

From `mobile`:

```powershell
node test-storage-concurrency.cjs
node test-call-multi-user.cjs
node test-multi-user.cjs 10
node test-multi-user.cjs 100
npm run typecheck
```

The load driver caps user count at 100 and sets a five-minute child deadline. It creates only local ignored files under backend/target. It contacts no public service. Local UDP socket access must be available. The first harness attempt bound clients to loopback-only and failed ICE gathering; binding host addresses fixed the harness. Do not count those failed setup attempts as successful load tests.

From the repository root:

```powershell
cargo test --offline --manifest-path backend/Cargo.toml -j 2 -- --test-threads=2
cargo build --release --offline --manifest-path backend/Cargo.toml -j 1
```

## Final artifacts

Universal APK 1.0.1 (version code 2), 143,569,018 bytes:
`mobile/android/app/build/outputs/apk/release/app-universal-release.apk`

SHA-256: `c21412b4848389b185c60ed12ad6c9601e06035292e4d374d6957d9ebc50304b`.

All four ABI-specific builds plus Universal completed. APK v2 signature verification passed using the existing test signing configuration. This new APK was not installed or exercised on Android during this iteration, following the user's emulator constraint. Rust optimized Windows executable: `backend/target/release/nexa-messenger-server.exe`. Deploy the source through the existing Linux/Render build process; the Windows executable is not a Render binary.

## Remaining boundaries

This is a tested single-server-instance improvement for independent one-to-one users, not a zero-bug or unlimited-capacity guarantee. It is not group calling and does not add multi-replica routing. Multi-instance deployment needs shared call reservations/presence and session routing; multi-device policy is still incomplete.

Before public release, validate a separate staging Render/Turso environment at target traffic and duration, external ICE/TURN reachability, auth rate-limit proxy configuration, backend restart, mobile network switching and physical audio/video. Background FCM/lock-screen incoming calls, durable server call-attempt/missed-call history, call-fingerprint identity authentication, device lifecycle, credential rotation, encrypted local history and fully account-scoped E2EE keys remain open. The receiver still has a crash window between ratchet persistence and local-history persistence; durable receive journaling is a separate required reliability change. Large base64 media/history records still need a proper bounded local media store. The earlier gray emulator video is not resolved by this chat-load test.

Source changes have not been pushed or deployed. The new APK must be paired with the updated backend to obtain server call arbitration and delivery batching. Do not infer that the currently deployed public endpoint is running this code.
