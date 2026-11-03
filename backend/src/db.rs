use anyhow::{anyhow, Context, Result};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use libsql::{Builder, Database};
use password_hash::SaltString;
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};

static PASSWORD_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));

async fn password_work<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let permit = tokio::time::timeout(std::time::Duration::from_secs(5), PASSWORD_SLOTS.clone().acquire_owned())
        .await.context("login capacity busy; retry shortly")??;
    tokio::task::spawn_blocking(move || { let _permit = permit; work() }).await.context("password worker stopped")?
}

use uuid::Uuid;

use crate::protocol::{ConversationSummary, MessageEnvelope, UserSummary};

#[derive(Clone)]
pub struct Store { db: Arc<Database> }

#[derive(Debug, Clone)]
pub struct PendingDelivery {
    pub message: MessageEnvelope,
    pub recipient_uid: String,
}

impl Store {
    #[cfg(test)]
    pub async fn load_test_store(path: &str, users: &[String]) -> Result<Self> {
        let db = Builder::new_local(path).build().await?;
        let store = Self { db: Arc::new(db) };
        store.migrate().await?;
        let conn = store.connection().await?;
        for uid in users {
            conn.execute("INSERT INTO users(uid,username,display_name,password_hash) VALUES(?1,?1,?1,'test-fixture-not-a-password')", [uid.as_str()]).await?;
        }
        Ok(store)
    }

    pub async fn connect(url: &str, token: &str) -> Result<Self> {
        anyhow::ensure!(url.starts_with("libsql://") || url.starts_with("https://"), "TURSO_DATABASE_URL must be the database connection URL, not app.turso.tech");
        anyhow::ensure!(!token.trim().is_empty() && !token.starts_with("PASTE_"), "Set TURSO_AUTH_TOKEN in backend/.env");
        let db = Builder::new_remote(url.to_owned(), token.to_owned())
            .build().await.context("connect to Turso/libSQL remote database")?;
        Ok(Self { db: Arc::new(db) })
    }

    async fn connection(&self) -> Result<libsql::Connection> {
        let conn = self.db.connect()?;
        // Local SQLite connections do not inherit the migration connection's
        // busy handler. Remote transports may not support this local API.
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        Ok(conn)
    }

    pub async fn set_avatar(&self, uid: &str, data_uri: Option<&str>) -> Result<String> {
        let uri = data_uri.unwrap_or("");
        if !uri.is_empty() {
            let encoded = uri.strip_prefix("data:image/jpeg;base64,").ok_or_else(|| anyhow!("JPEG avatar required"))?;
            anyhow::ensure!(encoded.len() <= 21336, "Avatar must be at most 16 KB");
            let bytes = STANDARD.decode(encoded).context("invalid avatar encoding")?;
            validate_avatar(&bytes)?;
        }
        let version = hex_digest(uri.as_bytes());
        self.connection().await?.execute("INSERT INTO profile_avatars(uid,version,data_uri) VALUES(?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET version=excluded.version,data_uri=excluded.data_uri", libsql::params![uid, version.clone(), uri]).await?;
        Ok(version)
    }
    pub async fn get_avatar(&self, uid: &str, version: Option<&str>) -> Result<(String, Option<String>)> {
        anyhow::ensure!(uid.len() <= 80, "invalid user");
        let mut rows = self.connection().await?.query("SELECT version,data_uri FROM profile_avatars WHERE uid=?1", [uid]).await?;
        if let Some(row) = rows.next().await? {
            let current: String = row.get(0)?;
            let uri: String = row.get(1)?;
            let data = if version == Some(current.as_str()) || uri.is_empty() { None } else { Some(uri) };
            Ok((current, data))
        } else { Ok((String::new(), None)) }
    }

    pub async fn chat_themes(&self, id: Option<&str>) -> Result<serde_json::Value> {
        let conn = self.connection().await?;
        if let Some(id) = id {
            let mut rows = conn.query("SELECT id,name,version,data_uri FROM chat_theme_assets WHERE id=?1 AND enabled=1", [id]).await?;
            let row = rows.next().await?.ok_or_else(|| anyhow!("Theme unavailable"))?;
            return Ok(serde_json::json!({"id":row.get::<String>(0)?,"name":row.get::<String>(1)?,"version":row.get::<String>(2)?,"data_uri":row.get::<String>(3)?}));
        }
        let mut rows = conn.query("SELECT id,name,version FROM chat_theme_assets WHERE enabled=1 ORDER BY id", ()).await?;
        let mut themes = Vec::new();
        while let Some(row) = rows.next().await? { themes.push(serde_json::json!({"id":row.get::<String>(0)?,"name":row.get::<String>(1)?,"version":row.get::<String>(2)?})); }
        Ok(serde_json::json!(themes))
    }

    pub async fn migrate(&self) -> Result<()> {
        let conn = self.connection().await?;
        let _ = conn.execute("PRAGMA foreign_keys = ON", ()).await;
        let _ = conn.execute("PRAGMA busy_timeout = 10000", ()).await;
        let statements = [
            "CREATE TABLE IF NOT EXISTS profile_avatars (uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE, version TEXT NOT NULL, data_uri TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS chat_theme_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, data_uri TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)",
            "CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, about TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS user_profiles (uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE, display_name TEXT NOT NULL, about TEXT NOT NULL DEFAULT '', avatar_url TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY NOT NULL, uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, device_name TEXT NOT NULL DEFAULT 'Android Client', push_token TEXT, registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE INDEX IF NOT EXISTS idx_devices_uid ON devices(uid)",
            "CREATE TABLE IF NOT EXISTS device_identity_keys (device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE, uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, identity_key TEXT NOT NULL, signed_prekey TEXT NOT NULL, signed_prekey_signature TEXT NOT NULL, registration_id INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE INDEX IF NOT EXISTS idx_device_identity_keys_uid ON device_identity_keys(uid)",
            "CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY NOT NULL, uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE INDEX IF NOT EXISTS idx_auth_sessions_uid ON auth_sessions(uid)",
            "CREATE TABLE IF NOT EXISTS device_sessions (token_hash TEXT PRIMARY KEY NOT NULL, uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE INDEX IF NOT EXISTS idx_device_sessions_uid ON device_sessions(uid)",
            "CREATE TABLE IF NOT EXISTS conversations (conversation_id TEXT PRIMARY KEY NOT NULL, pair_key TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES users(uid), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE, uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (conversation_id, uid))",
            "CREATE INDEX IF NOT EXISTS idx_conversation_members_uid ON conversation_members(uid)",
            "CREATE TABLE IF NOT EXISTS messages (message_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id), sender_uid TEXT NOT NULL REFERENCES users(uid), recipient_uid TEXT NOT NULL REFERENCES users(uid), ciphertext BLOB NOT NULL, created_at TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'SAVED' CHECK(status IN ('SAVED','DELIVERED','SEEN')))",
            "CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages(recipient_uid, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)",
            "CREATE TABLE IF NOT EXISTS message_delivery_status (message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE, recipient_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'SAVED' CHECK(status IN ('SAVED','DELIVERED','SEEN')), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (message_id, recipient_uid))",
            "CREATE INDEX IF NOT EXISTS idx_delivery_status_recipient ON message_delivery_status(recipient_uid, status)",
            "CREATE TABLE IF NOT EXISTS user_presence (uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE, is_online INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS user_contacts (uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, contact_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, is_blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (uid, contact_uid))",
            "CREATE INDEX IF NOT EXISTS idx_user_contacts_contact ON user_contacts(contact_uid)",
            "CREATE TABLE IF NOT EXISTS user_settings (uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE, theme TEXT NOT NULL DEFAULT 'dark', notifications_enabled INTEGER NOT NULL DEFAULT 1, read_receipts_enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS sdui_configs (config_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, schema_json TEXT NOT NULL, signature TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS ui_configs (config_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, schema_json TEXT NOT NULL, signature TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE, recipient_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT)",
            "CREATE TABLE IF NOT EXISTS message_outbox (event_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE, recipient_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT)",
            "CREATE INDEX IF NOT EXISTS idx_message_outbox_pending ON message_outbox(recipient_uid, delivered_at, next_attempt_at)",
            "CREATE TABLE IF NOT EXISTS prekey_bundles (uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE, bundle_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
            "CREATE TABLE IF NOT EXISTS database_schema_version (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, description TEXT NOT NULL)",
            "INSERT OR IGNORE INTO database_schema_version (version, description) VALUES (1, 'Initial complete Nexa Chat schema')",
        ];
        for sql in statements { conn.execute(sql, ()).await?; }

        // Upgrade databases created by the first starter ZIP without dropping user data.
        let mut columns = conn.query("PRAGMA table_info(outbox)", ()).await?;
        let mut has_attempts = false;
        let mut has_next_attempt_at = false;
        while let Some(row) = columns.next().await? {
            let name: String = row.get(1)?;
            has_attempts |= name == "attempts";
            has_next_attempt_at |= name == "next_attempt_at";
        }
        if !has_attempts {
            conn.execute("ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0", ()).await?;
        }
        if !has_next_attempt_at {
            conn.execute("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0", ()).await?;
        }
        // Upgrade messages table with msg_type column if missing
        let mut msg_columns = conn.query("PRAGMA table_info(messages)", ()).await?;
        let mut has_msg_type = false;
        while let Some(row) = msg_columns.next().await? {
            let name: String = row.get(1)?;
            has_msg_type |= name == "msg_type";
        }
        if !has_msg_type {
            let _ = conn.execute("ALTER TABLE messages ADD COLUMN msg_type INTEGER NOT NULL DEFAULT 0", ()).await;
        }
        // Create this index only after upgrading older outbox tables.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(recipient_uid, delivered_at, next_attempt_at)", ()).await?;
        // Message and durable delivery event commit together, in one SQL statement.
        conn.execute("CREATE TRIGGER IF NOT EXISTS messages_enqueue_delivery AFTER INSERT ON messages BEGIN INSERT INTO outbox (event_id, message_id, recipient_uid, next_attempt_at) VALUES ('deliver:' || NEW.message_id, NEW.message_id, NEW.recipient_uid, CAST(strftime('%s', 'now') AS INTEGER)); END", ()).await?;
        conn.execute("CREATE TRIGGER IF NOT EXISTS messages_finish_delivery AFTER UPDATE OF status ON messages WHEN NEW.status IN ('DELIVERED', 'SEEN') BEGIN UPDATE outbox SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP) WHERE message_id = NEW.message_id AND recipient_uid = NEW.recipient_uid; END", ()).await?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_sender_saved ON messages(sender_uid, saved_at)", ()).await?;
        Ok(())
    }

    pub async fn register(&self, username: &str, display_name: &str, password: &str) -> Result<(UserSummary, String)> {
        let username = normalize_username(username)?;
        let display_name = display_name.trim();
        anyhow::ensure!(display_name.chars().count() >= 2 && display_name.chars().count() <= 60, "display name must be 2-60 characters");
        validate_password(password)?;
        let password = password.to_owned();
        let password_hash = password_work(move || {
            let salt = SaltString::generate(&mut OsRng);
            Ok(Argon2::default().hash_password(password.as_bytes(), &salt)?.to_string())
        }).await?;
        let uid = format!("nx_{}", Uuid::new_v4().simple());
        let conn = self.connection().await?;
        conn.execute(
            "INSERT INTO users (uid, username, display_name, password_hash) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![uid.clone(), username.clone(), display_name.to_owned(), password_hash],
        ).await.context("create account; username may already be taken")?;
        let token = self.issue_session(&uid).await?;
        Ok((UserSummary { uid, username, display_name: display_name.to_owned(), about: String::new(), online: true }, token))
    }

    pub async fn login(&self, username: &str, password: &str) -> Result<(UserSummary, String)> {
        let username = normalize_username(username)?;
        let (uid, stored_username, display_name, about, stored_hash): (String, String, String, String, String) = {
            let conn = self.connection().await?;
            let mut rows = conn.query(
                "SELECT uid, username, display_name, about, password_hash FROM users WHERE username = ?1 COLLATE NOCASE",
                libsql::params![username],
            ).await?;
            let row = rows.next().await?.ok_or_else(|| anyhow!("invalid username or password"))?;
            (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)
        };

        let password = password.to_owned();
        password_work(move || {
            let parsed = PasswordHash::new(&stored_hash).map_err(|_| anyhow!("invalid username or password"))?;
            Argon2::default().verify_password(password.as_bytes(), &parsed).map_err(|_| anyhow!("invalid username or password"))
        }).await?;
        let token = self.issue_session(&uid).await?;
        Ok((UserSummary { uid, username: stored_username, display_name, about, online: true }, token))
    }

    pub async fn authenticate(&self, token: &str) -> Result<UserSummary> {
        anyhow::ensure!(token.len() >= 32 && token.len() <= 256, "invalid session token");
        let token_hash = hex_digest(token.as_bytes());
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "SELECT u.uid, u.username, u.display_name, u.about FROM device_sessions s JOIN users u ON u.uid = s.uid WHERE s.token_hash = ?1 AND s.expires_at > ?2",
            libsql::params![token_hash, now_seconds()],
        ).await?;
        let row = rows.next().await?.ok_or_else(|| anyhow!("invalid or expired session"))?;
        Ok(UserSummary {
            uid: row.get(0)?, username: row.get(1)?, display_name: row.get(2)?, about: row.get(3)?, online: true,
        })
    }

    pub async fn revoke_session(&self, token: &str) -> Result<()> {
        anyhow::ensure!(token.len() >= 32 && token.len() <= 256, "invalid session token");
        let conn = self.connection().await?;
        conn.execute("DELETE FROM device_sessions WHERE token_hash = ?1", libsql::params![hex_digest(token.as_bytes())]).await?;
        Ok(())
    }

    async fn issue_session(&self, uid: &str) -> Result<String> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let token_hash = hex_digest(token.as_bytes());
        let expires_at = now_seconds() + 60 * 60 * 24 * 30;
        let conn = self.connection().await?;
        conn.execute(
            "INSERT INTO device_sessions (token_hash, uid, expires_at) VALUES (?1, ?2, ?3)",
            libsql::params![token_hash, uid.to_owned(), expires_at],
        ).await?;
        Ok(token)
    }

    pub async fn search_users(&self, current_uid: &str, query: &str) -> Result<Vec<UserSummary>> {
        let raw_query = query.trim();
        let q = raw_query.strip_prefix('@').unwrap_or(raw_query);
        anyhow::ensure!(q.chars().count() >= 2 && q.chars().count() <= 40, "search query must be 2-40 characters");
        let pattern = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "SELECT uid, username, display_name, about FROM users WHERE uid <> ?1 AND (username LIKE ?2 ESCAPE '\\' COLLATE NOCASE OR display_name LIKE ?2 ESCAPE '\\' COLLATE NOCASE) ORDER BY username LIMIT 30",
            libsql::params![current_uid.to_owned(), pattern],
        ).await?;
        let mut users = Vec::new();
        while let Some(row) = rows.next().await? {
            users.push(UserSummary {
                uid: row.get(0)?, username: row.get(1)?, display_name: row.get(2)?, about: row.get(3)?, online: false,
            });
        }
        Ok(users)
    }

    pub async fn update_profile(&self, uid: &str, display_name: &str, about: &str) -> Result<UserSummary> {
        let display_name = display_name.trim();
        let about = about.trim();
        anyhow::ensure!((2..=60).contains(&display_name.chars().count()), "display name must be 2-60 characters");
        anyhow::ensure!(about.chars().count() <= 160, "about text must be at most 160 characters");
        let conn = self.connection().await?;
        let changed = conn.execute(
            "UPDATE users SET display_name = ?1, about = ?2 WHERE uid = ?3",
            libsql::params![display_name.to_owned(), about.to_owned(), uid.to_owned()],
        ).await?;
        anyhow::ensure!(changed == 1, "user not found");
        self.get_user(uid).await
    }

    pub async fn get_user(&self, uid: &str) -> Result<UserSummary> {
        let conn = self.connection().await?;
        let mut rows = conn.query("SELECT uid, username, display_name, about FROM users WHERE uid = ?1", libsql::params![uid.to_owned()]).await?;
        let row = rows.next().await?.ok_or_else(|| anyhow!("user not found"))?;
        Ok(UserSummary { uid: row.get(0)?, username: row.get(1)?, display_name: row.get(2)?, about: row.get(3)?, online: false })
    }

    pub async fn create_or_get_conversation(&self, current_uid: &str, other_uid: &str) -> Result<()> {
        anyhow::ensure!(current_uid != other_uid, "cannot create a conversation with yourself");
        let (left, right) = if current_uid < other_uid { (current_uid, other_uid) } else { (other_uid, current_uid) };
        let pair_key = format!("{left}:{right}");
        let conn = self.connection().await?;
        let tx = conn.transaction().await?;
        let mut user_rows = tx.query("SELECT COUNT(*) FROM users WHERE uid IN (?1, ?2)", libsql::params![current_uid.to_owned(), other_uid.to_owned()]).await?;
        let user_count: i64 = user_rows.next().await?.ok_or_else(|| anyhow!("user lookup failed"))?.get(0)?;
        anyhow::ensure!(user_count == 2, "user not found");
        let proposed_id = format!("cv_{}", Uuid::new_v4().simple());
        tx.execute(
            "INSERT OR IGNORE INTO conversations (conversation_id, pair_key, created_by, created_at) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![proposed_id, pair_key.clone(), current_uid.to_owned(), now_epoch_string()],
        ).await?;
        let mut rows = tx.query("SELECT conversation_id FROM conversations WHERE pair_key = ?1", libsql::params![pair_key]).await?;
        let conversation_id: String = rows.next().await?.ok_or_else(|| anyhow!("could not create conversation"))?.get(0)?;
        tx.execute("INSERT OR IGNORE INTO conversation_members (conversation_id, uid) VALUES (?1, ?2), (?1, ?3)",
            libsql::params![conversation_id, current_uid.to_owned(), other_uid.to_owned()]).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_conversations(&self, uid: &str, limit: i64) -> Result<Vec<ConversationSummary>> {
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "SELECT c.conversation_id, u.uid, u.username, u.display_name, u.about, COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.conversation_id), c.created_at) AS updated_at, (SELECT COUNT(*) FROM messages unread WHERE unread.conversation_id = c.conversation_id AND unread.recipient_uid = ?1 AND unread.status <> 'SEEN') AS unread_count, EXISTS(SELECT 1 FROM messages any_message WHERE any_message.conversation_id = c.conversation_id) AS has_messages FROM conversations c JOIN conversation_members mine ON mine.conversation_id = c.conversation_id AND mine.uid = ?1 JOIN conversation_members other ON other.conversation_id = c.conversation_id AND other.uid <> ?1 JOIN users u ON u.uid = other.uid ORDER BY updated_at DESC LIMIT ?2",
            libsql::params![uid.to_owned(), limit.clamp(1, 100)],
        ).await?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().await? {
            result.push(ConversationSummary {
                conversation_id: row.get(0)?,
                user: UserSummary {
                    uid: row.get(1)?, username: row.get(2)?, display_name: row.get(3)?, about: row.get(4)?, online: false,
                },
                updated_at: row.get(5)?,
                unread_count: row.get(6)?,
                has_messages: row.get::<i64>(7)? != 0,
            });
        }
        Ok(result)
    }

    /// Return only users who share at least one conversation with this account.
    /// Presence is not broadcast globally; a user's online state is visible only to contacts.
    pub async fn conversation_contacts(&self, uid: &str) -> Result<Vec<String>> {
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "SELECT DISTINCT other.uid FROM conversation_members mine JOIN conversation_members other ON other.conversation_id = mine.conversation_id AND other.uid <> mine.uid WHERE mine.uid = ?1 ORDER BY other.uid",
            libsql::params![uid.to_owned()],
        ).await?;
        let mut contacts = Vec::new();
        while let Some(row) = rows.next().await? { contacts.push(row.get(0)?); }
        Ok(contacts)
    }

    pub async fn get_conversation_id(&self, current_uid: &str, other_uid: &str) -> Result<String> {
        let (left, right) = if current_uid < other_uid { (current_uid, other_uid) } else { (other_uid, current_uid) };
        let pair_key = format!("{left}:{right}");
        let conn = self.connection().await?;
        let mut rows = conn.query("SELECT c.conversation_id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.conversation_id WHERE c.pair_key = ?1 AND m.uid = ?2", libsql::params![pair_key, current_uid.to_owned()]).await?;
        let row = rows.next().await?.ok_or_else(|| anyhow!("conversation not found"))?;
        Ok(row.get(0)?)
    }

    pub async fn history(&self, uid: &str, conversation_id: &str, before: Option<&str>, limit: i64) -> Result<Vec<MessageEnvelope>> {
        let conn = self.connection().await?;
        let mut member = conn.query("SELECT 1 FROM conversation_members WHERE conversation_id = ?1 AND uid = ?2", libsql::params![conversation_id.to_owned(), uid.to_owned()]).await?;
        anyhow::ensure!(member.next().await?.is_some(), "not a conversation member");
        let cursor = before.unwrap_or("");
        if !cursor.is_empty() { validate_message_id(cursor)?; }
        let mut rows = conn.query(
            "SELECT message_id, conversation_id, sender_uid, ciphertext, created_at, status, msg_type FROM messages WHERE conversation_id = ?1 AND (?3 = '' OR EXISTS (SELECT 1 FROM messages cursor WHERE cursor.message_id = ?3 AND cursor.conversation_id = messages.conversation_id AND (CAST(messages.created_at AS INTEGER) < CAST(cursor.created_at AS INTEGER) OR (CAST(messages.created_at AS INTEGER) = CAST(cursor.created_at AS INTEGER) AND messages.message_id < cursor.message_id)))) ORDER BY CAST(created_at AS INTEGER) DESC, message_id DESC LIMIT ?2",
            libsql::params![conversation_id.to_owned(), limit.clamp(1, 100), cursor.to_owned()],
        ).await?;
        let mut messages = Vec::new();
        while let Some(row) = rows.next().await? {
            let bytes: Vec<u8> = row.get(3)?;
            let mt: i64 = row.get(6).unwrap_or(0);
            messages.push(MessageEnvelope {
                message_id: row.get(0)?, conversation_id: row.get(1)?, sender_uid: row.get(2)?,
                ciphertext_b64: STANDARD.encode(bytes), msg_type: if mt != 0 { Some(mt as u8) } else { None }, created_at: row.get(4)?, status: row.get(5)?,
            });
        }
        messages.reverse();
        Ok(messages)
    }

    /// Saves only opaque ciphertext, verifies membership, and atomically adds an outbox row.
    pub async fn save_ciphertext(&self, message_id: &str, conversation_id: &str, sender_uid: &str, ciphertext: &[u8], msg_type: Option<u8>) -> Result<(String, bool)> {
        validate_message_id(message_id)?;
        anyhow::ensure!(!ciphertext.is_empty() && ciphertext.len() <= 10 * 1024 * 1024, "invalid ciphertext size");
        let conn = self.connection().await?;
        // Atomic conditional insert: authorization, one-to-one membership, quota
        // and outbox creation execute inside SQLite, without remote read/write gaps.
        let mut rows = conn.query(
            "INSERT INTO messages (message_id, conversation_id, sender_uid, recipient_uid, ciphertext, created_at, status, msg_type) SELECT ?1, ?2, ?3, other.uid, ?4, ?5, 'SAVED', ?6 FROM conversation_members other WHERE other.conversation_id = ?2 AND other.uid <> ?3 AND EXISTS (SELECT 1 FROM conversation_members mine WHERE mine.conversation_id = ?2 AND mine.uid = ?3) AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?2) = 2 AND (SELECT COUNT(*) FROM messages WHERE sender_uid = ?3 AND saved_at >= datetime('now', '-1 minute')) < 60 ON CONFLICT(message_id) DO NOTHING RETURNING recipient_uid",
            libsql::params![message_id.to_owned(), conversation_id.to_owned(), sender_uid.to_owned(), ciphertext.to_vec(), now_epoch_string(), msg_type.unwrap_or(0) as i64],
        ).await?;
        if let Some(row) = rows.next().await? {
            let recipient: String = row.get(0)?;
            anyhow::ensure!(rows.next().await?.is_none(), "ambiguous recipient");
            return Ok((recipient, true));
        }
        drop(rows);
        // Lost-ACK retries are idempotent, but an ID cannot replace prior content,
        // message type, sender or conversation. Revalidate current membership.
        let mut existing = conn.query(
            "SELECT m.recipient_uid, m.ciphertext, m.msg_type FROM messages m WHERE m.message_id = ?1 AND m.sender_uid = ?2 AND m.conversation_id = ?3 AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = ?3 AND uid = ?2)",
            libsql::params![message_id.to_owned(), sender_uid.to_owned(), conversation_id.to_owned()],
        ).await?;
        let row = existing.next().await?.ok_or_else(|| anyhow!("message rejected: membership, quota or conflicting message id"))?;
        let prior: Vec<u8> = row.get(1)?;
        let prior_type: i64 = row.get(2)?;
        anyhow::ensure!(prior == ciphertext && prior_type == msg_type.unwrap_or(0) as i64, "message_id was already used with different content");
        Ok((row.get(0)?, false))
    }

    /// Fast path: lookup recipient UID for a 1-on-1 conversation
    pub async fn get_conversation_recipient(&self, conversation_id: &str, sender_uid: &str) -> Result<String> {
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "SELECT uid FROM conversation_members WHERE conversation_id = ?1 AND uid <> ?2 LIMIT 1",
            libsql::params![conversation_id.to_owned(), sender_uid.to_owned()],
        ).await?;
        let r: String = rows.next().await?.ok_or_else(|| anyhow!("conversation member not found"))?.get(0)?;
        Ok(r)
    }

    /// Fast path: asynchronously saves message and schedules outbox row with minimal statements
    pub async fn save_ciphertext_direct(
        &self,
        message_id: &str,
        conversation_id: &str,
        sender_uid: &str,
        recipient_uid: &str,
        ciphertext: &[u8],
        msg_type: Option<u8>,
    ) -> Result<()> {
        let conn = self.connection().await?;
        let created_at = if let Some(ts_str) = message_id.strip_prefix("m_").and_then(|rest| rest.split('_').next()) {
            if let Ok(ts_ms) = ts_str.parse::<u64>() {
                if ts_ms > 100_000_000_000 {
                    format!("{}", ts_ms / 1000)
                } else {
                    now_epoch_string()
                }
            } else {
                now_epoch_string()
            }
        } else {
            now_epoch_string()
        };
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO messages (message_id, conversation_id, sender_uid, recipient_uid, ciphertext, created_at, status, msg_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SAVED', ?7)",
            libsql::params![message_id.to_owned(), conversation_id.to_owned(), sender_uid.to_owned(), recipient_uid.to_owned(), ciphertext.to_vec(), created_at, msg_type.unwrap_or(0) as i64],
        ).await?;
        if inserted == 1 {
            let event_id = format!("deliver:{message_id}");
            let next_attempt = now_seconds();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO outbox (event_id, message_id, recipient_uid, next_attempt_at) VALUES (?1, ?2, ?3, ?4)",
                libsql::params![event_id, message_id.to_owned(), recipient_uid.to_owned(), next_attempt],
            ).await;
        }
        Ok(())
    }

    pub async fn pending_deliveries(&self, recipient_uid: &str, limit: i64) -> Result<Vec<PendingDelivery>> {
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "SELECT m.message_id, m.conversation_id, m.sender_uid, m.ciphertext, m.created_at, m.status, m.msg_type FROM outbox o JOIN messages m ON m.message_id = o.message_id WHERE o.recipient_uid = ?1 AND o.delivered_at IS NULL AND o.next_attempt_at <= ?2 ORDER BY o.rowid ASC LIMIT ?3",
            libsql::params![recipient_uid.to_owned(), now_seconds(), limit.clamp(1, 100)],
        ).await?;
        let mut items = Vec::new();
        while let Some(row) = rows.next().await? {
            let bytes: Vec<u8> = row.get(3)?;
            let mt: i64 = row.get(6).unwrap_or(0);
            items.push(PendingDelivery {
                message: MessageEnvelope {
                    message_id: row.get(0)?, conversation_id: row.get(1)?, sender_uid: row.get(2)?,
                    ciphertext_b64: STANDARD.encode(bytes), msg_type: if mt != 0 { Some(mt as u8) } else { None }, created_at: row.get(4)?, status: row.get(5)?,
                },
                recipient_uid: recipient_uid.to_owned(),
            });
        }
        Ok(items)
    }

    /// Bounded indexed query for a batch of connected accounts. Each recipient
    /// gets at most four messages per pass so a large inbox cannot starve others.
    pub async fn pending_online_deliveries(&self, recipients: &[String]) -> Result<Vec<PendingDelivery>> {
        anyhow::ensure!(recipients.len() <= 100, "online delivery batch too large");
        if recipients.is_empty() { return Ok(Vec::new()); }
        let placeholders = (0..recipients.len()).map(|i| format!("?{}", i + 2)).collect::<Vec<_>>().join(",");
        let sql = format!("WITH due AS (SELECT o.message_id,o.recipient_uid,ROW_NUMBER() OVER (PARTITION BY o.recipient_uid ORDER BY o.next_attempt_at,o.rowid) AS position FROM outbox o WHERE o.delivered_at IS NULL AND o.next_attempt_at <= ?1 AND o.recipient_uid IN ({placeholders})) SELECT m.message_id,m.conversation_id,m.sender_uid,m.ciphertext,m.created_at,m.status,m.msg_type,d.recipient_uid FROM due d JOIN messages m ON m.message_id=d.message_id WHERE d.position <= 4");
        let mut params = vec![libsql::Value::Integer(now_seconds())];
        params.extend(recipients.iter().cloned().map(libsql::Value::Text));
        let conn = self.connection().await?;
        let mut rows = conn.query(&sql, libsql::params_from_iter(params)).await?;
        let mut items = Vec::new();
        while let Some(row) = rows.next().await? {
            let bytes: Vec<u8> = row.get(3)?;
            let mt: i64 = row.get(6).unwrap_or(0);
            items.push(PendingDelivery {
                message: MessageEnvelope {
                    message_id: row.get(0)?, conversation_id: row.get(1)?, sender_uid: row.get(2)?,
                    ciphertext_b64: STANDARD.encode(bytes), msg_type: if mt != 0 { Some(mt as u8) } else { None },
                    created_at: row.get(4)?, status: row.get(5)?,
                }, recipient_uid: row.get(7)?,
            });
        }
        Ok(items)
    }

    /// Atomically claims a due outbox event before network send, preventing two workers
    /// from sending the same retry simultaneously. A failed send is retried after backoff.
    pub async fn claim_delivery_attempt(&self, message_id: &str, recipient_uid: &str) -> Result<bool> {
        let conn = self.connection().await?;
        let changed = conn.execute(
            "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?3 + CASE WHEN attempts = 0 THEN 2 WHEN attempts = 1 THEN 5 WHEN attempts = 2 THEN 12 WHEN attempts = 3 THEN 30 ELSE 60 END WHERE message_id = ?1 AND recipient_uid = ?2 AND delivered_at IS NULL AND next_attempt_at <= ?3",
            libsql::params![message_id.to_owned(), recipient_uid.to_owned(), now_seconds()],
        ).await?;
        Ok(changed == 1)
    }

    pub async fn mark_delivered(&self, message_id: &str, recipient_uid: &str) -> Result<Option<String>> {
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "UPDATE messages SET status = CASE WHEN status = 'SEEN' THEN 'SEEN' ELSE 'DELIVERED' END WHERE message_id = ?1 AND recipient_uid = ?2 RETURNING sender_uid",
            libsql::params![message_id.to_owned(), recipient_uid.to_owned()],
        ).await?;
        let sender = match rows.next().await? { Some(row) => Some(row.get::<String>(0)?), None => None };
        let _ = rows.next().await?;
        Ok(sender)
    }

    pub async fn mark_seen(&self, message_id: &str, recipient_uid: &str) -> Result<Option<String>> {
        let conn = self.connection().await?;
        let mut rows = conn.query(
            "UPDATE messages SET status = 'SEEN' WHERE message_id = ?1 AND recipient_uid = ?2 RETURNING sender_uid",
            libsql::params![message_id.to_owned(), recipient_uid.to_owned()],
        ).await?;
        let sender = match rows.next().await? { Some(row) => Some(row.get::<String>(0)?), None => None };
        let _ = rows.next().await?;
        Ok(sender)
    }

    pub async fn save_prekey_bundle(&self, uid: &str, bundle_json: &str) -> Result<()> {
        let conn = self.connection().await?;
        conn.execute(
            "INSERT INTO prekey_bundles (uid, bundle_json, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(uid) DO UPDATE SET bundle_json = excluded.bundle_json, updated_at = CURRENT_TIMESTAMP",
            libsql::params![uid.to_owned(), bundle_json.to_owned()],
        ).await?;
        Ok(())
    }

    pub async fn get_prekey_bundle(&self, uid: &str) -> Result<Option<String>> {
        let conn = self.connection().await?;
        let mut rows = conn.query("SELECT bundle_json FROM prekey_bundles WHERE uid = ?1", libsql::params![uid.to_owned()]).await?;
        if let Some(row) = rows.next().await? {
            let bundle: String = row.get(0)?;
            Ok(Some(bundle))
        } else {
            Ok(None)
        }
    }
}

fn normalize_username(value: &str) -> Result<String> {
    let raw = value.trim();
    let raw = raw.strip_prefix('@').unwrap_or(raw);
    let username = raw.to_ascii_lowercase();
    anyhow::ensure!((3..=24).contains(&username.len()), "username must be 3-24 characters");
    anyhow::ensure!(username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.'), "username may only contain letters, digits, _ and .");
    Ok(username)
}

fn validate_password(password: &str) -> Result<()> {
    anyhow::ensure!(password.len() >= 6 && password.len() <= 128, "password must be 6-128 bytes");
    Ok(())
}

fn validate_message_id(id: &str) -> Result<()> {
    anyhow::ensure!((8..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'), "invalid message ID");
    Ok(())
}

fn hex_digest(input: &[u8]) -> String {
    Sha256::digest(input).iter().map(|b| format!("{b:02x}")).collect()
}

fn now_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

/// Store a sortable Unix-seconds value as text for cross-device message cursors.
pub fn now_epoch_string() -> String { format!("{}", now_seconds()) }

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn avatar_roundtrip_version_cache_removal_and_bounds() {
        let path = format!("target/avatar-{}.db", uuid::Uuid::new_v4());
        let store = super::Store::load_test_store(&path, &["avatar-a".into(),"avatar-b".into()]).await.unwrap();
        let bytes=include_bytes!("../testdata/avatar.jpg");
        let uri=format!("data:image/jpeg;base64,{}",base64::Engine::encode(&base64::engine::general_purpose::STANDARD,bytes));
        let version=store.set_avatar("avatar-a",Some(&uri)).await.unwrap();
        assert_eq!(store.get_avatar("avatar-a",None).await.unwrap(),(version.clone(),Some(uri.clone())));
        assert_eq!(store.get_avatar("avatar-a",Some(&version)).await.unwrap(),(version.clone(),None));
        assert_eq!(store.set_avatar("avatar-a",Some(&uri)).await.unwrap(),version);
        assert_eq!(store.get_avatar("avatar-b",None).await.unwrap(),(String::new(),None));
        assert!(store.set_avatar("avatar-a",Some("data:image/svg+xml;base64,AA==")).await.is_err());
        assert!(super::validate_avatar(&vec![0;16001]).is_err());
        let mut large=bytes.to_vec();
        for p in 0..large.len()-8 {if large[p]==255 && large[p+1]==192 {large[p+5]=2;large[p+6]=0;break;}}
        assert!(super::validate_avatar(&large).is_err());
        store.set_avatar("avatar-a",None).await.unwrap();
        assert!(store.get_avatar("avatar-a",Some(&version)).await.unwrap().1.is_none());
        drop(store);let _=std::fs::remove_file(path);
    }
    use super::*;

    #[tokio::test]
    #[ignore = "Requires an explicitly configured disposable remote Turso database; writes integration fixtures"]
    async fn remote_turso_connection_test() {
        dotenvy::dotenv().ok();
        if let (Ok(url), Ok(token)) = (std::env::var("TURSO_DATABASE_URL"), std::env::var("TURSO_AUTH_TOKEN")) {
            if !url.is_empty() && !token.is_empty() && !token.starts_with("PASTE_") {
                let store = Store::connect(&url, &token).await.expect("Failed to connect to Turso");
                store.migrate().await.expect("Failed to run Turso migrations");

                // Test duplicate message prevention directly on live Turso
                let test_suffix = Uuid::new_v4().simple().to_string();
                let u1_name = format!("turso_dup_a_{}", &test_suffix[..8]);
                let u2_name = format!("turso_dup_b_{}", &test_suffix[..8]);
                let (u1, _) = store.register(&u1_name, "TursoA", "tursoPass123!").await.expect("Register u1");
                let (u2, _) = store.register(&u2_name, "TursoB", "tursoPass123!").await.expect("Register u2");
                store.create_or_get_conversation(&u1.uid, &u2.uid).await.expect("Create conversation");
                let conv_id = store.get_conversation_id(&u1.uid, &u2.uid).await.expect("Get conv_id");

                let test_msg_id = format!("turso_msg_{}", test_suffix);
                let ciphertext = vec![0x33, 0x11, 0x22, 0x33];

                // First delivery attempt
                let (rec1, is_new1) = store.save_ciphertext(&test_msg_id, &conv_id, &u1.uid, &ciphertext, None).await.expect("Save 1");
                assert_eq!(rec1, u2.uid);
                assert!(is_new1, "Live Turso: First delivery attempt must be marked as new");

                // Duplicate delivery attempt with identical payload
                let (rec2, is_new2) = store.save_ciphertext(&test_msg_id, &conv_id, &u1.uid, &ciphertext, None).await.expect("Save 2");
                assert_eq!(rec2, u2.uid);
                assert!(!is_new2, "Live Turso: Duplicate delivery attempt must NOT be marked as new");

                // Outbox check: exactly one outbox event created
                let pending = store.pending_deliveries(&u2.uid, 10).await.expect("Pending");
                let matches: Vec<_> = pending.into_iter().filter(|p| p.message.message_id == test_msg_id).collect();
                assert_eq!(matches.len(), 1, "Live Turso: Exactly one outbox delivery event must exist");

                // Live Turso: Test login with correct password
                let login_ok = store.login(&u1_name, "tursoPass123!").await;
                assert!(login_ok.is_ok(), "Live Turso: Correct password must log in");

                // Live Turso: Test login with INCORRECT password
                let login_bad = store.login(&u1_name, "wrongPassword999!").await;
                assert!(login_bad.is_err(), "Live Turso: Incorrect password MUST BE REJECTED");
            }
        }
    }

    #[tokio::test]
    async fn test_password_verification_and_login_security() {
        let temp_db_path = format!("target/test_auth_{}.db", Uuid::new_v4().simple());
        let db = Builder::new_local(&temp_db_path).build().await.unwrap();
        let store = Store { db: Arc::new(db) };
        store.migrate().await.unwrap();

        let username = "secure_alice";
        let valid_password = "superSecurePassword123!";
        let (u, token) = store.register(username, "Alice", valid_password).await.unwrap();
        assert!(!token.is_empty());
        assert_eq!(u.username, username);

        // Test A: Correct password -> Login SUCCESS
        let res_a = store.login(username, valid_password).await;
        assert!(res_a.is_ok(), "Test A failed: Correct password must succeed: {:?}", res_a.err());
        let (user_a, token_a) = res_a.unwrap();
        assert_eq!(user_a.uid, u.uid);
        assert!(!token_a.is_empty());

        // Test H: Login failure -> No new session created
        let count_sessions = || async {
            let conn = store.connection().await.unwrap();
            let mut rows = conn.query("SELECT COUNT(*) FROM device_sessions", ()).await.unwrap();
            let row = rows.next().await.unwrap().unwrap();
            row.get::<i64>(0).unwrap()
        };
        let sessions_before = count_sessions().await;

        // Test B: Incorrect password -> Login REJECTED
        let res_b = store.login(username, "totallyWrongPassword123!").await;
        assert!(res_b.is_err(), "Test B failed: Incorrect password MUST be rejected");
        assert_eq!(res_b.unwrap_err().to_string(), "invalid username or password");

        let sessions_after = count_sessions().await;
        assert_eq!(sessions_before, sessions_after, "Test H failed: Failed login must not create any session");

        // Test C: Random password -> Login REJECTED
        let res_c = store.login(username, "RandomPassword!@#$%^&*()").await;
        assert!(res_c.is_err(), "Test C failed: Random password MUST be rejected");

        // Test D: Unknown username -> Login REJECTED
        let res_d = store.login("non_existent_user_999", valid_password).await;
        assert!(res_d.is_err(), "Test D failed: Unknown username MUST be rejected");

        // Test E: Empty or short password -> Login REJECTED
        let res_e = store.login(username, "").await;
        assert!(res_e.is_err(), "Test E failed: Empty password MUST be rejected");

        // Test F: Modified database password hash -> Login REJECTED
        {
            let conn = store.connection().await.unwrap();
            conn.execute("UPDATE users SET password_hash = 'corrupted_hash' WHERE username = ?1", libsql::params![username]).await.unwrap();
        }
        let res_f = store.login(username, valid_password).await;
        assert!(res_f.is_err(), "Test F failed: Corrupted hash MUST be rejected");

        // Test J: Invalid or expired session -> Access denied
        let res_j = store.authenticate("random_forged_session_token_32_bytes_long").await;
        assert!(res_j.is_err(), "Test J failed: Forged session must be rejected");

        // Test K: Logout -> Previous session can no longer authenticate
        let (_u2, token_k) = store.register("bob_logout", "Bob", "bobPassword123!").await.unwrap();
        assert!(store.authenticate(&token_k).await.is_ok());
        store.revoke_session(&token_k).await.unwrap();
        assert!(store.authenticate(&token_k).await.is_err(), "Test K failed: Revoked session must not authenticate");

        // Test L: Password storage format verification -> Argon2id only, never plaintext
        {
            let conn = store.connection().await.unwrap();
            let mut rows = conn.query("SELECT password_hash FROM users WHERE username = 'bob_logout'", ()).await.unwrap();
            let row = rows.next().await.unwrap().unwrap();
            let stored_hash: String = row.get(0).unwrap();
            assert!(stored_hash.starts_with("$argon2id$"), "Test L failed: Stored password must be Argon2id hash");
            assert!(!stored_hash.contains("bobPassword123!"), "Test L failed: Plaintext password must never appear in database");
        }

        // Test G: Database connection failure -> Login REJECTED
        {
            let dead_db = Builder::new_local("target/non_existent_dir_12345/unreachable.db").build().await;
            if let Ok(db) = dead_db {
                let dead_store = Store { db: Arc::new(db) };
                let res_g = dead_store.login("alice", "anyPassword123!").await;
                assert!(res_g.is_err(), "Test G failed: Database failure must reject login");
            }
        }

        let _ = std::fs::remove_file(&temp_db_path);
    }

    #[tokio::test]
    async fn duplicate_message_prevention_test() {
        let temp_db_path = format!("target/test_dup_{}.db", Uuid::new_v4().simple());
        let db = Builder::new_local(&temp_db_path).build().await.unwrap();
        let store = Store { db: Arc::new(db) };
        store.migrate().await.unwrap();

        let (u1, _) = store.register("alice_dup", "Alice", "password123").await.unwrap();
        let (u2, _) = store.register("bob_dup", "Bob", "password123").await.unwrap();
        store.create_or_get_conversation(&u1.uid, &u2.uid).await.unwrap();
        let conv_id = store.get_conversation_id(&u1.uid, &u2.uid).await.unwrap();

        let msg_id = "msg_test_dup_001";
        let ciphertext = vec![0x33, 0x01, 0x02, 0x03];

        let (recipient, is_new1) = store.save_ciphertext(msg_id, &conv_id, &u1.uid, &ciphertext, None).await.unwrap();
        assert_eq!(recipient, u2.uid);
        assert!(is_new1, "First delivery attempt must be marked as new");

        let (recipient2, is_new2) = store.save_ciphertext(msg_id, &conv_id, &u1.uid, &ciphertext, None).await.unwrap();
        assert_eq!(recipient2, u2.uid);
        assert!(!is_new2, "Duplicate delivery attempt must NOT be marked as new");

        let outsider = store.register("outsider_dup", "Outsider", "password123").await.unwrap().0;
        assert!(store.save_ciphertext("msg_outsider_001", &conv_id, &outsider.uid, &ciphertext, Some(1)).await.is_err());

        let conflict_bytes = vec![0x33, 0x99, 0x88];
        let conflict_res = store.save_ciphertext(msg_id, &conv_id, &u1.uid, &conflict_bytes, None).await;
        assert!(conflict_res.is_err(), "Conflicting message payload with same ID must be rejected");

        let pending = store.pending_deliveries(&u2.uid, 10).await.unwrap();
        assert_eq!(pending.len(), 1, "There must be exactly one pending delivery in outbox");
        assert_eq!(pending[0].message.message_id, msg_id);

        let _ = std::fs::remove_file(&temp_db_path);
    }

    #[tokio::test]
    async fn atomic_message_pipeline_and_receipts() {
        let path = format!("target/test_pipeline_{}.db", Uuid::new_v4().simple());
        let db = Builder::new_local(&path).build().await.unwrap();
        let store = Store { db: Arc::new(db) };
        store.migrate().await.unwrap();
        let conn = store.connection().await.unwrap();
        conn.execute_batch("INSERT INTO users(uid,username,display_name,password_hash) VALUES ('a','alice','Alice','test'),('b','bob','Bob','test'),('c','carol','Carol','test'); INSERT INTO conversations(conversation_id,pair_key,created_by) VALUES ('cv_atomic','a:b','a'); INSERT INTO conversation_members(conversation_id,uid) VALUES ('cv_atomic','a'),('cv_atomic','b');").await.unwrap();
        let bytes = vec![0x33, 1, 2, 3];
        assert!(store.save_ciphertext("atomic_msg_001", "cv_atomic", "a", &bytes, Some(1)).await.unwrap().1);
        assert!(!store.save_ciphertext("atomic_msg_001", "cv_atomic", "a", &bytes, Some(1)).await.unwrap().1);
        assert!(store.save_ciphertext("atomic_msg_001", "cv_atomic", "a", &bytes, Some(3)).await.is_err());
        assert!(store.save_ciphertext("atomic_forged", "cv_atomic", "c", &bytes, Some(1)).await.is_err());
        assert!(store.mark_seen("atomic_msg_001", "c").await.unwrap().is_none());
        assert_eq!(store.mark_seen("atomic_msg_001", "b").await.unwrap(), Some("a".to_owned()));
        store.mark_delivered("atomic_msg_001", "b").await.unwrap();
        let mut rows = conn.query("SELECT m.status, o.delivered_at IS NOT NULL FROM messages m JOIN outbox o USING(message_id) WHERE message_id = 'atomic_msg_001'", ()).await.unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(row.get::<String>(0).unwrap(), "SEEN");
        assert_eq!(row.get::<i64>(1).unwrap(), 1);
        drop(row);
        let _ = rows.next().await.unwrap();
        drop(rows);
        conn.execute("CREATE TRIGGER fail_test_outbox BEFORE INSERT ON outbox WHEN NEW.message_id = 'fail_atomic_001' BEGIN SELECT RAISE(ABORT, 'test outbox unavailable'); END", ()).await.unwrap();
        assert!(store.save_ciphertext("fail_atomic_001", "cv_atomic", "a", &bytes, Some(1)).await.is_err());
        let mut rows = conn.query("SELECT COUNT(*) FROM messages WHERE message_id = 'fail_atomic_001'", ()).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 0);
        drop(rows);
        conn.execute_batch("WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<59) INSERT INTO messages(message_id,conversation_id,sender_uid,recipient_uid,ciphertext,created_at,msg_type) SELECT 'quota_' || x,'cv_atomic','a','b',X'33010203','1',1 FROM seq;").await.unwrap();
        let quota_error = store.save_ciphertext("quota_blocked_001", "cv_atomic", "a", &bytes, Some(1)).await.unwrap_err();
        assert!(quota_error.to_string().contains("quota"), "unexpected error: {quota_error}");
        assert!(!store.save_ciphertext("atomic_msg_001", "cv_atomic", "a", &bytes, Some(1)).await.unwrap().1);
    }

    #[test]
    fn username_is_normalized_and_restricted() {
        assert_eq!(normalize_username("  @Alice_01 ").unwrap(), "alice_01");
        assert!(normalize_username("ab").is_err());
        assert!(normalize_username("alice name").is_err());
        assert!(normalize_username("alice/../bob").is_err());
        assert!(normalize_username("@@alice").is_err());
    }

    #[test]
    fn passwords_have_reasonable_bounds() {
        assert!(validate_password("correct horse battery").is_ok());
        assert!(validate_password("short").is_err());
        assert!(validate_password(&"x".repeat(129)).is_err());
    }

    #[test]
    fn message_ids_are_ascii_and_bounded() {
        assert!(validate_message_id("msg_123456").is_ok());
        assert!(validate_message_id("bad id 123").is_err());
        assert!(validate_message_id("短いmessage").is_err());
    }
}

fn validate_avatar(bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(bytes.len() <= 16000 && bytes.starts_with(&[255,216]) && bytes.ends_with(&[255,217]), "Invalid JPEG avatar");
    let mut p=2;
    while p+4 <= bytes.len() {
        anyhow::ensure!(bytes[p]==255, "Invalid JPEG marker");
        let marker=bytes[p+1];p+=2;
        if marker==255 {p-=1;continue;}
        let len=u16::from_be_bytes([bytes[p],bytes[p+1]]) as usize;
        anyhow::ensure!(len>=2 && p+len<=bytes.len(), "Invalid JPEG segment");
        if matches!(marker,192|193|194) {
            anyhow::ensure!(len>=8, "Invalid JPEG dimensions");
            let h=u16::from_be_bytes([bytes[p+3],bytes[p+4]]);let w=u16::from_be_bytes([bytes[p+5],bytes[p+6]]);
            anyhow::ensure!(w>0 && h>0 && w<=256 && h<=256, "Avatar dimensions must be at most 256 pixels");
            return Ok(());
        }
        anyhow::ensure!(marker!=218 && marker!=217, "Missing JPEG dimensions");p+=len;
    }
    Err(anyhow!("Missing JPEG dimensions"))
}
