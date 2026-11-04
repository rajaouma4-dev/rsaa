//! Durable, privacy-preserving FCM wakeups. Plaintext never enters a push payload.
use anyhow::{Context, Result};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{env, sync::{Arc, atomic::{AtomicU64, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::Mutex;
use crate::db::Store;

fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64 }
fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }

static ACCEPTED: AtomicU64 = AtomicU64::new(0);
static RETRIES: AtomicU64 = AtomicU64::new(0);
static INVALID: AtomicU64 = AtomicU64::new(0);
static STATE_ERRORS: AtomicU64 = AtomicU64::new(0);

pub fn health() -> serde_json::Value {
    json!({"mode":"system_first","recovery_poll_ms":1000,"max_in_flight":32,
        "fcm_accepted":ACCEPTED.load(Ordering::Relaxed),"retries":RETRIES.load(Ordering::Relaxed),
        "invalid_tokens":INVALID.load(Ordering::Relaxed),"state_errors":STATE_ERRORS.load(Ordering::Relaxed)})
}

#[derive(Deserialize)]
struct Credentials { project_id: String, client_email: String, private_key: String }
#[derive(Serialize)]
struct Claims<'a> { iss: &'a str, scope: &'a str, aud: &'a str, iat: i64, exp: i64 }
#[derive(Deserialize)]
struct AccessToken { access_token: String, expires_in: i64 }

pub struct PushSender {
    credentials: Credentials,
    key: EncodingKey,
    http: reqwest::Client,
    access: Mutex<(String, i64)>,
}
#[derive(Clone)]
struct Job { message_id: String, installation_id: String, uid: String, conversation_id: String, token: String,
    sender_name: String, unread_count: i64, unread_senders: i64, avatar_version: Option<String>,
    native_renderer: bool, native_sent_at: i64, sequence: i64, claim_id: String }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationReceipt { installation_id: String, uid: String, message_id: String, receipt_key: String }
enum Outcome { Sent, InvalidToken, Retry(i64) }

impl PushSender {
    pub fn from_env() -> Result<Option<Arc<Self>>> {
        let raw = if let Some(raw) = env::var("FIREBASE_SERVICE_ACCOUNT_JSON").ok().filter(|v|!v.trim().is_empty()) { raw }
        else if let Some(path) = env::var("FIREBASE_SERVICE_ACCOUNT_FILE").ok().filter(|v|!v.trim().is_empty()) { std::fs::read_to_string(path).context("read Firebase server credentials")? }
        else { return Ok(None) };
        let credentials: Credentials = serde_json::from_str(&raw).context("invalid Firebase server credential JSON")?;
        anyhow::ensure!(!credentials.project_id.is_empty() && credentials.project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "invalid Firebase project ID");
        let key = EncodingKey::from_rsa_pem(credentials.private_key.as_bytes()).context("invalid Firebase private key")?;
        let http = reqwest::Client::builder().timeout(Duration::from_secs(12)).build()?;
        Ok(Some(Arc::new(Self { credentials, key, http, access: Mutex::new((String::new(),0)) })))
    }

    async fn access_token(&self) -> Result<String> {
        let mut cached = self.access.lock().await;
        if cached.1 > now() + 60 { return Ok(cached.0.clone()) }
        let claims = Claims { iss: &self.credentials.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token", iat: now(), exp: now()+3600 };
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &self.key)?;
        let response = self.http.post("https://oauth2.googleapis.com/token").form(&[
            ("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion",assertion.as_str())
        ]).send().await?;
        // Never log request bodies, tokens, keys or Google error bodies.
        anyhow::ensure!(response.status().is_success(), "Firebase OAuth request rejected ({})", response.status());
        let value: AccessToken = response.json().await?;
        *cached = (value.access_token.clone(), now()+value.expires_in.min(3600));
        Ok(value.access_token)
    }

    async fn send(&self, job: &Job) -> Result<Outcome> {
        let bearer = self.access_token().await?;
        let response = self.http.post(format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", self.credentials.project_id))
            .bearer_auth(bearer).json(&payload(job)).send().await?;
        let status = response.status();
        if status.is_success() { return Ok(Outcome::Sent) }
        let retry_after = response.headers().get(reqwest::header::RETRY_AFTER)
            .and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<i64>().ok()).unwrap_or(60).clamp(60,86400);
        if status == reqwest::StatusCode::UNAUTHORIZED { self.access.lock().await.1 = 0; }
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        let unregistered = body.pointer("/error/details").and_then(|v|v.as_array()).is_some_and(|a|
            a.iter().any(|v|v.get("errorCode").and_then(|v|v.as_str()) == Some("UNREGISTERED")));
        tracing::warn!(http_status = status.as_u16(), "FCM request rejected");
        Ok(if unregistered { Outcome::InvalidToken } else { Outcome::Retry(retry_after) })
    }
}

fn payload(job: &Job) -> serde_json::Value {
    // Notification + data lets Android/Play services display while the process
    // is absent. Foreground delivery still goes through our native service.
    // Only identity metadata and unread counts leave the server. Never include
    // message plaintext, media, ciphertext or encryption keys in notifications.
    let count=job.unread_count.clamp(1,9999);
    let title=job.sender_name.chars().filter(|c| !c.is_control()).take(80).collect::<String>();
    let title=if title.trim().is_empty() { "Nexa Chat".to_owned() } else {title};
    let mut body=if count==1 {"1 new message".to_owned()} else {format!("{count} new messages")};
    let people=job.unread_senders.clamp(1,9999);
    if people>1 {body.push_str(&format!(" · {people} people messaging you"));}
    let result=json!({"message":{"token":job.token,"data":{"type":"new_message","message_id":job.message_id,
        "recipient_uid":job.uid,"conversation_id":job.conversation_id,
        "sender_name":title,"unread_count":count.to_string(),"unread_senders":people.to_string(),
        "notification_uid":job.uid,"notification_conversation":job.conversation_id},
        "notification":{"title":title,"body":body},
        "android":{"priority":"high","ttl":"604800s","collapse_key":job.conversation_id,
            "notification":{"channel_id":"nexa_messages_v1","icon":"ic_message_notification",
                "color":"#B69EFF","tag":format!("nexa:{}",job.conversation_id),
                "notification_count":count,"notification_priority":"PRIORITY_HIGH",
                "default_sound":true,"default_vibrate_timings":true,"visibility":"PRIVATE",
                "proxy":"ALLOW"}}}});
    // Always displayable on the FIRST request, including rich clients. A
    // data-only probe cannot wake every cold process and used to delay the
    // actual alert by eight seconds. Never gate delivery on an avatar/receipt.
    result
}

pub fn valid_avatar_version(value: &str) -> bool {
    value.len()==64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl Store {
    pub async fn register_renderer_push(&self, uid: &str, session: &str, installation: &str, token: &str, enabled: bool, foreground: bool, receipt_key: Option<&str>) -> Result<()> {
        if let Some(key)=receipt_key {anyhow::ensure!(valid_avatar_version(key),"invalid notification receipt key");}
        self.register_push(uid,session,installation,token,enabled,foreground).await?;
        self.connection().await?.execute("UPDATE push_devices SET receipt_key_hash=?4 WHERE installation_id=?1 AND uid=?2 AND session_hash=?3",libsql::params![installation,uid,hash(session),receipt_key.map(hash)]).await?;
        Ok(())
    }

    pub async fn notification_receipt(&self, receipt: NotificationReceipt) -> Result<bool> {
        if !valid_avatar_version(&receipt.receipt_key) || receipt.installation_id.len()>80 || receipt.uid.len()>80 || receipt.message_id.len()>128 {return Ok(false);}
        let changed=self.connection().await?.execute("UPDATE push_jobs SET finished=1 WHERE installation_id=?1 AND recipient_uid=?2 AND EXISTS(SELECT 1 FROM push_devices d JOIN device_sessions s ON s.token_hash=d.session_hash AND s.uid=d.uid WHERE d.installation_id=?1 AND d.uid=?2 AND d.receipt_key_hash=?3 AND s.expires_at>?5) AND message_id IN (SELECT m.message_id FROM messages m JOIN messages target ON target.message_id=?4 AND target.recipient_uid=?2 WHERE m.recipient_uid=?2 AND m.conversation_id=target.conversation_id AND m.rowid<=target.rowid)",libsql::params![receipt.installation_id,receipt.uid,hash(&receipt.receipt_key),receipt.message_id,now()]).await?;
        Ok(changed>0)
    }

    #[cfg(test)] // Compatibility checks for receipts from pre-upgrade workers.
    async fn native_push_sent(&self, job: &Job) -> Result<()> {
        self.connection().await?.execute("UPDATE push_jobs SET native_sent_at=?4,next_attempt_at=?4+8 WHERE message_id IN(SELECT message_id FROM messages WHERE conversation_id=?1 AND rowid<=?6) AND installation_id=?2 AND recipient_uid=?3 AND finished=0 AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?2 AND uid=?3 AND token=?5)",libsql::params![job.conversation_id.clone(),job.installation_id.clone(),job.uid.clone(),now(),job.token.clone(),job.sequence]).await?;Ok(())
    }
    pub async fn register_push(&self, uid: &str, session: &str, installation: &str, token: &str, enabled: bool, foreground: bool) -> Result<()> {
        anyhow::ensure!((16..=80).contains(&installation.len()) && installation.chars().all(|c|c.is_ascii_alphanumeric() || c=='-'), "invalid installation ID");
        anyhow::ensure!((20..=4096).contains(&token.len()) && !token.chars().any(char::is_whitespace), "invalid push token");
        let conn = self.connection().await?;
        let tx = conn.transaction().await?;
        tx.execute("DELETE FROM push_dispatch_leases WHERE installation_id=?1 AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?1 AND (uid<>?2 OR token<>?3))",libsql::params![installation,uid,token]).await?;
        // Accepted FCM messages on an obsolete token may never reach the phone.
        // Requeue recent unread IDs on rotation; native ID dedup handles overlaps.
        tx.execute("UPDATE push_jobs SET finished=0,native_sent_at=0,next_attempt_at=?4 WHERE installation_id=?1 AND recipient_uid=?2 AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?1 AND uid=?2 AND token<>?3)", libsql::params![installation,uid,token,now()]).await?;
        // A token belongs to one installation/account at a time. Remove old queued jobs
        // on account changes so an old notification cannot be sent to a new account.
        tx.execute("DELETE FROM push_jobs WHERE installation_id IN (SELECT installation_id FROM push_devices WHERE token=?1 OR installation_id=?2) AND recipient_uid<>?3", libsql::params![token,installation,uid]).await?;
        tx.execute("DELETE FROM push_devices WHERE token=?1 AND installation_id<>?2", libsql::params![token,installation]).await?;
        tx.execute("INSERT INTO push_devices(installation_id,uid,session_hash,token,enabled,foreground_until) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(installation_id) DO UPDATE SET uid=excluded.uid,session_hash=excluded.session_hash,token=excluded.token,enabled=excluded.enabled,foreground_until=excluded.foreground_until",
            libsql::params![installation,uid,hash(session),token,enabled as i64,if foreground {now()+90} else {0}]).await?;
        // Also cover messages saved before permission/token registration. Only recent,
        // unread messages are relevant; the encrypted message outbox is independent.
        if enabled {
            tx.execute("INSERT OR IGNORE INTO push_jobs(message_id,installation_id,recipient_uid,next_attempt_at) SELECT message_id,?1,recipient_uid,?2 FROM messages WHERE recipient_uid=?3 AND status<>'SEEN' AND saved_at>=datetime('now','-7 days') ORDER BY saved_at DESC LIMIT 100", libsql::params![installation,now(),uid]).await?;
        }
        tx.commit().await?;
        if enabled {self.push_wakeup.notify_one();}
        Ok(())
    }

    pub async fn push_state(&self, uid: &str, session: &str, installation: &str, foreground: bool) -> Result<()> {
        self.connection().await?.execute("UPDATE push_devices SET foreground_until=?4 WHERE installation_id=?1 AND uid=?2 AND session_hash=?3",libsql::params![installation,uid,hash(session),if foreground {now()+90}else{0}]).await?;
        Ok(())
    }
    pub async fn unregister_push(&self, uid: &str, session: &str, installation: &str) -> Result<()> {
        let conn = self.connection().await?;
        let tx = conn.transaction().await?;
        tx.execute("DELETE FROM push_jobs WHERE installation_id IN (SELECT installation_id FROM push_devices WHERE installation_id=?1 AND uid=?2 AND session_hash=?3)",libsql::params![installation,uid,hash(session)]).await?;
        tx.execute("DELETE FROM push_devices WHERE installation_id=?1 AND uid=?2 AND session_hash=?3",libsql::params![installation,uid,hash(session)]).await?;
        tx.commit().await?; Ok(())
    }

    async fn due_push(&self) -> Result<Vec<Job>> {
        // One representative per conversation/device BEFORE the limit. A busy
        // chat cannot fill the entire batch and starve unrelated recipients.
        let mut rows = self.connection().await?.query(r#"
            WITH ready AS (
                SELECT j.installation_id,j.recipient_uid,m.conversation_id,
                       MAX(m.rowid) AS sequence,MIN(j.next_attempt_at) AS due_at
                FROM push_jobs j JOIN messages m ON m.message_id=j.message_id
                JOIN push_devices d ON d.installation_id=j.installation_id AND d.uid=j.recipient_uid
                JOIN device_sessions s ON s.token_hash=d.session_hash AND s.uid=d.uid
                LEFT JOIN user_settings settings ON settings.uid=d.uid
                LEFT JOIN push_dispatch_leases lease ON lease.installation_id=j.installation_id AND lease.conversation_id=m.conversation_id
                WHERE j.finished=0 AND j.next_attempt_at<=?1 AND d.enabled=1 AND s.expires_at>?1
                  AND m.status<>'SEEN' AND m.saved_at>=datetime('now','-7 days')
                  AND COALESCE(settings.notifications_enabled,1)=1 AND COALESCE(lease.expires_at,0)<=?1
                GROUP BY j.installation_id,j.recipient_uid,m.conversation_id
                ORDER BY due_at,sequence LIMIT 128
            )
            SELECT m.message_id,r.installation_id,r.recipient_uid,m.conversation_id,d.token,u.display_name,
                (SELECT COUNT(*) FROM messages unread WHERE unread.recipient_uid=r.recipient_uid AND unread.conversation_id=m.conversation_id AND unread.status<>'SEEN'),
                CASE WHEN a.data_uri<>'' THEN a.version ELSE NULL END,
                (SELECT COUNT(DISTINCT sender_uid) FROM messages unread WHERE unread.recipient_uid=r.recipient_uid AND unread.status<>'SEEN'),
                d.receipt_key_hash IS NOT NULL,j.native_sent_at,m.rowid
            FROM ready r JOIN messages m ON m.rowid=r.sequence
            JOIN push_jobs j ON j.message_id=m.message_id AND j.installation_id=r.installation_id
            JOIN push_devices d ON d.installation_id=r.installation_id
            JOIN users u ON u.uid=m.sender_uid LEFT JOIN profile_avatars a ON a.uid=u.uid
            ORDER BY r.due_at,r.sequence
        "#,[now()]).await?;
        let mut jobs=Vec::new();
        while let Some(r)=rows.next().await? { jobs.push(Job {message_id:r.get(0)?,installation_id:r.get(1)?,uid:r.get(2)?,conversation_id:r.get(3)?,token:r.get(4)?,sender_name:r.get(5)?,unread_count:r.get(6)?,avatar_version:r.get(7)?,unread_senders:r.get(8)?,native_renderer:r.get::<i64>(9)?!=0,native_sent_at:r.get(10)?,sequence:r.get(11)?,claim_id:uuid::Uuid::new_v4().to_string()}); }
        Ok(jobs)
    }
    async fn claim_push(&self, job: &Job) -> Result<bool> {
        let conn=self.connection().await?;
        let tx=conn.transaction().await?;
        // The database lease serializes the same conversation across processes,
        // including a newer message inserted while the provider call is running.
        let leased=tx.execute(r#"INSERT INTO push_dispatch_leases(installation_id,conversation_id,owner,expires_at)
            SELECT d.installation_id,m.conversation_id,?6,?4+45
            FROM push_devices d JOIN device_sessions s ON s.token_hash=d.session_hash AND s.uid=d.uid
            JOIN messages m ON m.message_id=?1 LEFT JOIN user_settings settings ON settings.uid=d.uid
            WHERE d.installation_id=?2 AND d.uid=?3 AND d.token=?5 AND d.enabled=1 AND s.expires_at>?4
              AND m.recipient_uid=d.uid AND m.status<>'SEEN' AND COALESCE(settings.notifications_enabled,1)=1
              AND EXISTS(SELECT 1 FROM push_jobs j WHERE j.message_id=?1 AND j.installation_id=?2 AND j.finished=0 AND j.next_attempt_at<=?4)
            ON CONFLICT(installation_id,conversation_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
            WHERE push_dispatch_leases.expires_at<=?4"#,
            libsql::params![job.message_id.clone(),job.installation_id.clone(),job.uid.clone(),now(),job.token.clone(),job.claim_id.clone()]).await?;
        if leased==0 {tx.rollback().await?;return Ok(false);}
        let changed=tx.execute(r#"UPDATE push_jobs SET attempts=attempts+1,
            next_attempt_at=?4+CASE WHEN attempts<3 THEN 15 WHEN attempts<6 THEN 120 ELSE 3600 END+ABS(random()%5)
            WHERE installation_id=?1 AND recipient_uid=?2 AND finished=0 AND next_attempt_at<=?4
              AND message_id IN(SELECT message_id FROM messages WHERE conversation_id=?3 AND recipient_uid=?2 AND rowid<=?5)"#,
            libsql::params![job.installation_id.clone(),job.uid.clone(),job.conversation_id.clone(),now(),job.sequence]).await?;
        if changed==0 {tx.rollback().await?;return Ok(false);}
        tx.commit().await?;Ok(true)
    }
    async fn finish_push(&self, job: &Job, invalid: bool) -> Result<()> {
        let conn=self.connection().await?;let tx=conn.transaction().await?;
        if invalid {
            tx.execute("UPDATE push_devices SET enabled=0 WHERE installation_id=?1 AND token=?2 AND uid=?3",libsql::params![job.installation_id.clone(),job.token.clone(),job.uid.clone()]).await?;
        } else {
            // A snapshot completes only its prefix. A later arrival remains queued.
            tx.execute(r#"UPDATE push_jobs SET finished=1 WHERE installation_id=?1 AND recipient_uid=?2
                AND message_id IN(SELECT message_id FROM messages WHERE recipient_uid=?2 AND conversation_id=?3 AND rowid<=?4)
                AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?1 AND uid=?2 AND token=?5)
                AND EXISTS(SELECT 1 FROM push_dispatch_leases WHERE installation_id=?1 AND conversation_id=?3 AND owner=?6 AND expires_at>?7)"#,
                libsql::params![job.installation_id.clone(),job.uid.clone(),job.conversation_id.clone(),job.sequence,job.token.clone(),job.claim_id.clone(),now()]).await?;
        }
        tx.execute("DELETE FROM push_dispatch_leases WHERE installation_id=?1 AND conversation_id=?2 AND owner=?3",libsql::params![job.installation_id.clone(),job.conversation_id.clone(),job.claim_id.clone()]).await?;
        tx.commit().await?;Ok(())
    }

    async fn defer_push(&self, job: &Job, seconds: i64) -> Result<()> {
        let conn=self.connection().await?;let tx=conn.transaction().await?;
        // Positive jitter never shortens Retry-After. Keep the conversation lease
        // until then so a second message cannot bypass provider throttling.
        let until=now()+seconds.clamp(1,86400)+(uuid::Uuid::new_v4().as_u128()%7) as i64;
        tx.execute(r#"UPDATE push_jobs SET next_attempt_at=MAX(next_attempt_at,?4)
            WHERE installation_id=?1 AND recipient_uid=?2 AND finished=0
              AND message_id IN(SELECT message_id FROM messages WHERE recipient_uid=?2 AND conversation_id=?3 AND rowid<=?5)
              AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?1 AND uid=?2 AND token=?6)
              AND EXISTS(SELECT 1 FROM push_dispatch_leases WHERE installation_id=?1 AND conversation_id=?3 AND owner=?7)"#,
            libsql::params![job.installation_id.clone(),job.uid.clone(),job.conversation_id.clone(),until,job.sequence,job.token.clone(),job.claim_id.clone()]).await?;
        tx.execute("UPDATE push_dispatch_leases SET expires_at=?4 WHERE installation_id=?1 AND conversation_id=?2 AND owner=?3",libsql::params![job.installation_id.clone(),job.conversation_id.clone(),job.claim_id.clone(),until]).await?;
        tx.commit().await?;Ok(())
    }

    async fn clean_push(&self) -> Result<()> {
        self.connection().await?.execute("DELETE FROM push_jobs WHERE message_id IN (SELECT message_id FROM messages WHERE status='SEEN' OR saved_at<datetime('now','-7 days')) OR installation_id NOT IN (SELECT installation_id FROM push_devices)", ()).await?;
        Ok(())
    }
}

pub async fn run_worker(store: Store, sender: Arc<PushSender>) {
    // Immediate local wakeup plus a recovery sweep for cross-process inserts,
    // restart, expired leases and provider retries. Slow sends never hold a batch.
    let mut tick=tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut cleaned=tokio::time::Instant::now();
    let mut running=tokio::task::JoinSet::new();
    let mut active=std::collections::HashSet::new();
    loop {
        tokio::select! {
            _=tick.tick()=>{},
            _=store.push_wakeup.notified()=>{},
            Some(result)=running.join_next(), if !running.is_empty()=>{
                match result {Ok(key)=>{active.remove(&key);},Err(_)=>{active.clear();tracing::warn!("push task stopped; durable lease will recover");}}
            }
        }
        if cleaned.elapsed()>=Duration::from_secs(3600) {let _=store.clean_push().await;cleaned=tokio::time::Instant::now();}
        let available=32usize.saturating_sub(running.len());
        if available==0 {continue;}
        let jobs=match store.due_push().await {Ok(j)=>j,Err(_)=>{tracing::warn!("push queue query failed; will retry");continue}};
        for job in jobs.into_iter().filter(|j|!active.contains(&(j.installation_id.clone(),j.conversation_id.clone()))).take(available).collect::<Vec<_>>() {
            let key=(job.installation_id.clone(),job.conversation_id.clone());active.insert(key.clone());
            let store=store.clone();let sender=sender.clone();
            running.spawn(async move {
                let claimed=match store.claim_push(&job).await {
                    Ok(value)=>value,
                    Err(_)=>{STATE_ERRORS.fetch_add(1,Ordering::Relaxed);tracing::warn!("push claim failed; durable notification remains queued");false}
                };
                if claimed {
                    let result=match sender.send(&job).await {
                        Ok(Outcome::Sent)=>{ACCEPTED.fetch_add(1,Ordering::Relaxed);store.finish_push(&job,false).await},
                        Ok(Outcome::InvalidToken)=>{INVALID.fetch_add(1,Ordering::Relaxed);store.finish_push(&job,true).await},
                        Ok(Outcome::Retry(delay))=>{RETRIES.fetch_add(1,Ordering::Relaxed);store.defer_push(&job,delay).await},
                        Err(_)=>{RETRIES.fetch_add(1,Ordering::Relaxed);tracing::warn!("FCM transport failed; durable notification will retry");store.defer_push(&job,15).await}
                    };
                    if result.is_err() {STATE_ERRORS.fetch_add(1,Ordering::Relaxed);tracing::warn!("push state update failed; lease will recover");}
                }
                key
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn push_displays_without_app_process_and_keeps_content_private() {
        let job=Job{message_id:"m_test".into(),installation_id:"i_test".into(),uid:"b".into(),conversation_id:"cv".into(),token:"token".into(),sender_name:"Alice".into(),unread_count:2,unread_senders:1,avatar_version:None,native_renderer:false,native_sent_at:0,sequence:0,claim_id:uuid::Uuid::new_v4().to_string()};
        let data=payload(&job);
        assert_eq!(data["message"]["notification"]["title"],"Alice");
        assert_eq!(data["message"]["notification"]["body"],"2 new messages");
        assert_eq!(data["message"]["android"]["collapse_key"],"cv");
        assert_eq!(data["message"]["android"]["notification"]["notification_count"],2);
        let mut other=job.clone();other.conversation_id="other".into();other.sender_name="Bob".into();other.unread_count=1;
        assert_eq!(payload(&other)["message"]["notification"]["body"],"1 new message");
        assert_ne!(payload(&other)["message"]["android"]["notification"]["tag"],data["message"]["android"]["notification"]["tag"]);
        other.unread_senders=2;
        assert_eq!(payload(&other)["message"]["notification"]["body"],"1 new message · 2 people messaging you");
        assert_eq!(data["message"]["android"]["notification"]["channel_id"],"nexa_messages_v1");
        assert_eq!(data["message"]["android"]["notification"]["tag"],"nexa:cv");
        assert_eq!(data["message"]["android"]["notification"]["visibility"],"PRIVATE");
        assert_eq!(data["message"]["android"]["notification"]["proxy"],"ALLOW");
        assert_eq!(data["message"]["data"]["notification_uid"],"b");
        assert_eq!(data["message"]["data"]["notification_conversation"],"cv");
        assert_eq!(data["message"]["android"]["ttl"],"604800s");
        assert_eq!(data["message"]["data"]["recipient_uid"],"b");
        assert!(!data.to_string().contains("ciphertext"));
        assert!(data["message"]["android"]["notification"].get("image").is_none(),"fallback must never create a picture banner");
        other.native_renderer=true;other.avatar_version=Some("a".repeat(64));
        let native=payload(&other);
        assert!(native["message"].get("notification").is_some(),"rich clients must receive a displayable alert on the first attempt");
        assert_eq!(native["message"]["android"]["notification"]["proxy"],"ALLOW");
        assert!(native["message"]["data"].get("avatar_version").is_none(),"avatar fetching is not on the notification critical path");
        assert!(native["message"]["data"].get("receipt_key").is_none(),"receipt secrets never enter FCM");
        other.native_sent_at=1;
        assert!(payload(&other)["message"].get("notification").is_some(),"missing receipt falls back to a system alert");
    }

    #[tokio::test]
    async fn native_receipt_is_device_bound_and_preserves_newer_jobs() {
        let path=format!("target/notification_receipt_{}.db",uuid::Uuid::new_v4());
        let store=Store::load_test_store(&path,&["a".into(),"b".into(),"c".into()]).await.unwrap();
        let conn=store.connection().await.unwrap();
        conn.execute_batch("INSERT INTO conversations(conversation_id,pair_key,created_by) VALUES('ab','a:b','a'),('cb','b:c','c'); INSERT INTO conversation_members(conversation_id,uid) VALUES('ab','a'),('ab','b'),('cb','c'),('cb','b');").await.unwrap();
        let session="b-session-abcdefghijklmnopqrstuvwxyz123456";
        conn.execute("INSERT INTO device_sessions(token_hash,uid,expires_at) VALUES(?1,'b',?2)",libsql::params![hash(session),now()+3600]).await.unwrap();
        let installation="receipt-installation-001";let key="a".repeat(64);
        store.register_renderer_push("b",session,installation,"receipt-token-at-least-20-characters",true,false,Some(&key)).await.unwrap();
        for (id,conv,sender) in [("receipt_a1","ab","a"),("receipt_a2","ab","a"),("receipt_c1","cb","c")] {store.save_ciphertext(id,conv,sender,&[0x33,1,2],Some(1)).await.unwrap();}
        let jobs=store.due_push().await.unwrap();assert!(jobs.iter().all(|j|j.native_renderer && j.native_sent_at==0));
        for job in &jobs {store.native_push_sent(job).await.unwrap();}
        assert!(store.due_push().await.unwrap().is_empty(),"fallback waits for the native receipt");
        let receipt=|message:&str,secret:&str|NotificationReceipt{installation_id:installation.into(),uid:"b".into(),message_id:message.into(),receipt_key:secret.into()};
        assert!(!store.notification_receipt(receipt("receipt_a2",&"b".repeat(64))).await.unwrap());
        store.save_ciphertext("receipt_a3","ab","a",&[0x33,1,2],Some(1)).await.unwrap();
        assert!(store.notification_receipt(receipt("receipt_a2",&key)).await.unwrap());
        // An ACK racing the provider response must not reopen a completed job.
        for job in jobs.iter().filter(|j|j.conversation_id=="ab") {store.native_push_sent(job).await.unwrap();}
        conn.execute("UPDATE push_jobs SET next_attempt_at=0",()).await.unwrap();
        let pending=store.due_push().await.unwrap();assert_eq!(pending.len(),2);
        assert!(pending.iter().any(|j|j.message_id=="receipt_a3" && j.native_sent_at==0));
        assert!(pending.iter().any(|j|j.message_id=="receipt_c1" && j.native_sent_at>0));
        let mut rows=conn.query("SELECT status FROM messages WHERE message_id='receipt_a2'",()).await.unwrap();assert_eq!(rows.next().await.unwrap().unwrap().get::<String>(0).unwrap(),"SAVED","notification receipt is not a chat read receipt");drop(rows);
        conn.execute("UPDATE device_sessions SET expires_at=0",()).await.unwrap();
        assert!(!store.notification_receipt(receipt("receipt_c1",&key)).await.unwrap());
        drop(conn);drop(store);let _=std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn sender_counts_are_separate_and_seen_messages_are_excluded() {
        let path=format!("target/sender_counts_{}.db",uuid::Uuid::new_v4());
        let store=Store::load_test_store(&path,&["alice".into(),"bob".into(),"carol".into()]).await.unwrap();
        let conn=store.connection().await.unwrap();
        conn.execute_batch("INSERT INTO conversations(conversation_id,pair_key,created_by) VALUES('ab','alice:bob','alice'),('cb','bob:carol','carol'); INSERT INTO conversation_members(conversation_id,uid) VALUES('ab','alice'),('ab','bob'),('cb','carol'),('cb','bob');").await.unwrap();
        let session="bob-session-abcdefghijklmnopqrstuvwxyz123456";
        conn.execute("INSERT INTO device_sessions(token_hash,uid,expires_at) VALUES(?1,'bob',?2)",libsql::params![hash(session),now()+3600]).await.unwrap();
        store.register_push("bob",session,"counts-installation-001","counts-token-at-least-20-characters",true,false).await.unwrap();
        for (id,conversation,sender) in [("count_a1","ab","alice"),("count_a2","ab","alice"),("count_c1","cb","carol")] {
            store.save_ciphertext(id,conversation,sender,&[0x33,1,2],Some(1)).await.unwrap();
        }
        // Lost-ACK retries must not inflate unread counts.
        store.save_ciphertext("count_a1","ab","alice",&[0x33,1,2],Some(1)).await.unwrap();
        let jobs=store.due_push().await.unwrap();assert_eq!(jobs.len(),2,"one dispatch per conversation, not per message");
        assert!(jobs.iter().all(|j|j.unread_senders==2));
        assert!(jobs.iter().filter(|j|j.conversation_id=="ab").all(|j|j.sender_name=="alice" && j.unread_count==2));
        assert!(jobs.iter().filter(|j|j.conversation_id=="cb").all(|j|j.sender_name=="carol" && j.unread_count==1));
        store.mark_seen("count_a1","bob").await.unwrap();
        let jobs=store.due_push().await.unwrap();assert_eq!(jobs.len(),2);
        assert_eq!(jobs.iter().find(|j|j.conversation_id=="ab").unwrap().unread_count,1);
        drop(conn);drop(store);let _=std::fs::remove_file(path);
    }

    #[tokio::test]
    #[ignore = "Requires an explicit Firebase credential and a private test-device registration fixture; sends one real push"]
    async fn firebase_real_device_transport() {
        let path=env::var("NEXA_FCM_SMOKE_FIXTURE").expect("explicit test-device fixture path required");
        let fixture: serde_json::Value=serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let token=fixture["token"].as_str().filter(|v|!v.is_empty()).expect("test device has no FCM token");
        let uid=fixture["uid"].as_str().filter(|v|!v.is_empty()).expect("test device has no signed-in account");
        let job=Job {message_id:env::var("NEXA_FCM_SMOKE_ID").expect("explicit smoke message ID required"),
            installation_id:fixture["installation_id"].as_str().unwrap().into(), uid:uid.into(), token:token.into(),
            conversation_id:env::var("NEXA_FCM_SMOKE_CONVERSATION").unwrap_or_else(|_|"notification-transport-test".into()),
            sender_name:env::var("NEXA_FCM_SMOKE_SENDER").unwrap_or_else(|_|"Notification test".into()),
            unread_count:env::var("NEXA_FCM_SMOKE_COUNT").ok().and_then(|v|v.parse().ok()).unwrap_or(1),
            unread_senders:env::var("NEXA_FCM_SMOKE_PEOPLE").ok().and_then(|v|v.parse().ok()).unwrap_or(1),
            avatar_version:env::var("NEXA_FCM_SMOKE_AVATAR").ok(),native_renderer:env::var("NEXA_FCM_SMOKE_NATIVE").ok().as_deref()==Some("1"),native_sent_at:0,sequence:0,claim_id:uuid::Uuid::new_v4().to_string()};
        let sender=PushSender::from_env().unwrap().expect("Firebase credentials required");
        assert!(matches!(sender.send(&job).await.unwrap(),Outcome::Sent),"FCM did not accept the test push");
    }

    async fn queue_fixture() -> Store {
        let store=Store::load_test_store(&format!("target/push-{}.db",uuid::Uuid::new_v4()),&["a".into(),"b".into(),"c".into()]).await.unwrap();
        let conn=store.connection().await.unwrap();
        conn.execute_batch("INSERT INTO conversations(conversation_id,pair_key,created_by) VALUES('ab','a:b','a'),('cb','b:c','c'); INSERT INTO conversation_members(conversation_id,uid) VALUES('ab','a'),('ab','b'),('cb','c'),('cb','b');").await.unwrap();
        for uid in ["b","c"] {
            conn.execute("INSERT INTO device_sessions(token_hash,uid,expires_at) VALUES(?1,?2,?3)",libsql::params![hash(&format!("{uid}-session-abcdefghijklmnopqrstuvwxyz123456")),uid,now()+3600]).await.unwrap();
        }
        store.register_renderer_push("b","b-session-abcdefghijklmnopqrstuvwxyz123456","test-installation-0001","test-push-token-at-least-20-characters",true,true,Some(&"a".repeat(64))).await.unwrap();
        store
    }
    async fn save(store:&Store,id:&str) {store.save_ciphertext(id,"ab","a",&[0x33,1,2],Some(1)).await.unwrap();}
    async fn expire(store:&Store) {
        store.connection().await.unwrap().execute_batch("UPDATE push_dispatch_leases SET expires_at=0; UPDATE push_jobs SET next_attempt_at=0;").await.unwrap();
    }

    #[tokio::test]
    async fn single_message_wakes_worker_and_stale_foreground_never_suppresses_it() {
        let store=queue_fixture().await;
        let _=tokio::time::timeout(Duration::from_millis(1),store.push_wakeup.notified()).await;
        save(&store,"message-single").await;
        tokio::time::timeout(Duration::from_millis(100),store.push_wakeup.notified()).await.expect("message commit must wake worker immediately");
        let jobs=store.due_push().await.unwrap();assert_eq!(jobs.len(),1,"a still-valid foreground lease must not hide a killed app's message");
        assert!(payload(&jobs[0])["message"]["notification"].is_object());
        assert!(!store.save_ciphertext("message-single","ab","a",&[0x33,1,2],Some(1)).await.unwrap().1);
        assert_eq!(store.due_push().await.unwrap()[0].unread_count,1);
        store.mark_delivered("message-single","b").await.unwrap();assert_eq!(store.due_push().await.unwrap().len(),1,"delivery is not a display receipt");
        store.mark_seen("message-single","b").await.unwrap();assert!(store.due_push().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn concurrent_claims_coalesce_burst_without_losing_new_arrivals_or_lease_ownership() {
        let store=queue_fixture().await;
        for id in ["message-one","message-two"] {save(&store,id).await;}
        let candidates=futures_util::future::join_all((0..12).map(|_|store.due_push())).await.into_iter().map(|v|v.unwrap().remove(0)).collect::<Vec<_>>();
        let results=futures_util::future::join_all(candidates.iter().map(|j|store.claim_push(j))).await;
        assert!(results.iter().all(|r|r.is_ok()),"concurrent claims must not produce database errors");
        let winners=results.iter().enumerate().filter(|(_,r)|matches!(r,Ok(true))).map(|(i,_)|i).collect::<Vec<_>>();
        assert_eq!(winners.len(),1);let winner=&candidates[winners[0]];
        save(&store,"message-three").await;
        assert!(store.due_push().await.unwrap().is_empty(),"a newer send cannot overtake an in-flight conversation");
        store.finish_push(winner,false).await.unwrap();
        let next=store.due_push().await.unwrap().remove(0);assert_eq!(next.message_id,"message-three");assert_eq!(next.unread_count,3);
        assert!(store.claim_push(&next).await.unwrap());
        store.finish_push(winner,false).await.unwrap();
        assert_eq!(store.connection().await.unwrap().query("SELECT finished FROM push_jobs WHERE message_id='message-three'",()).await.unwrap().next().await.unwrap().unwrap().get::<i64>(0).unwrap(),0);
        expire(&store).await;
        let recovered=store.due_push().await.unwrap().remove(0);assert!(store.claim_push(&recovered).await.unwrap());
        store.finish_push(&next,false).await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"late old response cannot release the recovered worker's lease");
        store.finish_push(&recovered,false).await.unwrap();assert!(store.due_push().await.unwrap().is_empty());
        let conn=store.connection().await.unwrap();
        let count=conn.query("SELECT COUNT(*) FROM push_jobs WHERE finished=1",()).await.unwrap().next().await.unwrap().unwrap().get::<i64>(0).unwrap();assert_eq!(count,3);
    }

    #[tokio::test]
    async fn retry_after_blocks_bypass_but_not_another_conversation_and_restart_recovers() {
        let store=queue_fixture().await;save(&store,"message-retry").await;
        let job=store.due_push().await.unwrap().remove(0);assert!(store.claim_push(&job).await.unwrap());
        store.defer_push(&job,60).await.unwrap();save(&store,"cannot-bypass").await;
        store.save_ciphertext("other-person","cb","c",&[0x33,1,2],Some(1)).await.unwrap();
        let due=store.due_push().await.unwrap();assert_eq!(due.len(),1);assert_eq!(due[0].conversation_id,"cb");
        let conn=store.connection().await.unwrap();
        let until=conn.query("SELECT expires_at FROM push_dispatch_leases",()).await.unwrap().next().await.unwrap().unwrap().get::<i64>(0).unwrap();assert!(until>=now()+59);
        expire(&store).await;let pending=store.due_push().await.unwrap();assert_eq!(pending.len(),2);
        let ab=pending.iter().find(|j|j.conversation_id=="ab").unwrap();assert_eq!(ab.message_id,"cannot-bypass");
        assert!(store.claim_push(ab).await.unwrap());
        // Reopening a real SQLite file preserves pending work and active leases.
        let path=conn.query("PRAGMA database_list",()).await.unwrap().next().await.unwrap().unwrap().get::<String>(2).unwrap();
        let reopened=Store::load_test_store(&path,&[]).await.unwrap();
        assert!(reopened.due_push().await.unwrap().iter().all(|j|j.conversation_id!="ab"));
        expire(&reopened).await;assert_eq!(reopened.due_push().await.unwrap().len(),2);
    }

    #[tokio::test]
    async fn token_rotation_permission_changes_account_switch_and_revocation_are_safe() {
        let store=queue_fixture().await;save(&store,"message-rotate").await;
        let old=store.due_push().await.unwrap().remove(0);assert!(store.claim_push(&old).await.unwrap());
        let session="b-session-abcdefghijklmnopqrstuvwxyz123456";
        store.register_push("b",session,&old.installation_id,"new-push-token-at-least-20-characters",true,false).await.unwrap();
        store.finish_push(&old,false).await.unwrap();store.defer_push(&old,3600).await.unwrap();
        let current=store.due_push().await.unwrap().remove(0);assert!(!store.claim_push(&old).await.unwrap());assert!(store.claim_push(&current).await.unwrap());
        store.finish_push(&current,true).await.unwrap();assert!(store.due_push().await.unwrap().is_empty());
        store.register_push("b",session,&old.installation_id,"rotated-again-token-at-least-20-characters",true,false).await.unwrap();
        let current=store.due_push().await.unwrap().remove(0);
        let conn=store.connection().await.unwrap();conn.execute("INSERT INTO user_settings(uid,notifications_enabled) VALUES('b',0)",()).await.unwrap();
        assert!(!store.claim_push(&current).await.unwrap());
        conn.execute("UPDATE user_settings SET notifications_enabled=1",()).await.unwrap();
        store.revoke_session(session).await.unwrap();assert!(store.due_push().await.unwrap().is_empty());
        store.register_push("c","c-session-abcdefghijklmnopqrstuvwxyz123456",&old.installation_id,&current.token,true,false).await.unwrap();
        assert_eq!(conn.query("SELECT COUNT(*) FROM push_jobs WHERE recipient_uid='b'",()).await.unwrap().next().await.unwrap().unwrap().get::<i64>(0).unwrap(),0);
        store.unregister_push("b",session,&old.installation_id).await.unwrap();
        assert_eq!(conn.query("SELECT uid FROM push_devices",()).await.unwrap().next().await.unwrap().unwrap().get::<String>(0).unwrap(),"c");
    }

    #[tokio::test]
    async fn hot_chat_cannot_starve_160_other_devices_and_dispatches_stay_bounded() {
        let store=queue_fixture().await;let conn=store.connection().await.unwrap();
        // Queue-level load fixture: bypass sender rate limiting intentionally.
        let started=std::time::Instant::now();
        let tx=conn.transaction().await.unwrap();
        for i in 0..160 {
            let uid=format!("r{i}");let cv=format!("cv{i}");let install=format!("installation-{i:016}");
            tx.execute("INSERT INTO users(uid,username,display_name,password_hash) VALUES(?1,?1,?1,'fixture')",[uid.clone()]).await.unwrap();
            tx.execute("INSERT INTO device_sessions(token_hash,uid,expires_at) VALUES(?1,?2,?3)",libsql::params![hash(&format!("session-{i}")),uid.clone(),now()+3600]).await.unwrap();
            tx.execute("INSERT INTO conversations(conversation_id,pair_key,created_by) VALUES(?1,?1,'a')",[cv.clone()]).await.unwrap();
            tx.execute("INSERT INTO push_devices(installation_id,uid,session_hash,token) VALUES(?1,?2,?3,?4)",libsql::params![install,uid.clone(),hash(&format!("session-{i}")),format!("token-number-{i}")]).await.unwrap();
            for j in 0..if i==0 {400} else {12} {
                tx.execute("INSERT INTO messages(message_id,conversation_id,sender_uid,recipient_uid,ciphertext,created_at,status) VALUES(?1,?2,'a',?3,X'330102','0','SAVED')",libsql::params![format!("load-{i}-{j}"),cv.clone(),uid.clone()]).await.unwrap();
            }
        }
        tx.commit().await.unwrap();
        let first=store.due_push().await.unwrap();assert_eq!(first.len(),128);
        assert_eq!(first.iter().map(|j|&j.installation_id).collect::<std::collections::HashSet<_>>().len(),128);
        assert_eq!(first.iter().find(|j|j.conversation_id=="cv0").unwrap().unread_count,400);
        for j in &first {assert!(store.claim_push(j).await.unwrap());store.finish_push(j,false).await.unwrap();}
        let rest=store.due_push().await.unwrap();assert_eq!(rest.len(),32);
        for j in &rest {assert!(store.claim_push(j).await.unwrap());store.finish_push(j,false).await.unwrap();}
        assert!(store.due_push().await.unwrap().is_empty());
        let total=conn.query("SELECT COUNT(*) FROM push_jobs WHERE finished=1",()).await.unwrap().next().await.unwrap().unwrap().get::<i64>(0).unwrap();assert_eq!(total,2308);
        println!("Queue load: {total} messages, 160 devices, 160 coalesced dispatches, elapsed {:?}",started.elapsed());
    }
}
