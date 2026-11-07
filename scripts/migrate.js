#!/usr/bin/env node
/**
 * 数据库迁移。幂等，可重复执行。
 * 用法： npm run migrate
 */
import { config, ensureDirs } from '../src/config.js';
import { migrate, get, closeDb } from '../src/db/index.js';

try {
  ensureDirs();
  migrate();
  const tables = get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const fts = get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'");
  console.log(`[migrate] 数据库就绪：${config.dbFile}`);
  console.log(`[migrate] 业务表 ${tables.n} 张，全文索引 ${fts.n} 张`);
  closeDb();
  process.exit(0);
} catch (e) {
  console.error('[migrate] 失败：', e.message);
  process.exit(1);
}
