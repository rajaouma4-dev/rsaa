# নেক্সা চ্যাট — সেটআপ গাইড (SETUP GUIDE)

এই নির্দেশিকাটি Nexa Chat ক্লায়েন্ট এবং ব্যাকএন্ড স্থানীয়ভাবে সেটআপ ও চালানোর জন্য বিস্তারিত বাংলা গাইড।

---

## ১. প্রয়োজনীয় সফটওয়্যার (Prerequisites)

১. **Node.js**: v18 বা তার বেশি (v22 প্রস্তাবিত)
২. **Rust & Cargo**: v1.75 বা তার বেশি (2021 edition)
৩. **Java Development Kit (JDK)**: JDK 17 (Eclipse Adoptium Temurin 17 প্রস্তাবিত)
৪. **Android SDK & Build Tools**: Android Studio সহ Platform 34/35 এবং Build Tools 36.0.0
৫. **Turso CLI**: ডাটাবেস ম্যানেজমেন্টের জন্য

---

## ২. ব্যাকএন্ড সেটআপ ও চালু করার নিয়ম (Backend Setup)

### ধাপ ১: পরিবেশ ভেরিয়েবল (.env) তৈরি করুন
`backend` ডিরেক্টরিতে যান এবং `.env.example` থেকে একটি `.env` ফাইল তৈরি করুন:
```bash
cd backend
cp .env.example .env
```
`.env` ফাইলে আপনার Turso তথ্য ও TLS পাথ কনফিগার করুন:
```env
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_auth_token_here
SIGNALING_HOST=0.0.0.0
SIGNALING_PORT=7443
TLS_CERT_PATH=certs/signaling.crt
TLS_KEY_PATH=certs/signaling.key
```

### ধাপ ২: ব্যাকএন্ড পরীক্ষা ও রান করুন
```bash
# টেস্ট রান করুন
cargo test

# প্রোডাকশন বিল্ড রান করুন
cargo run --release
```
সার্ভারটি চালু হলে এটি স্বয়ংক্রিয়ভাবে Turso ডাটাবেসে প্রয়োজনীয় ১৫টি টেবিল মাইগ্রেশন সম্পন্ন করবে এবং `7443` পোর্টে TLS 1.3 সিগন্যালিং লিসেনার চালু করবে।

---

## ৩. অ্যান্ড্রয়েড মোবাইল অ্যাপ সেটআপ ও বিল্ড (Mobile Setup)

### ধাপ ১: ডিপেন্ডেন্সি ইনস্টল করুন
```bash
cd mobile
npm install
```

### ধাপ ২: টাইপচেক ও ভ্যালিডেশন
```bash
npm run typecheck
npm run validate:syntax
npm run test:framing
```

### ধাপ ৩: লোকাল Android SDK পাথ সেট করুন
`mobile/android/local.properties` ফাইলটি চেক করুন:
```properties
sdk.dir=C\:\\Users\\abc\\AppData\\Local\\Android\\Sdk
```

### ধাপ ৪: APK বিল্ড করুন

**ডিবাগ APK বিল্ড করার কমান্ড:**
```bash
cd mobile/android
./gradlew assembleDebug
```
ফলাফল পাবেন: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`

**রিলিজ APK বিল্ড করার কমান্ড:**
```bash
cd mobile/android
./gradlew assembleRelease
```
ফলাফল পাবেন: `mobile/android/app/build/outputs/apk/release/app-release.apk`

---

## ৪. অ্যান্ড্রয়েড ফোনে APK ইন্সটল করার নিয়ম (Installation Guide)

### ADB-এর মাধ্যমে ইন্সটল:
১. ফোনে Developer Options এবং USB Debugging চালু করুন।
২. USB কেবল দিয়ে পিসির সাথে যুক্ত করুন।
৩. টার্মিনালে রান করুন:
```bash
adb install deliverables/NexaChat-debug.apk
# অথবা রিলিজ বিল্ডের জন্য:
adb install deliverables/NexaChat-release.apk
```

### সরাসরি ফোনে ইন্সটল:
১. `deliverables/NexaChat-release.apk` ফাইলটি ফোনে কপি করুন (Bluetooth, Google Drive বা USB-এর মাধ্যমে)।
২. ফাইল ম্যানেজার থেকে APK ফাইলটিতে ট্যাপ করুন।
৩. "Install Unknown Apps" অনুমতি দিন এবং ইনস্টল সম্পন্ন করুন।

---

## ৫. নিরাপত্তা সতর্কতা (Security Notes)

- কখনো Turso Auth Token বা সার্ভারের TLS Private Key মোবাইল অ্যাপের কোডে যুক্ত করবেন না।
- অ্যাপের ব্যাকএন্ড সিগন্যালিং সরাসরি কাস্টম বাইনারি TLS 1.3/TCP প্রোটোকল ব্যবহার করে; কোনো REST API ব্যবহার হয় না।
- E2EE প্রোডাকশনে সম্পূর্ণ কার্যকর করার জন্য অডিটেড সিগন্যাল প্রোটোকল লাইব্রেরি নিশ্চিত করুন।
