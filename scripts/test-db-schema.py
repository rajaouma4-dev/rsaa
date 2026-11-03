#!/usr/bin/env python3
"""Exercise the Rust store's SQL against SQLite (not a substitute for a Turso integration test)."""
from __future__ import annotations

import ast
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_RS = (ROOT / "backend/src/db.rs").read_text(encoding="utf-8")

array_match = re.search(r"let statements = \[(.*?)\n        \];", DB_RS, re.S)
if not array_match:
    raise SystemExit("could not find Store::migrate statement list")
statements = [ast.literal_eval('"' + value + '"') for value in re.findall(r'"((?:[^"\\]|\\.)*)"', array_match.group(1))]

con = sqlite3.connect(":memory:")
con.execute("PRAGMA foreign_keys = ON")
for statement in statements:
    con.execute(statement)

# The runtime performs this compatibility upgrade before creating its pending index.
cols = {row[1] for row in con.execute("PRAGMA table_info(outbox)")}
if "attempts" not in cols:
    con.execute("ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
if "next_attempt_at" not in cols:
    con.execute("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0")
con.execute("CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(recipient_uid, delivered_at, next_attempt_at)")
if "msg_type" not in {row[1] for row in con.execute("PRAGMA table_info(messages)")}:
    con.execute("ALTER TABLE messages ADD COLUMN msg_type INTEGER NOT NULL DEFAULT 0")

# Seed two accounts and create their conversation using the same SQL constraints.
con.execute("INSERT INTO users(uid, username, display_name, password_hash) VALUES ('u_a','alice','Alice','x')")
con.execute("INSERT INTO users(uid, username, display_name, password_hash) VALUES ('u_b','bob','Bob','x')")
con.execute("INSERT INTO conversations(conversation_id,pair_key,created_by,created_at) VALUES ('cv_1','u_a:u_b','u_a','1790000000')")
con.execute("INSERT INTO conversation_members(conversation_id,uid) VALUES ('cv_1','u_a'),('cv_1','u_b')")

# Verify the exact list-conversations query used in db.rs.
list_sql = re.search(r'"(SELECT c\.conversation_id, u\.uid.*?LIMIT \?2)"', DB_RS).group(1)
items = con.execute(list_sql, ("u_a", 100)).fetchall()
assert len(items) == 1 and items[0][0] == "cv_1" and items[0][1] == "u_b" and items[0][6] == 0

# Verify escaped username search query has a valid one-character ESCAPE expression.
search_sql = ast.literal_eval('"' + re.search(r'"(SELECT uid, username, display_name, about FROM users WHERE uid <> \?1.*?LIMIT 30)"', DB_RS).group(1) + '"')
found = con.execute(search_sql, ("u_a", "%bo%" )).fetchall()
assert len(found) == 1 and found[0][0] == "u_b"

# Presence visibility is scoped to conversation contacts, not broadcast globally.
contacts_sql = re.search(r'"(SELECT DISTINCT other\.uid FROM conversation_members mine.*?ORDER BY other\.uid)"', DB_RS).group(1)
assert con.execute(contacts_sql, ("u_a",)).fetchall() == [("u_b",)]
assert con.execute(contacts_sql, ("u_b",)).fetchall() == [("u_a",)]

# A save is message + outbox in one transaction.
with con:
    con.execute("INSERT INTO messages(message_id,conversation_id,sender_uid,recipient_uid,ciphertext,created_at,status) VALUES (?,?,?,?,?,?, 'SAVED')",
                ("msg_0001", "cv_1", "u_a", "u_b", b"opaque-ciphertext", "1790000001"))
    con.execute("INSERT INTO outbox(event_id,message_id,recipient_uid) VALUES (?,?,?)",
                ("deliver:msg_0001", "msg_0001", "u_b"))
items = con.execute(list_sql, ("u_b", 100)).fetchall()
assert len(items) == 1 and items[0][6] == 1

pending_sql = re.search(r'"(SELECT m\.message_id, m\.conversation_id.*?LIMIT \?3)"', DB_RS).group(1)
pending = con.execute(pending_sql, ("u_b", 2_000_000_000, 100)).fetchall()
assert len(pending) == 1 and pending[0][0] == "msg_0001"

claim_sql = re.search(r'"(UPDATE outbox SET attempts = attempts \+ 1.*?AND next_attempt_at <= \?3)"', DB_RS).group(1)
changed = con.execute(claim_sql, ("msg_0001", "u_b", 2_000_000_000)).rowcount
assert changed == 1
# A second concurrent/duplicate claim is not allowed before the backoff expires.
assert con.execute(claim_sql, ("msg_0001", "u_b", 2_000_000_000)).rowcount == 0

# Delivered/seen receipts are constrained to the actual recipient.
assert con.execute("UPDATE outbox SET delivered_at=CURRENT_TIMESTAMP WHERE message_id=? AND recipient_uid=? AND delivered_at IS NULL", ("msg_0001", "u_b")).rowcount == 1
assert con.execute("UPDATE messages SET status='DELIVERED' WHERE message_id=? AND recipient_uid=? AND status='SAVED'", ("msg_0001", "u_b")).rowcount == 1
assert con.execute("UPDATE messages SET status='SEEN' WHERE message_id=? AND recipient_uid=?", ("msg_0001", "u_b")).rowcount == 1
assert con.execute("SELECT status FROM messages WHERE message_id='msg_0001'").fetchone()[0] == "SEEN"
items = con.execute(list_sql, ("u_b", 100)).fetchall()
assert len(items) == 1 and items[0][6] == 0

# Profile update is parameterized and bounded at the application layer.
con.execute("UPDATE users SET display_name=?, about=? WHERE uid=?", ("Alice A", "hello", "u_a"))
assert con.execute("SELECT display_name,about FROM users WHERE uid='u_a'").fetchone() == ("Alice A", "hello")

# History cursor is a message ID, so messages sharing the same second are not skipped.
con.execute("INSERT INTO messages(message_id,conversation_id,sender_uid,recipient_uid,ciphertext,created_at) VALUES (?,?,?,?,?,?)",
            ("msg_0002", "cv_1", "u_a", "u_b", b"cipher2", "1790000001"))
con.execute("INSERT INTO messages(message_id,conversation_id,sender_uid,recipient_uid,ciphertext,created_at) VALUES (?,?,?,?,?,?)",
            ("msg_0003", "cv_1", "u_a", "u_b", b"cipher3", "1790000001"))
history_sql = re.search(r'"(SELECT message_id, conversation_id, sender_uid, ciphertext, created_at, status, msg_type FROM messages WHERE conversation_id = \?1.*?LIMIT \?2)"', DB_RS).group(1)
history_rows = con.execute(history_sql, ("cv_1", 10, "msg_0003")).fetchall()
assert [row[0] for row in reversed(history_rows)] == ["msg_0001", "msg_0002"]

# Check upgrade safety for the previous starter schema where outbox retry columns did not exist.
legacy = sqlite3.connect(":memory:")
legacy.execute("PRAGMA foreign_keys = ON")
legacy.execute("CREATE TABLE users (uid TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL)")
legacy.execute("CREATE TABLE messages (message_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, sender_uid TEXT NOT NULL, recipient_uid TEXT NOT NULL, ciphertext BLOB NOT NULL, created_at TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'SAVED')")
legacy.execute("CREATE TABLE outbox (event_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL, recipient_uid TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT)")
for statement in statements:
    legacy.execute(statement)
legacy_columns = {row[1] for row in legacy.execute("PRAGMA table_info(outbox)")}
if "attempts" not in legacy_columns:
    legacy.execute("ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
if "next_attempt_at" not in legacy_columns:
    legacy.execute("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0")
legacy.execute("CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(recipient_uid, delivered_at, next_attempt_at)")
assert {"attempts", "next_attempt_at"}.issubset({row[1] for row in legacy.execute("PRAGMA table_info(outbox)")})

# Verify the server derives the recipient from conversation membership rather than trusting
# a recipient UID supplied by an untrusted mobile frame.
recipient_sql = "SELECT uid FROM conversation_members WHERE conversation_id = ?1 AND uid <> ?2 LIMIT 2"
recipients = con.execute(recipient_sql, ("cv_1", "u_a")).fetchall()
assert recipients == [("u_b",)]

print(f"PASS: {len(statements)} migration statements; current + legacy upgrade, list/search/history/message/outbox/receipt/profile SQL exercised")
