PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar_path   TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  email_verified INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 第三方身份（微信 / 手机号）。users.email 是 NOT NULL，而微信登录拿不到邮箱，
-- 所以单独一张表把外部身份映射到本地用户，不硬塞假邮箱进 users。
-- (provider, subject) 唯一 —— 一个微信号只能属于一个账号，防止抢绑。
CREATE TABLE IF NOT EXISTS user_identities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,           -- wechat | phone
  subject     TEXT NOT NULL,           -- openid / unionid / 规范化后的手机号
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_unique ON user_identities(provider, subject);
CREATE INDEX IF NOT EXISTS idx_identity_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- password_reset | email_verify | email_change
  payload    TEXT,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS llm_configs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url    TEXT NOT NULL,
  api_key_enc TEXT,
  model       TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  last_tested_at INTEGER,
  last_test_ok   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_user ON llm_configs(user_id);

CREATE TABLE IF NOT EXISTS tts_configs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'auto',   -- breezeblue | breeze_local | auto
  base_url    TEXT NOT NULL,
  api_key_enc TEXT,
  model       TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  detected_kind TEXT,
  last_tested_at INTEGER,
  last_test_ok   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tts_user ON tts_configs(user_id);

CREATE TABLE IF NOT EXISTS voice_refs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  file_path   TEXT,
  mime        TEXT,
  bytes       INTEGER,
  ref_text    TEXT,
  remote_voice_id TEXT,
  provider    TEXT,
  consent     INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_user ON voice_refs(user_id);

CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  avatar_path TEXT,
  bio         TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT 'zh',
  similarity_mode TEXT NOT NULL DEFAULT 'natural',  -- free | natural | high
  llm_config_id TEXT,
  tts_config_id TEXT,
  voice_ref_id  TEXT,
  auto_speak    INTEGER NOT NULL DEFAULT 0,
  voice_mode    TEXT NOT NULL DEFAULT 'text',     -- text | voice | mixed（随机，更像真人）
  status        TEXT NOT NULL DEFAULT 'active',
  analysis_status TEXT NOT NULL DEFAULT 'none',   -- none | queued | running | ready | failed
  analysis_error TEXT,
  analyzed_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personas_user ON personas(user_id);

CREATE TABLE IF NOT EXISTS import_files (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id    TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_path   TEXT,
  bytes         INTEGER NOT NULL DEFAULT 0,
  mime          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|parsing|parsed|failed
  parser        TEXT,
  error         TEXT,
  message_total INTEGER NOT NULL DEFAULT 0,
  message_new   INTEGER NOT NULL DEFAULT 0,
  message_dup   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_persona ON import_files(persona_id);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  chat_id     TEXT,
  import_id   TEXT,
  role        TEXT NOT NULL,             -- user | persona | system
  sender_raw  TEXT,                      -- original speaker label from import
  content     TEXT NOT NULL,
  msg_type    TEXT NOT NULL DEFAULT 'text',
  ts          INTEGER,
  seq         INTEGER NOT NULL DEFAULT 0,
  is_imported INTEGER NOT NULL DEFAULT 1,
  is_persona_voice INTEGER NOT NULL DEFAULT 0,
  voice_audio_id   TEXT,
  dedupe_hash TEXT,
  meta_json   TEXT,
  deleted_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_persona_ts ON messages(persona_id, ts, seq);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedupe ON messages(persona_id, dedupe_hash) WHERE dedupe_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '新的对话',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chats_persona ON chats(persona_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL DEFAULT 1,
  data_json   TEXT NOT NULL,
  model       TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_persona ON profiles(persona_id, is_active);

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'fact',  -- fact|event|topic|preference|agreement|nickname|quote|other
  content     TEXT NOT NULL,
  salience    INTEGER NOT NULL DEFAULT 3,    -- 1..5
  confidence  REAL NOT NULL DEFAULT 0.6,
  source_type TEXT NOT NULL DEFAULT 'manual',-- manual|analysis|chat|import
  source_ref  TEXT,
  happened_at INTEGER,
  embedding   BLOB,
  embed_model TEXT,
  dedupe_hash TEXT,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  edited      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_persona ON memories(persona_id, is_deleted);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_dedupe ON memories(persona_id, dedupe_hash) WHERE dedupe_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_chunks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  start_ts    INTEGER,
  end_ts      INTEGER,
  start_seq   INTEGER,
  end_seq     INTEGER,
  content     TEXT NOT NULL,
  persona_lines TEXT,
  embedding   BLOB,
  embed_model TEXT,
  msg_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_persona ON memory_chunks(persona_id, start_seq);

CREATE TABLE IF NOT EXISTS tts_audio (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT REFERENCES personas(id) ON DELETE CASCADE,
  message_id  TEXT,
  tts_config_id TEXT,
  voice_ref_id  TEXT,
  text_hash   TEXT NOT NULL,
  text        TEXT NOT NULL,
  file_path   TEXT,
  mime        TEXT,
  bytes       INTEGER,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|ready|failed
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_cache ON tts_audio(user_id, text_hash, IFNULL(voice_ref_id,''), IFNULL(tts_config_id,''));
CREATE INDEX IF NOT EXISTS idx_tts_msg ON tts_audio(message_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id  TEXT,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|canceled
  progress    REAL NOT NULL DEFAULT 0,
  stage       TEXT,
  payload_json TEXT,
  result_json TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  meta_json  TEXT,
  ip         TEXT,
  ua         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Full text search: bigram tokenization done in app layer for CJK support
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content_tok,
  memory_id UNINDEXED,
  persona_id UNINDEXED
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content_tok,
  chunk_id UNINDEXED,
  persona_id UNINDEXED
);
