/* 建/重置一个固定账号，供需要登录的浏览器验收脚本使用。
 *
 * 为什么需要它：注册接口有 15 分钟 8 次的限流（这是正当的防刷），
 * 而验收脚本每次跑都要一个新账号，连续回归几轮就会被 429 拦住。
 * 被限流拦住的是"测试准备"，不是被测代码 —— 不该让它冒充成功能失败。
 *
 * 为什么还要清数据：固定账号意味着上一轮跑完的东西会留在库里。
 * 于是「新账号默认是经典外观」会读到上一轮设的 wechat，
 * 重复建同名人格 / 同名音色会拿到 409（浏览器还会把 409 记成
 * 控制台报错，进而让「控制台无报错」这条假失败）。
 * 这些都是测试状态不干净，不是产品缺陷 —— 所以在建账号时一并复位。
 *
 * 用法：node scripts/mk-test-user.mjs [email] [password] [--keep]
 *       默认 e2e@example.com / Passw0rd123，默认清空该账号的业务数据
 */
import { get, all, run } from '../src/db/index.js';
import { hashPassword } from '../src/lib/crypto.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const pos = args.filter((a) => !a.startsWith('--'));
const email = (pos[0] || 'e2e@example.com').trim().toLowerCase();
const pwd = pos[1] || 'Passw0rd123';

if (pwd.length < 8) {
  console.error('密码至少 8 位');
  process.exit(1);
}

const hash = await hashPassword(pwd);
const existing = get('SELECT id FROM users WHERE email = ?', [email]);

/* 明确打印实际用的库文件。
 *
 * 踩过的坑：服务用 `DATA_DIR=../x npm start` 起（行内变量优先），
 * 而本脚本单独跑时读 .env 的 DATA_DIR，两边不是同一个库 ——
 * 账号建在 A、服务读 B，登录必失败，还在项目里凭空长出数据库和主密钥。
 * 打出路径，一眼就能看出是不是同一个。 */
console.log('db:', config.dbFile);

let userId;
if (existing) {
  // 重置成已知密码 + 激活状态 + 默认外观，避免上一轮留下的状态影响断言
  run(`UPDATE users SET password_hash = ?, status = ?, email_verified = 1,
       ui_theme = 'classic', display_name = ?, updated_at = ? WHERE id = ?`,
    [hash, 'active', 'E2E 用户', Date.now(), existing.id]);
  userId = existing.id;
  console.log(`updated ${email} (${userId})`);
} else {
  userId = `usr_${Date.now()}`;
  const now = Date.now();
  run(`INSERT INTO users (id,email,password_hash,display_name,role,email_verified,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, email, hash, 'E2E 用户', 'user', 1, 'active', now, now]);
  console.log(`created ${email} (${userId})`);
}

if (!keep) {
  // 顺序按外键依赖从叶子往根走。ON DELETE CASCADE 其实能兜住，
  // 但显式删一遍更直观，也不依赖 PRAGMA foreign_keys 的当前取值。
  const tables = [
    'tts_audio', 'messages', 'chats', 'import_files', 'profiles',
    'memories', 'memory_chunks', 'personas',
    'llm_configs', 'tts_configs', 'voice_refs', 'jobs',
  ];
  let total = 0;
  for (const t of tables) {
    const rows = all(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [userId]);
    const n = rows[0]?.n || 0;
    if (n) { run(`DELETE FROM ${t} WHERE user_id = ?`, [userId]); total += n; }
  }
  console.log(`cleared ${total} rows for ${email}`);
}

/* --session：直接开一个登录态，把 token 打进 stdout（EP_TEST_TOKEN=...）。
 *
 * 为什么不走 /api/auth/login：那个接口有 15 分钟 12 次的限流（正当的防刷），
 * 而验收脚本每次跑都要登一次，一轮全量回归就会把它打满，接着全变成 401。
 * 被限流拦住的是"测试准备"，不是被测功能 —— 不该让它冒充成功能失败。
 * 这里做的事和登录接口完全一样（同一张 sessions 表、同样的 sha256 存储），
 * 只是省掉了 scrypt 校验和限流计数。 */
if (args.includes('--session')) {
  const { createSession } = await import('../src/lib/auth.js');
  const { token } = createSession(userId, { ip: '127.0.0.1', ua: 'ep-verify-script' });
  console.log(`EP_TEST_TOKEN=${token}`);
}

console.log('password:', pwd);
