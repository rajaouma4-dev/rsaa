//! Durable, privacy-preserving FCM wakeups. Plaintext never enters a push payload.
use anyhow::{Context, Result};
use futures_util::{stream, StreamExt};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{env, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::sync::Mutex;
use crate::db::Store;

fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64 }
fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }

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
struct Job { message_id: String, installation_id: String, uid: String, conversation_id: String, token: String }
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
    json!({"message":{"token":job.token,"data":{"type":"new_message","message_id":job.message_id,
        "recipient_uid":job.uid,"conversation_id":job.conversation_id},
        "android":{"priority":"high","ttl":"604800s","collapse_key":"nexa-unread"}}})
}

impl Store {
    pub async fn register_push(&self, uid: &str, session: &str, installation: &str, token: &str, enabled: bool, foreground: bool) -> Result<()> {
        anyhow::ensure!((16..=80).contains(&installation.len()) && installation.chars().all(|c|c.is_ascii_alphanumeric() || c=='-'), "invalid installation ID");
        anyhow::ensure!((20..=4096).contains(&token.len()) && !token.chars().any(char::is_whitespace), "invalid push token");
        let conn = self.connection().await?;
        let tx = conn.transaction().await?;
        // Accepted FCM messages on an obsolete token may never reach the phone.
        // Requeue recent unread IDs on rotation; native ID dedup handles overlaps.
        tx.execute("UPDATE push_jobs SET finished=0,next_attempt_at=?4 WHERE installation_id=?1 AND recipient_uid=?2 AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?1 AND uid=?2 AND token<>?3)", libsql::params![installation,uid,token,now()]).await?;
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
        let mut rows = self.connection().await?.query("SELECT j.message_id,j.installation_id,j.recipient_uid,m.conversation_id,d.token FROM push_jobs j JOIN messages m ON m.message_id=j.message_id JOIN push_devices d ON d.installation_id=j.installation_id AND d.uid=j.recipient_uid JOIN device_sessions s ON s.token_hash=d.session_hash AND s.uid=d.uid LEFT JOIN user_settings settings ON settings.uid=d.uid WHERE j.finished=0 AND j.next_attempt_at<=?1 AND d.foreground_until<=?1 AND d.enabled=1 AND s.expires_at>?1 AND m.status<>'SEEN' AND m.saved_at>=datetime('now','-7 days') AND COALESCE(settings.notifications_enabled,1)=1 ORDER BY j.next_attempt_at LIMIT 32",[now()]).await?;
        let mut jobs=Vec::new();
        while let Some(r)=rows.next().await? { jobs.push(Job {message_id:r.get(0)?,installation_id:r.get(1)?,uid:r.get(2)?,conversation_id:r.get(3)?,token:r.get(4)?}); }
        Ok(jobs)
    }
    async fn claim_push(&self, job: &Job) -> Result<bool> {
        let changed=self.connection().await?.execute("UPDATE push_jobs SET attempts=attempts+1,next_attempt_at=?4+CASE WHEN attempts<3 THEN 15 WHEN attempts<6 THEN 120 ELSE 3600 END WHERE message_id=?1 AND installation_id=?2 AND recipient_uid=?3 AND finished=0 AND next_attempt_at<=?4 AND EXISTS(SELECT 1 FROM push_devices d JOIN device_sessions s ON s.token_hash=d.session_hash AND s.uid=d.uid JOIN messages m ON m.message_id=?1 LEFT JOIN user_settings settings ON settings.uid=d.uid WHERE d.installation_id=?2 AND d.uid=?3 AND d.token=?5 AND d.enabled=1 AND d.foreground_until<=?4 AND s.expires_at>?4 AND m.status<>'SEEN' AND COALESCE(settings.notifications_enabled,1)=1)",libsql::params![job.message_id.clone(),job.installation_id.clone(),job.uid.clone(),now(),job.token.clone()]).await?;
        Ok(changed==1)
    }
    async fn finish_push(&self, job: &Job, invalid: bool) -> Result<()> {
        let conn=self.connection().await?;
        if !invalid { conn.execute("UPDATE push_jobs SET finished=1 WHERE message_id=?1 AND installation_id=?2 AND recipient_uid=?3 AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?2 AND uid=?3 AND token=?4)",libsql::params![job.message_id.clone(),job.installation_id.clone(),job.uid.clone(),job.token.clone()]).await?; }
        if invalid { conn.execute("UPDATE push_devices SET enabled=0 WHERE installation_id=?1 AND token=?2",libsql::params![job.installation_id.clone(),job.token.clone()]).await?; }
        Ok(())
    }

    async fn defer_push(&self, job: &Job, seconds: i64) -> Result<()> {
        self.connection().await?.execute("UPDATE push_jobs SET next_attempt_at=MAX(next_attempt_at,?3) WHERE message_id=?1 AND installation_id=?2 AND recipient_uid=?4 AND finished=0 AND EXISTS(SELECT 1 FROM push_devices WHERE installation_id=?2 AND uid=?4 AND token=?5)", libsql::params![job.message_id.clone(),job.installation_id.clone(),now()+seconds,job.uid.clone(),job.token.clone()]).await?;
        Ok(())
    }

    async fn clean_push(&self) -> Result<()> {
        self.connection().await?.execute("DELETE FROM push_jobs WHERE message_id IN (SELECT message_id FROM messages WHERE status='SEEN' OR saved_at<datetime('now','-7 days')) OR installation_id NOT IN (SELECT installation_id FROM push_devices)", ()).await?;
        Ok(())
    }
}

pub async fn run_worker(store: Store, sender: Arc<PushSender>) {
    let mut tick=tokio::time::interval(Duration::from_secs(3));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut passes = 0u32;
    loop {
        tick.tick().await;
        passes += 1;
        if passes >= 1200 { let _ = store.clean_push().await; passes = 0; }
        let jobs=match store.due_push().await {Ok(j)=>j,Err(_)=>{tracing::warn!("push queue query failed; will retry");continue}};
        stream::iter(jobs).for_each_concurrent(8, |job| {
            let store=store.clone(); let sender=sender.clone();
            async move {
                if !matches!(store.claim_push(&job).await,Ok(true)){return}
                match sender.send(&job).await {
                    Ok(Outcome::Sent)=>{let _=store.finish_push(&job,false).await;},
                    Ok(Outcome::InvalidToken)=>{let _=store.finish_push(&job,true).await;},
                    Ok(Outcome::Retry(delay))=>{let _=store.defer_push(&job,delay).await;},
                    _=>tracing::warn!("FCM send failed; durable notification will retry"),
                }
            }
        }).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn push_is_data_only_and_expires_after_a_week() {
        let job=Job{message_id:"m_test".into(),installation_id:"i_test".into(),uid:"b".into(),conversation_id:"cv".into(),token:"token".into()};
        let data=payload(&job);
        assert!(data["message"].get("notification").is_none());
        assert_eq!(data["message"]["android"]["ttl"],"604800s");
        assert_eq!(data["message"]["data"]["recipient_uid"],"b");
        assert!(!data.to_string().contains("ciphertext"));
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
            conversation_id:env::var("NEXA_FCM_SMOKE_CONVERSATION").unwrap_or_else(|_|"notification-transport-test".into())};
        let sender=PushSender::from_env().unwrap().expect("Firebase credentials required");
        assert!(matches!(sender.send(&job).await.unwrap(),Outcome::Sent),"FCM did not accept the test push");
    }

    #[tokio::test]
    async fn durable_push_is_idempotent_session_bound_and_independent_of_delivery() {
        let path=format!("target/test_push_{}.db",uuid::Uuid::new_v4());
        let store=Store::load_test_store(&path,&["a".into(),"b".into(),"c".into()]).await.unwrap();
        let conn=store.connection().await.unwrap();
        conn.execute_batch("INSERT INTO conversations(conversation_id,pair_key,created_by) VALUES('cv_push','a:b','a'); INSERT INTO conversation_members(conversation_id,uid) VALUES('cv_push','a'),('cv_push','b');").await.unwrap();
        for (uid,session) in [("b","b-session-abcdefghijklmnopqrstuvwxyz123456"),("c","c-session-abcdefghijklmnopqrstuvwxyz123456")] {
            conn.execute("INSERT INTO device_sessions(token_hash,uid,expires_at) VALUES(?1,?2,?3)",libsql::params![hash(session),uid,now()+3600]).await.unwrap();
        }
        let installation="test-installation-0001";
        let token="test-push-token-at-least-20-characters";
        store.register_push("b","b-session-abcdefghijklmnopqrstuvwxyz123456",installation,token,true,true).await.unwrap();
        let bytes=[0x33,1,2,3];
        assert!(store.save_ciphertext("push_message_001","cv_push","a",&bytes,Some(1)).await.unwrap().1);
        assert!(!store.save_ciphertext("push_message_001","cv_push","a",&bytes,Some(1)).await.unwrap().1);
        assert!(store.due_push().await.unwrap().is_empty(),"foreground lease suppresses pushes");
        store.push_state("c","c-session-abcdefghijklmnopqrstuvwxyz123456",installation,false).await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"other account cannot change device state");
        store.push_state("b","b-session-abcdefghijklmnopqrstuvwxyz123456",installation,false).await.unwrap();
        let jobs=store.due_push().await.unwrap();
        assert_eq!(jobs.len(),1,"lost-ACK retries create one push job");
        assert!(store.claim_push(&jobs[0]).await.unwrap());
        assert!(!store.claim_push(&jobs[0]).await.unwrap(),"worker claims are atomic");
        conn.execute("UPDATE push_jobs SET next_attempt_at=0",()).await.unwrap();
        // Delivered in background still needs an alert. A push is never a delivered ACK.
        store.mark_delivered("push_message_001","b").await.unwrap();
        assert_eq!(store.due_push().await.unwrap().len(),1);
        let restarted=Store::load_test_store(&path,&[]).await.unwrap();
        assert_eq!(restarted.due_push().await.unwrap().len(),1,"notification survives reopening the on-disk database");
        store.defer_push(&jobs[0],3600).await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"provider Retry-After defers retry");
        conn.execute("UPDATE push_jobs SET next_attempt_at=0",()).await.unwrap();
        store.finish_push(&jobs[0],false).await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty());
        store.clean_push().await.unwrap();
        store.register_push("b","b-session-abcdefghijklmnopqrstuvwxyz123456",installation,token,true,false).await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"token re-registration does not requeue an accepted push");
        let mut rows=conn.query("SELECT status FROM messages WHERE message_id='push_message_001'",()).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<String>(0).unwrap(),"DELIVERED");
        drop(rows);
        store.save_ciphertext("push_message_002","cv_push","a",&bytes,Some(1)).await.unwrap();
        store.mark_seen("push_message_002","b").await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"seen messages are not alerted");
        store.save_ciphertext("push_message_003","cv_push","a",&bytes,Some(1)).await.unwrap();
        let stale_job=store.due_push().await.unwrap().remove(0);
        store.finish_push(&stale_job,true).await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"unregistered token is disabled");
        store.register_push("b","b-session-abcdefghijklmnopqrstuvwxyz123456",installation,"rotated-push-token-at-least-20-characters",true,false).await.unwrap();
        assert_eq!(store.due_push().await.unwrap().len(),2,"rotation recovers invalid-token job and unread accepted job");
        store.defer_push(&stale_job,3600).await.unwrap();
        assert_eq!(store.due_push().await.unwrap().len(),2,"old-token retry cannot delay the new token's job");
        assert!(!store.claim_push(&stale_job).await.unwrap(),"stale token snapshot cannot claim a rotated installation");
        store.finish_push(&stale_job,false).await.unwrap();
        assert_eq!(store.due_push().await.unwrap().len(),2,"late old-token success cannot finish a new-token job");
        let current_job=store.due_push().await.unwrap().remove(0);
        conn.execute("INSERT INTO user_settings(uid,notifications_enabled) VALUES('b',0)",()).await.unwrap();
        assert!(!store.claim_push(&current_job).await.unwrap(),"notification preference changed after query must be respected at claim time");
        store.revoke_session("b-session-abcdefghijklmnopqrstuvwxyz123456").await.unwrap();
        assert!(store.due_push().await.unwrap().is_empty(),"revoked sessions cannot receive pushes");
        // Account switch on the same installation removes old-account queued jobs.
        store.register_push("c","c-session-abcdefghijklmnopqrstuvwxyz123456",installation,token,true,false).await.unwrap();
        let mut rows=conn.query("SELECT COUNT(*) FROM push_jobs WHERE recipient_uid='b'",()).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(),0);
        drop(rows);
        store.unregister_push("b","b-session-abcdefghijklmnopqrstuvwxyz123456",installation).await.unwrap();
        let mut rows=conn.query("SELECT uid FROM push_devices WHERE installation_id=?1",[installation]).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<String>(0).unwrap(),"c");
        drop(rows);
        store.unregister_push("c","c-session-abcdefghijklmnopqrstuvwxyz123456",installation).await.unwrap();
        let mut rows=conn.query("SELECT COUNT(*) FROM push_devices",()).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(),0);
    }
}
