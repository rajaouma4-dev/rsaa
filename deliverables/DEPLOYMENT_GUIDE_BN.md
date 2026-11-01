# নেক্সা চ্যাট — প্রোডাকশন ডিপ্লয়মেন্ট গাইড (DEPLOYMENT GUIDE)

এই নির্দেশিকাটি প্রোডাকশন সার্ভারে (Linux VPS বা ক্লাউড ক্লাস্টার) Nexa Chat ব্যাকএন্ড এবং Coturn (STUN/TURN) স্থাপন করার সম্পূর্ণ বাংলা গাইড।

---

## ১. আর্কিটেকচার ওভারভিউ

- **Mobile Client**: Bare React Native (Android)
- **Signaling Gateway**: Rust Tokio সার্ভার (পোর্ট `7443` - Raw TLS 1.3 TCP)
- **Data Transport**: WebRTC DataChannel (Client <-> Rust Server <-> Client, Star Topology)
- **Database**: Turso (libSQL Cloud Database, শুধুমাত্র ব্যাকএন্ড থেকে সুরক্ষিত এক্সেস)
- **NAT Traversal**: Coturn STUN/TURN সার্ভার (পোর্ট `3478` UDP/TCP, `5349` TLS, `49152-65535` UDP Relay)

---

## ২. ফায়ারওয়াল পোর্ট কনফিগারেশন (Firewall Rules)

সার্ভারে নিম্নলিখিত পোর্টগুলো উন্মুক্ত রাখুন (UFW বা Cloud Security Group):

| পোর্ট | প্রোটোকল | সেবা (Service) | উদ্দেশ্য |
| :--- | :--- | :--- | :--- |
| **7443** | TCP | Nexa Signaling | কাস্টম TLS 1.3 মোবাইল সিগন্যালিং |
| **3478** | UDP/TCP | Coturn STUN/TURN | প্রাথমিক NAT ট্রাভার্সাল |
| **5349** | TCP/UDP | Coturn TURNS | এনক্রিপ্টেড TLS TURN রিলে |
| **49152-65535** | UDP | WebRTC Media/Data | মিডিয়া এবং ডাটা চ্যানেল রিলে পোর্ট রেঞ্জ |

---

## ৩. ডকার কম্পোজ দিয়ে ডিপ্লয়মেন্ট (Docker Compose Deployment)

### ধাপ ১: প্রজেক্ট ক্লোন ও প্রস্তুত করা
সার্ভারে কোড আপলোড করুন:
```bash
git clone <repo-url> nexachat
cd nexachat
```

### ধাপ ২: TLS সার্টিফিকেট প্রস্তুত করা
`certs` ডিরেক্টরি তৈরি করুন এবং আপনার ভেরিফাইড ডোমেনের SSL সার্টিফিকেট রাখুন:
```bash
mkdir -p certs
# certs/signaling.crt -> ফুল চেইন সার্টিফিকেট
# certs/signaling.key -> প্রাইভেট কি
```

### ধাপ ৩: পরিবেশ ভেরিয়েবল সেট করা
সার্ভারের রুট ডিরেক্টরিতে `.env` তৈরি করুন:
```env
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your_production_turso_auth_token
SIGNALING_HOST=0.0.0.0
SIGNALING_PORT=7443
TURN_URL=turn:turn.yourdomain.com:3478
TURN_USERNAME=nexa
TURN_PASSWORD=your_secure_password
```

### ধাপ ৪: Coturn কনফিগারেশন আপডেট
`turnserver.conf` ফাইলের ডোমেন ও ক্রেডেনশিয়াল আপডেট করুন:
```conf
realm=turn.yourdomain.com
server-name=turn.yourdomain.com
user=nexa:your_secure_password
```

### ধাপ ৫: সার্ভিস চালু করা
```bash
docker compose up -d --build
```

সার্ভিসের লগ দেখতে:
```bash
docker compose logs -f nexa-backend
```

---

## ৪. ব্যাকআপ ও পুনরুদ্ধার নির্দেশিকা (Backup & Restore)

### ১. Turso ডাটাবেস ব্যাকআপ:
Turso একটি ম্যানেজড ক্লাউড ডাটাবেস সার্ভিস। টার্মিনাল থেকে ব্যাকআপ ডাম্প নিতে:
```bash
# Turso CLI ব্যবহার করে ডাটা এক্সপোর্ট
turso db dump nexachat > nexachat_backup_$(date +%F).sql
```

### ২. ডাটাবেস পুনরুদ্ধার (Restore):
নতুন ডাটাবেসে ব্যাকআপ রিস্টোর করতে:
```bash
turso db create nexachat-restored --from-dump nexachat_backup_2026-10-31.sql
```

---

## ৫. প্রোডাকশন মেইনটেনেন্স ও রানিং চেকলিস্ট

১. **TLS পিনিং ভ্যালিডেশন**: মোবাইল ক্লায়েন্টে প্রোডাকশন সার্টিফিকেটের SHA-256 ফিঙ্গারপ্রিন্ট পিন আপডেট রাখুন।
২. **সার্ভার মেমরি মনিটরিং**: লাইভ WebRTC পিয়ার এবং ডাটা চ্যানেল যাতে মেমরি লিক না করে তা `systemd` বা ডকার মেমরি লিমিটের মাধ্যমে সীমাবদ্ধ রাখুন।
৩. **সিক্রেট প্রটেকশন**: `.env` ফাইল কখনো গিট রিপোজিটরিতে পুশ করবেন না।
