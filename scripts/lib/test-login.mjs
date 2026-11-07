/* 验收脚本的登录准备。
 *
 * 为什么不用登录表单：
 *   /api/auth/login 有 15 分钟 12 次的限流（正当的防刷）。一轮全量回归要
 *   跑 5 个需要登录的脚本，几个来回就把额度打满，之后全是 401 —— 而被限流
 *   拦住的是"测试准备"，不是被测功能，不该让它冒充成功能失败。
 *
 * 这里的做法和登录接口在数据层面完全一样：同一张 sessions 表、同样的
 * sha256(token) 存储、同一个 cookie 名。只是省掉了 scrypt 校验与限流计数，
 * 顺便把账号的数据清干净，让「默认值」类断言测的是真的默认值。
 *
 * 线上（带 sharecode 的地址）没有本地库权限，走不回退到表单登录。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 scripts/lib/ 下，项目根要往上两级
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COOKIE = 'ep_session';

/** 建/重置测试账号并直接开一个登录态，返回 token（失败返回 null）。
 *
 * `dataDir` 必须和被验收的那个服务进程用的是同一个目录。
 *
 * 踩过的坑：服务是用 `DATA_DIR=../echopersona-data npm start` 起的（行内变量
 * 优先于 .env），而本函数另起一个 node 进程，它读的是 .env 里的
 * `DATA_DIR=./storage` —— 于是账号建在 A 库、服务读 B 库，登录必然失败，
 * 还在项目目录里凭空造出一个含数据库和主密钥的 storage/。
 * 所以这里把目录原样透传下去。
 */
export function makeTestSession({ reset = true, dataDir = process.env.DATA_DIR } = {}) {
  try {
    const argv = [path.join(ROOT, 'scripts/mk-test-user.mjs'), '--session'];
    if (!reset) argv.push('--keep');
    const env = { ...process.env };
    if (dataDir) env.DATA_DIR = dataDir;
    const out = execFileSync(process.execPath, argv, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env,
    });
    return out.match(/EP_TEST_TOKEN=(\S+)/)?.[1] || null;
  } catch {
    return null;
  }
}

/** 把 token 写成浏览器 cookie 并落到 /app。返回是否成功。 */
export async function loginWithToken(page, base, token) {
  if (!token) return false;
  const u = new URL(base);
  await page.setCookie({
    name: COOKIE, value: token, domain: u.hostname, path: '/', httpOnly: true, sameSite: 'Lax',
  });
  await page.goto(`${base}/app`, { waitUntil: 'networkidle2' });
  return page.url().includes('/app');
}

/**
 * 一步到位：重置账号 + 注入 session + 进 /app。
 * 失败时返回 false，让调用方决定要不要回退到表单登录。
 *
 * dataDir 默认取当前进程的 DATA_DIR（验收脚本通常和服务同环境启动）。
 */
export async function loginFast(page, base, { dataDir = process.env.DATA_DIR } = {}) {
  const token = makeTestSession({ dataDir });
  return loginWithToken(page, base, token);
}
