-- Nexa Chat Comprehensive Schema Migration
PRAGMA foreign_keys = ON;

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. User Profiles
CREATE TABLE IF NOT EXISTS user_profiles (
  uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Devices
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT 'Android Client',
  push_token TEXT,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_devices_uid ON devices(uid);

-- 4. Device Identity Keys (for E2EE prekeys and identity keys)
CREATE TABLE IF NOT EXISTS device_identity_keys (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  signed_prekey TEXT NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  registration_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_identity_keys_uid ON device_identity_keys(uid);

-- 5. Auth Sessions
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_uid ON auth_sessions(uid);

-- Legacy device_sessions table preserved for compatibility
CREATE TABLE IF NOT EXISTS device_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_uid ON device_sessions(uid);

-- 6. Conversations
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  pair_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(uid),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Conversation Members
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_uid ON conversation_members(uid);

-- 8. Messages
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  sender_uid TEXT NOT NULL REFERENCES users(uid),
  recipient_uid TEXT NOT NULL REFERENCES users(uid),
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'SAVED' CHECK(status IN ('SAVED','DELIVERED','SEEN'))
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages(recipient_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);

-- 9. Message Delivery Status
CREATE TABLE IF NOT EXISTS message_delivery_status (
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  recipient_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'SAVED' CHECK(status IN ('SAVED','DELIVERED','SEEN')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, recipient_uid)
);
CREATE INDEX IF NOT EXISTS idx_delivery_status_recipient ON message_delivery_status(recipient_uid, status);

-- 10. User Presence
CREATE TABLE IF NOT EXISTS user_presence (
  uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  is_online INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL DEFAULT 0
);

-- 11. User Contacts and Blocks
CREATE TABLE IF NOT EXISTS user_contacts (
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  contact_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (uid, contact_uid)
);
CREATE INDEX IF NOT EXISTS idx_user_contacts_contact ON user_contacts(contact_uid);

-- 12. User Settings
CREATE TABLE IF NOT EXISTS user_settings (
  uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'dark',
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  read_receipts_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 13. SDUI Configs
CREATE TABLE IF NOT EXISTS sdui_configs (
  config_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Legacy ui_configs table preserved
CREATE TABLE IF NOT EXISTS ui_configs (
  config_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 14. Message Outbox
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  recipient_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(recipient_uid, delivered_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS message_outbox (
  event_id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  recipient_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_outbox_pending ON message_outbox(recipient_uid, delivered_at, next_attempt_at);

-- 15. Database Schema Version
CREATE TABLE IF NOT EXISTS database_schema_version (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO database_schema_version (version, description) VALUES (1, 'Initial complete Nexa Chat schema');
