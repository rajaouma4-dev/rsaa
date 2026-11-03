# Performance verification

Chat content remains Signal-encrypted and uses the reliable WebRTC DataChannel. The channel is unordered so packet loss in one media chunk does not impose application-level ordering on later text. Chunk indices reconstruct media; message IDs and monotonic receipts handle retries and reordering.

New messages now use one parameterized conditional INSERT with an AFTER INSERT outbox trigger. Authorization, one-to-one membership, quota and durable enqueue are atomic. Saved ACK is emitted after the statement completes. Receipts use one UPDATE with an outbox completion trigger. Tests inject outbox failure to verify rollback.

Outgoing media uses bounded queues, text priority, native buffer backpressure and bounded server forwarding. Voice notes and images retain the same encrypted payload protocol. Signal uses the native crypto provider; AES/HMAC known-answer tests run before initialization. Existing identity pins and ratchets remain in Keychain. Repeated identical public-identity writes are avoided.

Default video starts with the SD bitrate cap; HD remains selectable. Opus preferences use mono, FEC and DTX, with media packet-duration attributes rather than duplicate fmtp entries.

## Windows native build

For deeply nested Windows checkouts, choose a short writable cache directory and run from mobile/android:

```powershell
.\gradlew.bat assembleRelease --console=plain --max-workers=2 '-PnexaNativeBuildDir=C:\nxa-build' '-PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86,x86_64'
```

The cache contains generated native objects; project source is not moved. Windows settings do not need changing. APKs use the project's existing test signing configuration, which must be replaced for a public release.

## Deployment and measurements

The public health response includes build_revision from RENDER_GIT_COMMIT. Confirm the expected commit before comparing live timings. UI-automation arrival bounds include UI dump overhead and are not precise one-way network latency. Real audio/video quality still needs validation on physical devices and representative mobile networks.


## 3 November continuation

Native AES/HMAC self-tests passed in both Android emulators. The production E2EE service now serializes initialization, resumes partial provisioning without replacing identity, rejects failed identity writes, and caches a session only after its durable write succeeds. `mobile/test-e2ee-upgrade.cjs` exercises compatibility with the previous JavaScript provider, restart with persisted ratchet state, tampering/replay, and injected storage interruption.

Four mixed-version text tests arrived, with UI observation bounds of 4.56–4.69 seconds. A mixed-version audio call lasted 65 seconds; a final-build video call lasted 109 seconds with approximately 24 FPS renderer logs. Both were manually ended. Video remains gray in local and remote previews, so real-picture quality is unresolved. A 45-second voice note and HD image fixture arrived on the final APKs. Audio quality was not verified by listening. These observations do not establish a speedup factor or one-way media latency. See `BUILD_STATUS.md` for exact checks and production gaps.
