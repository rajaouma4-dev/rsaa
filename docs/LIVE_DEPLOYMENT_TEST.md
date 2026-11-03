# Continuation — 4 November 2026

GitHub main and Render health matched `93e9fb560e7267f7fde65b4c74e30213d52b7684` during this continuation. Render returned `status: ok`. The unfinished 1.0.4 client account-isolation fix is local and is not part of that revision.

New 1.0.4 APK built successfully (four ABI splits plus universal) after using short native staging to avoid the Windows dependency prefab path failure. APK v2 signature verified. All three existing MuMu instances were updated with data retained and restored saved login.

Live updated-APK observations: C sent `QA104_C_to_B_20261104`; B displayed the decrypted text. B replied `QA104_B_reply_20261104`; C displayed it. B was force-stopped; C submitted `QA104_offline_B_20261104`; B and C were relaunched. Opening the C/B conversations showed all three exact texts and E2EE CONNECTED on both. These are synthetic QA strings. No audible-media or precise latency claim is made. Foreground relaunch recovery is not background notification delivery. A's prior mixed-account ratchet and live calls were not retested.

Separately, local 4-client real WebRTC integration passed 13/13 encrypted messages with offline recovery; this is not a Render or emulator UI result.

---

# Live push and three-emulator test

3 November 2026. Repository: https://github.com/rajaouma4-dev/rsaa . Live endpoint: https://rsaa.onrender.com/ .

- Application changes pushed at f811839. Backend CI passed.
- Android CI initially failed because the SDK setup action requested the discontinued tools package. Updated setup action/packages, aligned SDK/NDK to the project, used npm ci and the committed Cargo lockfile, and updated the SQL schema test for msg_type. The corrected Android CI run is still being monitored.
- Render health confirmed f811839, then e1cad29 and 27b5559 during successive deploys.
- Actual emulator tests found chat DataChannels retrying even though WSS login/ping/inbox worked. A valid SDP probe was rejected too. Health diagnostics showed one STUN and two TURN URLs. The server previously passed TURN entries without credentials. Fix 2429cad supplies configured TURN credentials or omits unusable TURN entries, retaining STUN. Render health subsequently confirmed 2429cad.
- APKs installed on exactly the three existing MuMu instances (ports 16384, 16416, 16448), preserving app data. Two isolated disposable accounts were created for A and C; B used the existing test account. Generated test credentials are only in ignored local build output, never committed.
- A called B, B accepted, both timers ran. C called B while A–B were connected. C showed User was on another call and A–B remained connected for at least 2m 41s. No audible-content guarantee is inferred from timers.
- Busy-history text overflow observed and fixed in 1.0.2.
- App startup erased saved login after a transient deploy/network failure on C. Version 1.0.3 preserves credentials during temporary failures and clears only explicit expired/revoked sessions; signaling retains the server error code. The Rust resume handler distinguishes SESSION_EXPIRED from AUTH_UNAVAILABLE. Policy/error-propagation tests and the backend suite pass.
- Final 1.0.3 installation and chat/offline/reconnect retest are in progress. Do not count the earlier failing chat connection as a successful chat test.

Server TURN credentials are configured through TURN_USERNAME and TURN_CREDENTIAL (TURN_PASSWORD accepted as an alias). The known client-embedded TURN credential migration/rotation remains a separate release task. No secret values are included in this report.
