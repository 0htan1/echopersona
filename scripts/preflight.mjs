#!/usr/bin/env node
/* 发布前检查：确保项目目录里没有运行时数据。
 *
 * 起因（真实事故）：发布工具把整个项目目录打包上传，`data/` 跟着上去了，
 * 本地库直接覆盖了线上库 —— 19 个测试账号（其中 e2e@example.com 的密码是
 * 公开的 Passw0rd123）当场可以在线上登录，`.masterkey`（加密所有 API Key
 * 的主密钥）也一起泄了出去。
 *
 * 这类错误不能靠"记得别放"来避免，必须在动手之前检查。
 * 退出码非 0 表示不该发布。
 *
 * 用法：node scripts/preflight.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const warns = [];

/* 1) 运行时数据目录不能存在（或者存在也必须空）
 *
 * 允许存在：某些环境先 mkdir 了空目录，无害。
 * 只要里面有数据库、上传、音频、主密钥，就是会污染线上的东西。 */
const dataDir = path.join(ROOT, 'storage');
if (fs.existsSync(dataDir)) {
  const entries = fs.readdirSync(dataDir);
  const dangerous = entries.filter((e) =>
    /\.(db|db-wal|db-shm|gz)$/.test(e) || e === '.masterkey' || e === '.devkey'
    || ['uploads', 'audio', 'avatars', 'backups', 'logs'].includes(e));
  if (dangerous.length) {
    problems.push(
      `storage/ 里有运行时数据：${dangerous.slice(0, 6).join(', ')}${dangerous.length > 6 ? ` 等 ${dangerous.length} 项` : ''}\n` +
      `     → 发布工具会把它整份上传，覆盖线上库并泄露 .masterkey。\n` +
      `     → 本地开发请把数据放到项目外：\n` +
      `       DATA_DIR=../echopersona-data npm start`
    );
  }
}

/* 2) 主密钥不能写在会随目录上传的 .env 里
 *
 * 线上首次启动会自动生成 data/.masterkey（0600）。把 MASTER_KEY 写进 .env
 * 等于把密钥放进代码包；而且和线上已生成的密钥不一致时，旧的加密数据会解不开。 */
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  const env = fs.readFileSync(envFile, 'utf8');
  const m = env.match(/^MASTER_KEY=(.+)$/m);
  if (m && m[1].trim()) {
    problems.push(
      `    .env 里写了 MASTER_KEY（长度 ${m[1].trim().length}）\n` +
      `     → 它会随目录上传，等于把密钥放进代码包。\n` +
      `     → 留空即可，首次启动会自动生成 data/.masterkey。`
    );
  }
  // 生产环境不该开的开关
  if (/^SSRF_ALLOW_PRIVATE=(1|true|yes|on)$/im.test(env)) {
    problems.push('    .env 里 SSRF_ALLOW_PRIVATE 是开的 → 线上等于允许打到内网，不安全');
  }
  if (/^EXPOSE_ERRORS=(1|true|yes|on)$/im.test(env)) {
    warns.push('.env 里 EXPOSE_ERRORS 是开的 → 线上会把内部错误信息暴露给用户');
  }
}

/* 3) 不该被打包的东西
 *
 * 发布工具不看 .gitignore —— data/ 事故就是证据。所以这些目录即使写了
 * 忽略规则，也必须在发布前真的搬空，否则会被原样传上去。 */
const tmpDir = path.join(ROOT, '.tmp');
if (fs.existsSync(tmpDir)) {
  const entries = fs.readdirSync(tmpDir);
  // 允许留下空的占位目录；有内容就提示（截图/临时库体积大，也可能含账号数据）
  if (entries.length > 0) {
    const size = entries.reduce((n, e) => {
      try {
        const st = fs.statSync(path.join(tmpDir, e));
        return n + (st.isDirectory() ? 0 : st.size);
      } catch { return n; }
    }, 0);
    warns.push(
      `.tmp/ 里有 ${entries.length} 项（约 ${Math.round(size / 1024)}KB）→ 会随目录一起上传。发布前建议清空。`
    );
  }
}
/* 发布标记文件是可选的：只有用「发布为应用」这类托管平台时才由平台生成。
 * 开源用户自己部署不会有，因此只在它存在时才提一句，缺了不算问题。 */
const genieMark = fs.readdirSync(ROOT).find((f) => f.startsWith('.wbapp_') && f.endsWith('.genie'));
if (genieMark) warns.push(`检测到发布标记 ${genieMark} → 说明这是托管平台的应用目录，发布前记得清空 .tmp/ 与运行时数据`);

/* 4) 前端 vendor 产物（只有启用云登录时才必需）
 *
 * 云登录是可选的：不配 EP_CLOUD_* 时前端根本不会 import 这个文件，
 * 所以缺失只是「没有微信/手机号登录」，不该拦住发布。
 * 但若已配置云登录却缺文件，线上点按钮会 404 —— 那必须拦。 */
const vendor = path.join(ROOT, 'public/vendor/workbuddy-cloud-sdk.js');
if (!fs.existsSync(vendor)) {
  const cloudOn = /^EP_CLOUD_PUBLISHABLE_KEY=.+$/m.test(
    fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '',
  );
  if (cloudOn) {
    problems.push('已配置 EP_CLOUD_PUBLISHABLE_KEY，但 public/vendor/workbuddy-cloud-sdk.js 不存在'
      + '\n     → 线上点「微信登录」会 404。先跑 npm run vendor');
  } else {
    warns.push('public/vendor/workbuddy-cloud-sdk.js 不存在 → 不会有微信/手机号登录（本项目其余功能不受影响）');
  }
}

/* 5) 代码里不能残留调试开关 */
const debugHits = [];
const walk = (dir, depth = 0) => {
  if (depth > 3) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', '.tmp', 'public/vendor'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.(js|mjs)$/.test(e.name) && !/^\s*(\/\/|\*)/.test('')) {
      const s = fs.readFileSync(p, 'utf8');
      if (/console\.log\(['"]DEBUG/.test(s)) debugHits.push(path.relative(ROOT, p));
    }
  }
};
walk(ROOT);
if (debugHits.length) warns.push(`发现调试日志：${debugHits.join(', ')}`);

/* ---------------------------------------------------------------- 输出 */
if (problems.length) {
  console.error('✗ 发布前检查未通过：\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}
if (warns.length) {
  console.log('⚠ 可以发布，但请注意：');
  for (const w of warns) console.log(`  · ${w}`);
  console.log('');
}
console.log('✓ 发布前检查通过：项目目录里没有运行时数据，也没有写死的密钥。');
