# Nexa Chat — বাংলা Setup Guide

এটি React Native Android + Rust + WebRTC DataChannel + Turso ভিত্তিক **উন্নত source starter**। এতে account registration/login, user search, conversation creation/list/history, profile update, TLS signaling, WebRTC peer setup, server-side message/outbox storage এবং presence update-এর source রয়েছে। কিন্তু এটি এখনো production-ready secure messenger নয় এবং এই ZIP-এর মধ্যে installable APK নেই।

## বর্তমান বাস্তব অবস্থা

- React Native UI-তে login/register, inbox, user search, profile এবং conversation screen আছে।
- `DEMO_MODE: true` থাকলে local preview চলে; কোনো real account/server তৈরি হয় না।
- `DEMO_MODE: false` করে server config বসালে mobile client-এর register/login, inbox fetch, user search, profile update, conversation create এবং WebRTC negotiation path চালু করা যায়—কিন্তু এই workspace-এ এগুলো real server বা দুই Android ফোনে test করা হয়নি।
- Live message sending ইচ্ছাকৃতভাবে বন্ধ। কারণ vetted Signal Protocol/E2EE key setup এই source-এ integrate করা হয়নি। Server-side `ciphertext` field থাকলেই payload E2EE হয়ে যায় না।
- E2EE না হওয়া পর্যন্ত কোনো real/private message পাঠানোর জন্য এটি deploy করবেন না।
- `scripts/check-project.sh` local SQL ও TypeScript syntax regression test চালায়। এটি Rust compile বা Android APK build-এর বিকল্প নয়।

## ১. Turso সেটআপ

1. `https://app.turso.tech` হলো dashboard, database endpoint নয়। সেখানে একটি database তৈরি করুন।
2. Database-এর connection URL ও auth token নিন। URL সাধারণত `libsql://<database>-<organization>.turso.io` হয়।
3. `backend/.env.example` কপি করে `backend/.env` বানান।
4. `TURSO_DATABASE_URL` এবং `TURSO_AUTH_TOKEN` কেবল `backend/.env`-এ বসান। Token কখনো React Native source, APK, GitHub public repo বা chat message-এ দেবেন না।
5. Rust server startup-এ `Store::migrate()` schema ও পুরোনো outbox retry-column migration চালায়। আলাদা করে SQL চালানো সাধারণত প্রয়োজন নেই। `backend/migrations/0001_init.sql` manual reference হিসেবে রাখা হয়েছে।

উদাহরণ:

```env
TURSO_DATABASE_URL=libsql://your-db-your-org.turso.io
TURSO_AUTH_TOKEN=your_actual_token
```

`https://app.turso.tech` বা dashboard URL `TURSO_DATABASE_URL` হিসেবে দেবেন না। Credential ভুল হলে server startup-এই error দেবে।

## ২. Rust server চালানো

প্রয়োজন: Rust stable toolchain, OpenSSL, public DNS hostname, সেই hostname-এর জন্য valid TLS certificate এবং Turso credentials।

```bash
cd backend
cp .env.example .env
# backend/.env-এ Turso URL/token ও certificate path দিন
cargo generate-lockfile
cargo check
cargo test
cargo run --release
```

Server `0.0.0.0:7443`-এ **raw TLS/TCP signaling** চালায়; কোনো HTTP REST endpoint নেই। বর্তমানে signaling frame newline-delimited JSON—এটি custom framed signaling, binary CBOR protocol নয়।

TLS certificate:

- Production/staging-এ public trusted CA-এর certificate ব্যবহার করুন এবং certificate renew/rotation নিশ্চিত করুন।
- Development self-signed certificate Android-এ স্বয়ংক্রিয়ভাবে trusted হবে না; `tlsCheckValidity` সক্রিয় থাকায় সেটি bypass করার চেষ্টা করবেন না।
- Mobile client-এ `react-native-tcp-socket.connectTLS()` দিয়ে TLS connection তৈরি হয়; TLS certificate validity check-এর সঙ্গে leaf certificate-এর SHA-256 fingerprint pin check আছে। `mobile/src/config.ts`-এ primary ও backup fingerprint বসাতে হবে। এটি SPKI pin নয়; certificate renew করার আগে নতুন backup fingerprint release করতে হবে। Pin mismatch হলে client connection বন্ধ করে।

`MAX_SIGNAL_CONNECTIONS` দিয়ে সর্বোচ্চ concurrent signaling connection সীমিত হয়; TLS handshake ১০ সেকেন্ডে timeout হয়। Auth attempt-এ per-IP rate limiter আছে।

## ৩. Android app সেটআপ

প্রয়োজন:

- Node.js 22.13+
- JDK 17
- Android Studio/Android SDK Platform 37 এবং সংশ্লিষ্ট Build Tools
- Android device অথবা emulator

```bash
bash scripts/bootstrap-native.sh
cd mobile
npm install
npm run validate:syntax
npx react-native doctor
```

`mobile/src/config.ts`-এ server hostname বসান:

```ts
DEMO_MODE: false,
SIGNALING_HOST: 'chat.example.com',
SIGNALING_PORT: 7443,
TLS_CERT_SHA256_PINS: ['PRIMARY_64_HEX_SHA256', 'BACKUP_64_HEX_SHA256'],
```

এছাড়া production STUN/TURN server configure করতে হবে। বর্তমানে public STUN শুধু development default; TURN credential provisioning ও mobile/server-এ ephemeral TURN configuration delivery সম্পূর্ণ নয়। STUN একা সব cellular network/CGNAT-এ connection নিশ্চিত করে না।

**নোট:** `DEMO_MODE: false` করলে live account/search/profile/connection path খোলে; live chat message পাঠানোর permission খোলে না। E2EE integration ছাড়া message composer ইচ্ছাকৃতভাবে disabled থাকবে।

## ৪. APK build

```bash
bash scripts/check-project.sh
bash scripts/build-android.sh
```

Output সাধারণত:

```text
mobile/android/app/build/outputs/apk/release/app-release.apk
```

Build script Node, JDK 17, SDK Platform 37 ও release output path যাচাই করে। Native Android shell bootstrap-এর সময় network দরকার, কারণ React Native CLI ও npm packages download হয়।

Release signing:

- Template-এর release build automatically আপনার production keystore দিয়ে signed নয়। Distribution-এর আগে নিজের Android signing keystore configure করুন।
- Build-এর পর APK SHA-256 ও size script print করে।
- ৬ MB APK নিশ্চিত নয়। React Native + WebRTC native library-এর সঙ্গে ৬ MB target খুব কঠিন; প্রকৃত build measurement ছাড়া এমন প্রতিশ্রুতি দেওয়া যাবে না। ABI-specific build/split করলে download size কমতে পারে।

## ৫. Message architecture

```text
React Native A
   │ TLS/TCP signaling + WebRTC DataChannel (DTLS)
   ▼
Rust WebRTC peer
   │ validate authenticated sender + conversation membership
   │ transaction: messages + durable outbox
   ▼
Turso/libSQL
   │ retry worker, recipient's active DataChannel
   ▼
React Native B
```

A ও B সরাসরি P2P-তে যুক্ত নয়। দুজনেই server-এর সঙ্গে আলাদা WebRTC peer connection রাখে। Server message save করে তারপর B-কে forward করে। `SAVED_ACK` database transaction commit-এর পরে পাঠানো হয়। Outbox pending message retry করে; receiver-এর `DELIVERED_ACK` না পাওয়া পর্যন্ত retry হয়। বর্তমান mobile client E2EE decrypt ও local durable save করতে পারে না, তাই ACK পাঠায় না।

## ৬. Database ও secret management

- Argon2id password hashing server-এ হয়; password TLS signaling-এর মধ্যে server-এ পৌঁছায়। এখানে OPAQUE implement করা হয়নি।
- Session token database-এ SHA-256 hash হিসেবে সংরক্ষিত হয়; raw token একবার login response-এ client পায়। Live token `react-native-keychain` দিয়ে Android Keystore/iOS Keychain-backed secure storage-এ রাখা হয় এবং app restart-এর পরে TLS signaling-এর `resume` frame দিয়ে session restore করার code আছে; Android runtime test এখনো হয়নি।
- Database connection-এ `foreign_keys=ON`, `synchronous=FULL`, `busy_timeout=5000` PRAGMA সেট হয়।
- Message ও outbox একই transaction-এ save হয়। Backup, PITR এবং restore automation deployment-এ configure করতে হবে।
- Turso `libsql` remote connector server থেকে Turso-তে remote HTTP(S)-ভিত্তিক protocol ব্যবহার করে। Android app সরাসরি HTTP REST API call করে না। “কোনো HTTP কোথাও চলবে না” এমন কঠোর শর্ত হলে Turso remote connector সেই শর্ত পূরণ করে না।

## ৭. এখনও production release blocker

1. Mobile ও backend-এ audited/independently reviewed E2EE library, identity/prekey relay, key storage, safety-number/identity-change handling integrate করা হয়নি।
2. Rust code এই workspace-এ compile/test করা যায়নি; Rust/Cargo toolchain নেই। CI workflow-তে `cargo check` ও `cargo test` job আছে।
3. Android Gradle release APK build হয়নি; Android SDK/Gradle wrapper নেই। GitHub Actions বা Android SDK-সহ local machine-এ build করতে হবে।
4. Live Turso credentials, trusted TLS certificate, domain, firewall এবং TURN deployment দেওয়া হয়নি।
5. Certificate fingerprint pin check আছে, তবে production primary/backup pin আপনার server certificate অনুযায়ী configure ও rotation test করতে হবে। Device secure token storage, push notifications, multi-device, Redis/NATS multi-node routing ও full offline reconciliation production-ready নয়।
6. SDUI renderer-এ component allowlist ও schema validation আছে; signature verification fail-closed, কিন্তু live signed config endpoint ও key rotation implement হয়নি। Arbitrary JS/code কখনো server থেকে চালানো হবে না।
7. Two-device Wi-Fi/mobile/CGNAT/offline testing, penetration test, backup restore drill এবং independent security review বাকি।

এই starter-কে development foundation হিসেবে নিন, production secure messenger হিসেবে এখনই ব্যবহার করবেন না।
