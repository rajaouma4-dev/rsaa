//! Separate encrypted profile storage; never insert profile updates into SMS history.
use anyhow::{anyhow, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{aead, rand::{SecureRandom, SystemRandom}};
use serde_json::{json, Value};
use crate::{db::Store, protocol::DataChannelServerFrame, webrtc_peer::{send_to_user, LiveChannels, LiveSignaling}};

fn storage_key() -> Result<aead::LessSafeKey> {
    let bytes = STANDARD.decode(std::env::var("PROFILE_STORAGE_KEY").map_err(|_| anyhow!("profile storage unavailable"))?)?;
    Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &bytes).map_err(|_| anyhow!("invalid profile key"))?))
}
pub fn configured() -> bool { storage_key().is_ok() }
fn seal(uid: &str, value: &Value) -> Result<Vec<u8>> {
    let mut nonce = [0u8; 12]; SystemRandom::new().fill(&mut nonce).map_err(|_| anyhow!("random unavailable"))?;
    let mut bytes = serde_json::to_vec(value)?;
    storage_key()?.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(uid.as_bytes()), &mut bytes).map_err(|_| anyhow!("profile encryption failed"))?;
    Ok([nonce.to_vec(), bytes].concat())
}
fn open(uid: &str, bytes: &[u8]) -> Result<Value> {
    ensure!(bytes.len() >= 28, "invalid profile record");
    let nonce: [u8; 12] = bytes[..12].try_into()?; let mut data = bytes[12..].to_vec();
    let plain = storage_key()?.open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(uid.as_bytes()), &mut data).map_err(|_| anyhow!("profile authentication failed"))?;
    Ok(serde_json::from_slice(plain)?)
}
fn text<'a>(body: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let value = body[key].as_str().ok_or_else(|| anyhow!("missing field"))?;
    ensure!(value.len() <= max, "field too large"); Ok(value)
}
fn public_profile(value: &Value, revision: i64) -> Result<Value> {
    let input = value["fields"].as_object().ok_or_else(|| anyhow!("invalid public projection"))?;
    let mut fields = serde_json::Map::new();
    for (key, value) in input {
        let limit = match key.as_str() { "name" => 240, "about" => 640, "gender" | "relationship" => 128, "photo" | "cover" => 21400, _ => return Err(anyhow!("unknown public field")) };
        let string = value.as_str().ok_or_else(|| anyhow!("invalid public field"))?;
        ensure!(string.len() <= limit, "public field too large");
        if (key == "photo" || key == "cover") && !string.is_empty() {
            let encoded = string.strip_prefix("data:image/jpeg;base64,").ok_or_else(|| anyhow!("JPEG required"))?;
            let image = STANDARD.decode(encoded)?;
            crate::db::validate_profile_image(&image,if key=="cover" {720}else{256},if key=="cover" {320}else{256})?;
        }
        fields.insert(key.clone(), value.clone());
    }
    let result = json!({"revision":revision,"fields":fields});
    ensure!(serde_json::to_vec(&result)?.len() <= 44500, "profile too large"); Ok(result)
}
fn validate_owner(owner: &str) -> Result<()> {
    ensure!(!owner.is_empty() && owner.len() <= 61000, "invalid owner ciphertext");
    let opaque: Value=serde_json::from_str(owner)?;
    ensure!(opaque["v"]==1 && STANDARD.decode(text(&opaque,"iv",24)?)?.len()==12 && STANDARD.decode(text(&opaque,"data",60000)?)?.len()>=16,"encrypted owner backup required");Ok(())
}

pub async fn handle(db: &Store, uid: &str, action: &str, body: &Value, channels: &LiveChannels, signaling: &LiveSignaling) -> Result<Value> {
    let conn = db.connection().await?;
    match action {
        "stage" => {
            let revision=body["revision"].as_i64().filter(|r|*r>0 && *r<=9_007_199_254_740_991).ok_or_else(||anyhow!("invalid revision"))?;
            let owner=text(body,"ciphertext",61000)?;validate_owner(owner)?;
            conn.execute("INSERT INTO secure_profile_staging(uid,revision,ciphertext) VALUES(?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext WHERE excluded.revision >= secure_profile_staging.revision",libsql::params![uid,revision,owner]).await?;
            Ok(json!({"staged":true}))
        }
        "store" => {
            let revision = body["revision"].as_i64().filter(|r| *r > 0 && *r <= 9_007_199_254_740_991).ok_or_else(|| anyhow!("invalid revision"))?;
            let owner = if let Some(value)=body["ciphertext"].as_str() {value.to_owned()} else {
                let mut rows=conn.query("SELECT ciphertext FROM secure_profile_staging WHERE uid=?1 AND revision=?2",libsql::params![uid,revision]).await?;
                let row=rows.next().await?.ok_or_else(||anyhow!("profile stage missing"))?;row.get::<String>(0)?
            };
            validate_owner(&owner)?;
            let public = public_profile(&body["public"], revision)?;
            let encrypted = seal(uid, &public)?;
            let tx = conn.transaction().await?;
            let changed = tx.execute("INSERT INTO secure_profiles(uid,revision,owner_ciphertext,public_ciphertext) VALUES(?1,?2,?3,?4) ON CONFLICT(uid) DO UPDATE SET revision=excluded.revision,owner_ciphertext=excluded.owner_ciphertext,public_ciphertext=excluded.public_ciphertext WHERE excluded.revision > secure_profiles.revision", libsql::params![uid, revision, owner, encrypted]).await?;
            if changed == 0 { tx.rollback().await?; return Ok(json!({"error":"PROFILE_CONFLICT"})); }
            // Legacy searchable fields must no longer expose private names/about/photos.
            tx.execute("UPDATE users SET display_name=username,about='' WHERE uid=?1", [uid]).await?;
            tx.execute("UPDATE user_profiles SET display_name=(SELECT username FROM users WHERE uid=?1),about='',avatar_url=NULL WHERE uid=?1", [uid]).await?;
            tx.execute("DELETE FROM profile_avatars WHERE uid=?1", [uid]).await?;
            tx.execute("DELETE FROM secure_profile_staging WHERE uid=?1 AND revision<=?2",libsql::params![uid,revision]).await?;
            tx.commit().await?;
            let live = signaling.clone(); let data = channels.clone(); let owner = uid.to_owned();
            tokio::spawn(async move {
                let targets: Vec<_> = live.read().await.keys().cloned().collect();
                for target in targets { send_to_user(&data, &live, &target, &DataChannelServerFrame::ProfileChanged {uid:owner.clone(),revision}).await; }
            });
            Ok(json!({"saved":true,"revision":revision}))
        }
        "load" => {
            let mut rows = conn.query("SELECT owner_ciphertext,revision FROM secure_profiles WHERE uid=?1", [uid]).await?;
            if let Some(row) = rows.next().await? { Ok(json!({"ciphertext":row.get::<String>(0)?,"revision":row.get::<i64>(1)?})) }
            else { Ok(json!({"ciphertext":null,"revision":0})) }
        }
        "public" => {
            let target = text(body, "uid", 80)?;
            let mut rows = conn.query("SELECT public_ciphertext FROM secure_profiles WHERE uid=?1", [target]).await?;
            if let Some(row) = rows.next().await? { open(target, &row.get::<Vec<u8>>(0)?) }
            else { Ok(json!({"revision":0,"fields":{}})) }
        }
        "publish" => {
            let id = text(body, "event_id", 128)?; ensure!(!id.is_empty() && id.is_ascii(), "invalid event");
            let conversation = text(body, "conversation_id", 160)?;
            let recipient = db.get_conversation_recipient(conversation, uid).await?;
            let cipher = text(body, "ciphertext_b64", 60000)?;
            let bytes = STANDARD.decode(cipher)?;
            let kind = body["msg_type"].as_u64().filter(|n| *n == 1 || *n == 3).ok_or_else(|| anyhow!("invalid Signal type"))?;
            ensure!(bytes.len() >= 2 && bytes[0] & 15 <= 3 && bytes[0] >> 4 >= 3, "Signal ciphertext required");
            let changed = conn.execute("INSERT INTO secure_profile_events(event_id,owner_uid,recipient_uid,ciphertext,msg_type,created_at) SELECT ?1,?2,?3,?4,?5,?6 WHERE (SELECT COUNT(*) FROM secure_profile_events WHERE owner_uid=?2)<1000 ON CONFLICT(event_id) DO NOTHING", libsql::params![id,uid,recipient.clone(),bytes.clone(),kind as i64,crate::db::now_epoch_string()]).await?;
            if changed == 0 {
                let mut rows=conn.query("SELECT event_id FROM secure_profile_events WHERE event_id=?1 AND owner_uid=?2 AND recipient_uid=?3 AND ciphertext=?4 AND msg_type=?5",libsql::params![id,uid,recipient.clone(),bytes,kind as i64]).await?;
                ensure!(rows.next().await?.is_some(),"profile queue full or event conflict");
            }
            send_to_user(channels, signaling, &recipient, &DataChannelServerFrame::ProfileUpdate{event_id:id.to_owned(),from_uid:uid.to_owned(),ciphertext_b64:cipher.to_owned(),msg_type:kind as u8}).await;
            Ok(json!({"saved":true}))
        }
        "pending" => {
            let mut rows = conn.query("SELECT event_id,owner_uid,ciphertext,msg_type FROM secure_profile_events WHERE recipient_uid=?1 ORDER BY rowid LIMIT 1", [uid]).await?;
            let mut events=Vec::new();
            if let Some(row)=rows.next().await? { events.push(json!({"event_id":row.get::<String>(0)?,"from_uid":row.get::<String>(1)?,"ciphertext_b64":STANDARD.encode(row.get::<Vec<u8>>(2)?),"msg_type":row.get::<i64>(3)?})); }
            Ok(json!({"events":events}))
        }
        "ack" => { let id=text(body,"event_id",128)?;conn.execute("DELETE FROM secure_profile_events WHERE event_id=?1 AND recipient_uid=?2",libsql::params![id,uid]).await?;Ok(json!({"acked":true})) }
        "request" => {
            let conversation=text(body,"conversation_id",160)?;let peer=db.get_conversation_recipient(conversation,uid).await?;
            send_to_user(channels,signaling,&peer,&DataChannelServerFrame::ProfileRequest{from_uid:uid.to_owned()}).await;
            Ok(json!({"requested":true}))
        }
        _ => Err(anyhow!("unsupported profile operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn opaque_owner_public_encryption_and_recipient_bound_queue() {
        // Test process owns this variable and runs this one profile-key fixture.
        unsafe { std::env::set_var("PROFILE_STORAGE_KEY", STANDARD.encode([37u8;32])); }
        let db=Store::load_test_store(&format!("target/profiles-{}.db",uuid::Uuid::new_v4()),&["pa".into(),"pb".into(),"pc".into()]).await.unwrap();
        db.create_or_get_conversation("pa","pb").await.unwrap();let conv=db.get_conversation_id("pa","pb").await.unwrap();
        let channels=std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));let signaling=std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
        let owner=json!({"v":1,"iv":STANDARD.encode([0u8;12]),"data":STANDARD.encode([42u8;32])}).to_string();
        let stored=handle(&db,"pa","store",&json!({"revision":1,"ciphertext":owner,"public":{"fields":{"about":"PUBLIC_PROFILE_MARKER"}}}),&channels,&signaling).await.unwrap();assert_eq!(stored["saved"],true);
        let raw=db.connection().await.unwrap().query("SELECT public_ciphertext,owner_ciphertext FROM secure_profiles WHERE uid='pa'",()).await.unwrap().next().await.unwrap().unwrap();
        let bytes=raw.get::<Vec<u8>>(0).unwrap();drop(raw);assert!(!bytes.windows(21).any(|w|w==b"PUBLIC_PROFILE_MARKER"));assert!(open("pb",&bytes).is_err());
        let public=handle(&db,"pb","public",&json!({"uid":"pa"}),&channels,&signaling).await.unwrap();assert_eq!(public["fields"]["about"],"PUBLIC_PROFILE_MARKER");assert!(public.get("ciphertext").is_none());
        assert!(db.update_profile("pa","Old client","must not restore plaintext").await.is_err());
        assert!(db.set_avatar("pa",None).await.is_err());
        assert!(handle(&db,"pb","load",&json!({}),&channels,&signaling).await.unwrap()["ciphertext"].is_null());
        let packet=json!({"event_id":"pf-event-1","conversation_id":conv,"ciphertext_b64":STANDARD.encode([0x33,1,2,3]),"msg_type":3});
        assert!(handle(&db,"pc","publish",&packet,&channels,&signaling).await.is_err());
        assert_eq!(handle(&db,"pa","publish",&packet,&channels,&signaling).await.unwrap()["saved"],true);
        handle(&db,"pc","ack",&json!({"event_id":"pf-event-1"}),&channels,&signaling).await.unwrap();
        assert_eq!(handle(&db,"pb","pending",&json!({}),&channels,&signaling).await.unwrap()["events"].as_array().unwrap().len(),1);
        handle(&db,"pb","ack",&json!({"event_id":"pf-event-1"}),&channels,&signaling).await.unwrap();
        assert!(handle(&db,"pb","pending",&json!({}),&channels,&signaling).await.unwrap()["events"].as_array().unwrap().is_empty());
        assert!(handle(&db,"pa","store",&json!({"revision":2,"ciphertext":"x","public":{"fields":{"unknown":"secret"}}}),&channels,&signaling).await.is_err());
    }
}
