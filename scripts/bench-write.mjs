/**
 * 微基准：拆开 persistMessages 的三个可疑点，看看到底是谁在超线性恶化。
 *
 * 怀疑对象：
 *   A. 大事务 —— BEGIN IMMEDIATE 包住几万条 INSERT，SQLite 的 page cache
 *      装不下，脏页频繁刷盘，WAL 不断长大。
 *   B. 逐条 SELECT 查重 —— 虽然 dedupe_hash 有唯一索引，但事务里索引
 *      每插一行就变大，加上 SQLite 语句编译开销。
 *   C. 唯一索引维护本身。
 *
 * 用法：node scripts/bench-write.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = path.join(os.tmpdir(), `ep-bw-${Date.now()}`);
const dbMod = await import('../src/db/index.js');
dbMod.migrate();
const { run, get, getDb, tx } = dbMod;

const N = 14000; // 与 0.6MB 样本量级一致
const uid = 'usr_bw';
const pid = 'per_bw';
run(`INSERT INTO users (id,email,password_hash,display_name,role,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`, [uid, 'bw@local', 'x', 'bw', 'user', 'active', Date.now(), Date.now()]);
run(`INSERT INTO personas (id,user_id,name,analysis_status,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`, [pid, uid, '阿岸', 'none', 'active', Date.now(), Date.now()]);

function hashes(n) {
  return Array.from({ length: n }, (_, i) => crypto.createHash('sha256').update(`m${i}`).digest('hex').slice(0, 40));
}
const H = hashes(N);

function reset() {
  run('DELETE FROM messages WHERE persona_id = ?', [pid]);
}

const INS = `INSERT INTO messages (id,user_id,persona_id,chat_id,import_id,role,sender_raw,content,msg_type,ts,seq,
  is_imported,is_persona_voice,dedupe_hash,meta_json,created_at)
  VALUES (?,?,?,NULL,?,?,?,?,?,?,?,1,0,?,?,?)`;

function insertRow(stmt, i, hash) {
  stmt.run(`msg_${i}`, uid, pid, 'imp', 'persona', '阿岸', `内容 ${i}`, 'text', 1700000000000 + i, i, hash, '{}', Date.now());
}

// ---- A: 一个大事务，不做查重 ----
{
  reset();
  const t = Date.now();
  tx(() => {
    const stmt = getDb().prepare(INS);
    for (let i = 0; i < N; i++) insertRow(stmt, i, H[i]);
  });
  const ms = Date.now() - t;
  console.log(`A 单个大事务，不查重        ${String(ms).padStart(7)} ms   ${(ms / N).toFixed(3)} ms/条`);
}

// ---- B: 一个大事务 + 逐条 SELECT 查重（现状） ----
{
  reset();
  const t = Date.now();
  tx(() => {
    const stmt = getDb().prepare(INS);
    for (let i = 0; i < N; i++) {
      get('SELECT id FROM messages WHERE persona_id = ? AND dedupe_hash = ?', [pid, H[i]]);
      insertRow(stmt, i, H[i]);
    }
  });
  const ms = Date.now() - t;
  console.log(`B 单个大事务 + 逐条查重     ${String(ms).padStart(7)} ms   ${(ms / N).toFixed(3)} ms/条  <- 线上现状`);
}

// ---- C: 分批事务，不查重 ----
{
  reset();
  const t = Date.now();
  const BATCH = 500;
  for (let start = 0; start < N; start += BATCH) {
    tx(() => {
      const stmt = getDb().prepare(INS);
      for (let i = start; i < Math.min(start + BATCH, N); i++) insertRow(stmt, i, H[i]);
    });
  }
  const ms = Date.now() - t;
  console.log(`C 分批事务(500)，不查重     ${String(ms).padStart(7)} ms   ${(ms / N).toFixed(3)} ms/条`);
}

// ---- D: 分批事务 + 一次性预读已有 hash 到内存 ----
{
  reset();
  const t = Date.now();
  const BATCH = 500;
  for (let start = 0; start < N; start += BATCH) {
    const end = Math.min(start + BATCH, N);
    const slice = H.slice(start, end);
    // 预先取这一批已有的 hash（一次查询，而不是 500 次）
    const existing = new Set(
      dbMod.all(`SELECT dedupe_hash h FROM messages WHERE persona_id = ? AND dedupe_hash IN (${slice.map(() => '?').join(',')})`,
        [pid, ...slice]).map((r) => r.h),
    );
    tx(() => {
      const stmt = getDb().prepare(INS);
      for (let i = start; i < end; i++) {
        if (existing.has(H[i])) continue;
        insertRow(stmt, i, H[i]);
      }
    });
  }
  const ms = Date.now() - t;
  console.log(`D 分批事务 + 批量查重       ${String(ms).padStart(7)} ms   ${(ms / N).toFixed(3)} ms/条  <- 建议方案`);
}

console.log(`\n(临时库: ${process.env.DATA_DIR})`);
