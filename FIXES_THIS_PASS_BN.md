# Nexa Chat — এই আপডেটে করা সংশোধন

1. **TLS signaling API ঠিক করা হয়েছে।** `react-native-tcp-socket.createConnection({ tls: true })` বদলে documented `connectTLS()` ব্যবহার করা হয়েছে। TLS handshake সফল হওয়ার পর peer certificate নেওয়া এবং configured SHA-256 leaf fingerprint মিলিয়ে দেখা হয়।
2. **App compile-time import bug ঠিক করা হয়েছে।** `App.tsx`-এ theme-এর `C` palette import যোগ করা হয়েছে; আগে root screen-এ `C.bg` ব্যবহার হলেও import অনুপস্থিত ছিল।
3. **Live session storage ordering ঠিক করা হয়েছে।** Authenticated state প্রকাশের আগে token `react-native-keychain`-এ save হয়, যাতে secure storage write fail করলে UI অর্ধেক লগইন অবস্থায় না থাকে।
4. **Logout cleanup শক্ত করা হয়েছে।** Secure storage cleanup ব্যর্থ হলেও UI local session clear করে এবং ব্যবহারকারীকে জানায়।
5. **TCP UTF-8 framing bug ঠিক করা হয়েছে।** TCP packet boundary-তে বাংলা UTF-8 character split হলেও frame corruption হয় না; complete newline frame হওয়ার পরেই JSON decode হয়।
6. **Regression checks বাড়ানো হয়েছে।** TLS API, certificate pin check, Keychain session storage, session resume এবং E2EE fail-closed invariant test-এ যোগ হয়েছে।

## এই আপডেটেও যা অসম্পূর্ণ

- Signal Protocol E2EE / device identity / prekey lifecycle এখনো integrate হয়নি; তাই live message relay ইচ্ছাকৃতভাবে বন্ধ।
- Rust code `cargo check/test` করা যায়নি—এই environment-এ Rust/Cargo নেই।
- Android dependency installation, TypeScript semantic typecheck, Gradle release build, APK install এবং two-device WebRTC test করা যায়নি—Android SDK/Gradle/ADB নেই।
- Real Turso URL/token, server DNS/TLS certificate fingerprint, TURN credentials ও production signing key সরবরাহ করা হয়নি।
- Turso remote `libsql` transport server-side; remote Turso connection HTTP(S)-ভিত্তিক হলেও Android app থেকে কোনো REST/HTTP API call করা হয় না।

এই ZIP হলো updated development source; built APK বা audited production messenger নয়।
