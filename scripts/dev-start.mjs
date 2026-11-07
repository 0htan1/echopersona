#!/usr/bin/env node
/* 本地启动包装器（只给 `npm run dev` 用，**不接管 `npm start`**）。
 *
 * 为什么需要这一层：
 *   发布工具打包的是**整个项目目录**，`.gitignore` 完全不起作用。
 *   只要本地用默认值跑过一次服务，项目里就会多出 storage/ 或 data/
 *   （数据库 + .masterkey + 上传文件 + 音频）。下一次发布就会把
 *   本地库和主密钥一起传上去 —— 线上库被覆盖，所有 API Key 的加密主密钥
 *   也一起泄露，而 e2e@example.com / Passw0rd123 这种公开测试账号
 *   会当场能在线上登录。
 *
 *   这个坑已经踩过两次（先是 data/，后来是 storage/）。靠"记得手动传
 *   DATA_DIR"是不可靠的，所以让 `npm run dev` 默认就把数据放到项目外。
 *
 * 为什么不动 `npm start`：
 *   托管平台就是用它启动的，而且平台上 `DATA_DIR` 由平台自己注入。
 *   这里如果去改 start 的行为，有可能把云端数据写到容器里的临时路径，
 *   重启就丢库 —— 那是比"本地弄脏目录"严重得多的故障。
 *   所以只接管 dev，start 完全不动。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };

if (!String(env.DATA_DIR || '').trim()) {
  env.DATA_DIR = path.join(path.dirname(ROOT), `${path.basename(ROOT)}-local-data`);
  console.log(`[dev] 数据目录在项目外：${env.DATA_DIR}`);
  console.log('[dev] 这样发布时不会把本地数据库和主密钥一起传上去。');
  console.log('[dev] 想用别的目录就显式传 DATA_DIR=...');
}

/* NODE_ENV 默认 development，避免本地误用生产配置 */
if (!env.NODE_ENV) env.NODE_ENV = 'development';

const args = ['--no-warnings', '--watch', path.join(ROOT, 'src/server.js')];
const child = spawn(process.execPath, args, { env, stdio: 'inherit', cwd: ROOT });
child.on('exit', (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* ignore */ } });
}
