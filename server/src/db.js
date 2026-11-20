import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,            -- lowercase email or name
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','tech','host')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  hash TEXT PRIMARY KEY,          -- sha256 of the one-time token
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,          -- sha256 of the session cookie value
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS surveys (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS survey_data (   -- raw / groups / game blobs
  survey_id TEXT NOT NULL,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (survey_id, name)
);
CREATE TABLE IF NOT EXISTS live (          -- what phones see
  code TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS display (       -- what the projector sees (never hidden answers)
  code TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (       -- one row per device per question
  code TEXT NOT NULL,
  uid TEXT NOT NULL,
  q INTEGER NOT NULL,
  a TEXT NOT NULL,
  t INTEGER NOT NULL,                      -- server time in microseconds (buzzer ordering)
  PRIMARY KEY (code, uid, q)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS answers_by_q ON answers (code, q, t);
CREATE TABLE IF NOT EXISTS ai_cache (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(dir) {
  let file = ':memory:';
  if (dir !== ':memory:') {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'gameshow.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}
