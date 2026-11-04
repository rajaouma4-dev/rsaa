-- Idempotent companion to Store::migrate. No plaintext or Firebase server keys.
CREATE TABLE IF NOT EXISTS push_devices (
    installation_id TEXT PRIMARY KEY,
    uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    session_hash TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    foreground_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_devices_uid ON push_devices(uid,enabled);
CREATE TABLE IF NOT EXISTS push_jobs (
    message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL REFERENCES push_devices(installation_id) ON DELETE CASCADE,
    recipient_uid TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(message_id,installation_id)
);
CREATE INDEX IF NOT EXISTS idx_push_jobs_due ON push_jobs(finished,next_attempt_at);
CREATE TRIGGER IF NOT EXISTS messages_enqueue_push AFTER INSERT ON messages BEGIN
    INSERT OR IGNORE INTO push_jobs(message_id,installation_id,recipient_uid,next_attempt_at)
        SELECT NEW.message_id,installation_id,NEW.recipient_uid,CAST(strftime('%s','now') AS INTEGER)
        FROM push_devices WHERE uid=NEW.recipient_uid AND enabled=1;
END;
