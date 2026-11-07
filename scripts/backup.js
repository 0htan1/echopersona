#!/usr/bin/env node
/**
 * 手动/定时备份数据库。
 * 用法： node scripts/backup.js [--keep=14]
 * 说明： 用 VACUUM INTO 生成一致快照，gzip 压缩后存放在 $DATA_DIR/backups。
 */
import { config, ensureDirs } from '../src/config.js';
import { getDb, closeDb } from '../src/db/index.js';
import { createBackup } from '../src/lib/backup.js';

const keepArg = process.argv.find((a) => a.startsWith('--keep='));
const keep = keepArg ? Number(keepArg.split('=')[1]) : 14;

try {
  ensureDirs();
  getDb(); // 确保连接与 WAL 就绪
  const r = await createBackup({ keep });
  console.log(`[backup] 已生成 ${r.file}`);
  console.log(`[backup] 压缩后 ${(r.bytes / 1024).toFixed(1)} KB / 原始 ${(r.rawBytes / 1024).toFixed(1)} KB`);
  if (r.pruned) console.log(`[backup] 清理旧备份 ${r.pruned} 个（保留 ${keep} 个）`);
  console.log(`[backup] 目录 ${config.backupDir}`);
  closeDb();
  process.exit(0);
} catch (e) {
  console.error('[backup] 失败：', e.message);
  process.exit(1);
}
