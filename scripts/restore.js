#!/usr/bin/env node
/**
 * 从备份恢复数据库。
 * 用法： node scripts/restore.js <备份文件名或绝对路径>
 * 注意：请在停机状态下运行（先 systemctl stop echopersona）。
 *       当前数据库会被先复制一份为 *.before-restore。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { restoreBackup, listBackups } from '../src/lib/backup.js';

const arg = process.argv[2];
if (!arg) {
  console.error('[restore] 用法： node scripts/restore.js <备份文件>');
  const list = listBackups();
  if (list.length) {
    console.error('\n可用备份：');
    for (const b of list.slice(0, 10)) console.error(`  ${b.file}  (${(b.bytes / 1024).toFixed(1)} KB)`);
  } else {
    console.error(`[restore] ${config.backupDir} 下没有找到备份文件`);
  }
  process.exit(1);
}

try {
  const r = restoreBackup(arg);
  console.log(`[restore] 已从 ${arg} 恢复`);
  if (r?.safetyCopy) console.log(`[restore] 原库已备份到 ${r.safetyCopy}`);
  console.log('[restore] 请启动服务并检查数据： npm start');
  process.exit(0);
} catch (e) {
  console.error('[restore] 失败：', e.message);
  process.exit(1);
}
