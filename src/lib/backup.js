import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

/**
 * Consistent SQLite backup using the native backup() API when available,
 * otherwise a VACUUM INTO snapshot. Then gzip and prune.
 */
export async function createBackup({ keep = 14 } = {}) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const raw = path.join(config.backupDir, `echopersona-${stamp}.db`);
  const db = getDb();

  // VACUUM INTO produces a consistent snapshot without blocking readers.
  try {
    db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}';`);
  } catch (e) {
    throw new Error(`数据库快照失败：${e.message}`);
  }

  const buf = fs.readFileSync(raw);
  const gz = zlib.gzipSync(buf, { level: 9 });
  const out = `${raw}.gz`;
  fs.writeFileSync(out, gz);
  fs.unlinkSync(raw);

  const pruned = pruneBackups(keep);
  return { file: path.basename(out), bytes: gz.length, rawBytes: buf.length, pruned };
}

/** List existing backups, newest first. */
export function listBackups() {
  const dir = config.backupDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^echopersona-.*\.db(\.gz)?$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function pruneBackups(keep = 14) {  const dir = config.backupDir;
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir)
    .filter((f) => /^echopersona-.*\.db(\.gz)?$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let n = 0;
  for (const item of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, item.f)); n++; } catch { /* ignore */ }
  }
  return n;
}

/** Restore from a gz backup file. Refuses to run while the DB handle is open. */
export function restoreBackup(file) {
  const src = path.isAbsolute(file) ? file : path.join(config.backupDir, file);
  if (!fs.existsSync(src)) throw new Error('备份文件不存在');
  const data = src.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(src)) : fs.readFileSync(src);
  const target = config.dbFile;
  const safety = `${target}.before-restore`;
  if (fs.existsSync(target)) fs.copyFileSync(target, safety);
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${target}${suffix}`;
    if (fs.existsSync(p) && suffix) fs.unlinkSync(p);
  }
  fs.writeFileSync(target, data);
  return { restored: target, safetyCopy: safety, bytes: data.length };
}

export function scheduleBackups(log) {
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS || 24);
  if (!hours || hours <= 0) return null;
  const runOnce = async () => {
    try {
      const r = await createBackup({ keep: Number(process.env.BACKUP_KEEP || 14) });
      log.info({ ...r }, 'database backup complete');
    } catch (e) {
      log.error({ err: e.message }, 'database backup failed');
    }
  };
  const timer = setInterval(runOnce, hours * 3600_000);
  timer.unref?.();
  log.info({ hours }, 'automatic database backup scheduled');
  return timer;
}
