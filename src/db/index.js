import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDirs } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

/**
 * FTS5 可用性。
 *
 * `node:sqlite` 的编译选项因 Node 发行版而异 —— 官方 Windows/macOS 构建带 FTS5，
 * 但部分沙箱/精简构建没有（会在建虚表时报 `no such module: fts5`）。
 * 全文索引是搜索加速手段，不是核心存储，所以这里探测一次并允许降级到
 * LIKE 关键词检索，而不是让整个服务起不来。
 */
let ftsAvailable = null;

export function hasFts() {
  if (ftsAvailable !== null) return ftsAvailable;
  try {
    const probe = db || new DatabaseSync(':memory:');
    probe.exec('CREATE VIRTUAL TABLE __fts_probe USING fts5(x)');
    probe.exec('DROP TABLE __fts_probe');
    if (!db) probe.close();
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
  }
  return ftsAvailable;
}

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  hasFts();            // 探测一次，供 migrate 与检索逻辑复用
  migrate(db);
  return db;
}

export function migrate(handle = getDb()) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  if (hasFts()) {
    handle.exec(sql);
  } else {
    // 去掉 fts5 虚表定义后建表；搜索走 LIKE 降级路径
    const stripped = sql.replace(/CREATE VIRTUAL TABLE[\s\S]*?;\s*/gi, '');
    handle.exec(stripped);
  }
  // 已有库上的增量列。schema.sql 用的是 CREATE TABLE IF NOT EXISTS，
  // 对已经建好的表不会补列，所以后加的字段必须在这里单独 ALTER。
  addColumns(handle);
  const row = handle.prepare("SELECT value FROM settings WHERE key='schema_version'").get();
  if (!row) {
    handle.prepare("INSERT INTO settings(key,value) VALUES('schema_version','1')").run();
  }
  return handle;
}

/**
 * 给已存在的表补列（幂等）。
 *
 * SQLite 的 ADD COLUMN 不能带非常量默认值，所以全部用常量默认值，
 * 老数据自然落到「未设置」这个语义上，也很容易回滚。
 */
function addColumns(handle) {
  const wanted = [
    // 输出形态：text 只发文字 / voice 只发语音（历史上的 mixed 已废弃，读时归一化为 text）
    ['personas', 'voice_mode', "TEXT NOT NULL DEFAULT 'text'"],
    // 这条回复最后是以语音形式发出的（前端气泡形态靠它还原）
    ['messages', 'voice_audio_id', 'TEXT'],
    // 聊天界面外观：classic 现有样式 / wechat 复刻微信。
    // 存在用户上而不是 localStorage —— 换设备、换浏览器要保持一致，
    // 而且这是个"产品偏好"，和人格设置一样该跟着账号走。
    ['users', 'ui_theme', "TEXT NOT NULL DEFAULT 'classic'"],
  ];
  for (const [table, col, decl] of wanted) {
    let cols;
    try {
      cols = handle.prepare(`PRAGMA table_info(${table})`).all();
    } catch {
      continue; // 表还不存在（理论上不会，schema.sql 先跑过了）
    }
    if (cols.some((c) => c.name === col)) continue;
    try {
      handle.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    } catch (e) {
      // 并发启动第二个进程时可能撞上「duplicate column」，这种情况忽略即可
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
}

// ---- tiny helpers -------------------------------------------------
export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}
export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}
export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ---- vector helpers: float32 BLOB <-> Float32Array ----------------
export function toBlob(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
export function fromBlob(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
export function l2normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n);
  if (n === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

export function closeDb() {
  if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
}
