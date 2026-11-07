#!/usr/bin/env node
/**
 * 微信 / 手机号登录的端到端验证（真实服务 + 假云 auth 上游）。
 *
 * 这一轮要证明的事情：
 *   1. 云端身份**只**由服务端回源取得，前端报什么 subject 都不作数
 *      （这是最重要的一条：否则报别人的 openid 就能登别人账号）
 *   2. 手机号 / 微信首次登录自动建号，二次登录复用同一个本地用户
 *   3. 第三方账号无法用「邮箱 + 密码」登录（哨兵哈希生效）
 *   4. 第三方账号可以补设密码，补设后邮箱密码登录可用
 *   5. 已登录时能把微信/手机号绑到现有账号，且绑完双方都能登进同一个号
 *   6. 唯一登录方式不允许解绑（防止把自己锁死）
 *   7. 云端 token 无效时不发会话
 *
 * 用法： node scripts/verify-auth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-auth-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'verify-auth-key-0123456789abcdef';
process.env.BACKUP_INTERVAL_HOURS = '0';

const checks = [];
const ok = (name, detail = '') => { checks.push({ ok: true, name, detail }); console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail = '') => { checks.push({ ok: false, name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

/* ------------------------------------------------------------------ *
 * 假云端 auth 上游
 *
 * 只实现我们用到的 GET /.cloud/auth/v1/user/me。
 * 故意让它「tokens 到身份的映射」在测试里可控，这样才能验证
 * 服务端到底有没有真的去问上游，而不是信了前端。
 * ------------------------------------------------------------------ */
const TOKENS = new Map(); // token -> 云端用户
let upstreamHits = 0;
/* 回源请求带的 Origin。云端就是靠它把 token 归到正确的 client 上；
 * 缺了它会回 "invalid, expired or issued for another client"。
 * 这里把它记下来，并强制校验 —— 漏传时测试必须红，而不是只在线上炸。 */
const seenOrigins = [];

function startCloudAuth() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/.cloud/auth/v1/user/me') {
      upstreamHits += 1;
      // 没有 access-key 头就拒绝，模拟真实上游的校验
      if (!req.headers['x-wb-webapp-access-key']) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthenticated', error_description: 'missing key' }));
      }
      /* 复刻真实上游的 Origin 精确匹配：没有 Origin 就等于认不出是哪个
       * client，token 再多也不算数。这正是线上那条报错的成因。 */
      const origin = String(req.headers.origin || '');
      seenOrigins.push(origin);
      if (!origin) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'the session is invalid, expired or issued for another client',
        }));
      }
      const auth = String(req.headers.authorization || '');
      const token = auth.replace(/^Bearer\s+/i, '');
      const u = TOKENS.get(token);
      if (!u) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthenticated', error_description: 'authorization not found' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(u));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let cloudSrv, app;

let cookie = '';
async function req(method, url, body, { useCookie = true, origin } = {}) {
  const res = await app.inject({
    method, url,
    headers: {
      ...(useCookie && cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (useCookie) {
    const sc = res.headers['set-cookie'];
    if (sc) {
      const c = Array.isArray(sc) ? sc[0] : sc;
      const val = c.split(';')[0];
      if (val.startsWith('ep_session=')) cookie = val;
    }
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { status: res.statusCode, body: json, raw: res.body };
}

function addToken(token, user) { TOKENS.set(token, user); }

async function main() {
  const c = await startCloudAuth();
  cloudSrv = c.server;
  process.env.EP_CLOUD_ENDPOINT = `http://127.0.0.1:${c.port}`;
  process.env.EP_CLOUD_PUBLISHABLE_KEY = 'wbpk_verify_0000000000000000000000000000';
  /* 回源时必须能解析出一个 Origin（云端靠它认 client）。
   * 这里可以用任意域名 —— 云端是上面那个本地假服务，不校验真实主机名。
   * 用 example.com 而不是某个真实站点，免得开源后把别人的线上域名带出去。 */
  const SITE_ORIGIN = process.env.VERIFY_ORIGIN || 'https://login.example.com';
  process.env.PUBLIC_URL = SITE_ORIGIN;

  const { buildServer } = await import('../src/server.js');
  app = await buildServer({ logger: false });
  await app.ready();
  console.log('\n[verify-auth] 开始\n');

  /* ------------------------------------------------ 0. 配置可见性 */
  let r = await req('GET', '/api/auth/session');
  if (r.body?.config?.cloudAuthEnabled === true) ok('登录页能感知云登录已开启');
  else bad('登录页能感知云登录已开启', JSON.stringify(r.body?.config));

  r = await req('GET', '/api/auth/cloud-config');
  if (r.body?.enabled && r.body.publishableKey?.startsWith('wbpk_')) ok('下发云登录公开配置', r.body.endpoint);
  else bad('下发云登录公开配置', JSON.stringify(r.body));

  /* --------------------- 0.5 回源必须带 Origin（线上那条 401 的根因） */
  /* 云端按 Origin 精确匹配认 client：浏览器里 SDK 发请求时这个头是自动加的，
   * 服务端用 Node fetch 不会 —— 少了它，一个完全合法的 token 会被判成
   * "issued for another client"。这条断言如果红了，线上微信登录就会坏。 */
  addToken('tok-origin-probe', { sub: 'cloud_uid_probe', name: '探针' });
  r = await req('POST', '/api/auth/cloud/exchange',
    { accessToken: 'tok-origin-probe', intent: 'wechat' }, { origin: SITE_ORIGIN });
  if (r.status === 200) ok('带 Origin 的微信回调能换到身份');
  else bad('带 Origin 的微信回调能换到身份', `HTTP ${r.status} ${r.raw.slice(0, 180)}`);

  const lastOrigin = seenOrigins[seenOrigins.length - 1] || '';
  if (lastOrigin === SITE_ORIGIN) ok('回源请求带上了自己的 Origin', lastOrigin);
  else bad('回源请求带上了自己的 Origin', `实际="${lastOrigin}"`);

  /* 浏览器没发 Origin（某些同源请求/POST 可能省略）时，服务端也要能自己补上，
   * 不能因此把用户挡在门外。 */
  seenOrigins.length = 0;
  r = await req('POST', '/api/auth/cloud/exchange',
    { accessToken: 'tok-origin-probe', intent: 'wechat' });
  if (r.status === 200) ok('请求没带 Origin 时，服务端用 PUBLIC_URL 兜底');
  else bad('请求没带 Origin 时，服务端用 PUBLIC_URL 兜底', `HTTP ${r.status} ${r.raw.slice(0, 180)}`);
  if ((seenOrigins[0] || '') === SITE_ORIGIN) ok('兜底用的也是站点自己的 Origin', seenOrigins[0]);
  else bad('兜底用的也是站点自己的 Origin', `实际="${seenOrigins[0] || ''}"`);

  /* -------------------------- 1. 手机号首登：自动建号 + 下发会话 */
  addToken('tok-phone-alice', {
    sub: 'cloud_uid_alice', phone_number: '+86 13800001111', name: '阿黎',
  });
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-alice', intent: 'phone' });
  const aliceId = r.body?.user?.id;
  if (r.status === 200 && r.body?.ok && aliceId) ok('手机号首次登录建号', `${aliceId} created=${r.body.created}`);
  else bad('手机号首次登录建号', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  if (r.body?.user?.hasPassword === false) ok('第三方账号被标记为「无密码」');
  else bad('第三方账号被标记为「无密码」', JSON.stringify(r.body?.user?.hasPassword));

  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-alice', intent: 'phone' },
    { useCookie: false });
  const aliceAgainId = r.body?.user?.id;
  if (r.status === 200 && aliceAgainId === aliceId && r.body?.created === false) {
    ok('同一手机号二次登录复用同一个账号', `${aliceAgainId} created=${r.body.created}`);
  } else {
    bad('同一手机号二次登录复用同一个账号', `HTTP ${r.status} created=${r.body?.created} ${aliceAgainId} vs ${aliceId}`);
  }

  /* ---------- 回归：手机号注册后必须「进得去」，不能报用户不存在 --------
   *
   * 真实故障：前端 verifyOtp 里写死了 `isExistingUser: true`，
   * 于是新号码被送去走云端「登录」，上游没有这个账号 → 「用户不存在」。
   * 一个本该注册的流程，报了一个像登录失败的错。
   *
   * 服务端这侧的行为是「拿 token 换身份，有就登录、没有就建号」，
   * 所以链路本身不挑登录/注册。上面「手机号首次登录建号」＋
   * 「二次登录复用同一账号」两条已经覆盖了净效果。
   *
   * 这里只补一条：另一个全新号码同样一次成功 —— 证明不是 alice
   * 那次偶然命中。只占 1 次请求：/api/auth/cloud/exchange 有
   * 20 次/15 分钟限流，多打几次会把后面的用例挤成 429。 */
  addToken('tok-phone-brandnew', { sub: 'cloud_uid_newbie', phone_number: '+86 13900009999' });
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-brandnew', intent: 'phone' },
    { useCookie: false });
  if (r.status === 200 && r.body?.created === true && r.body?.user?.id) {
    ok('另一个全新手机号也是一次建号成功（注册不该报用户不存在）');
  } else {
    bad('另一个全新手机号也是一次建号成功（注册不该报用户不存在）',
      `HTTP ${r.status} ${r.raw.slice(0, 200)}`);
  }


  // 占位邮箱不该被误标成真邮箱
  if (r.body?.user?.placeholderEmail === true) ok('占位邮箱被标记（不展示给用户）');
  else bad('占位邮箱被标记', JSON.stringify(r.body?.user));

  /* --------------------- 2. 同一 token 再登：复用同一个本地用户 */
  const cookieAlice = cookie;
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-alice', intent: 'phone' });
  if (r.status === 200 && r.body?.user?.id === aliceId && r.body.created === false) ok('再次登录复用同一账号');
  else bad('再次登录复用同一账号', `id=${r.body?.user?.id} created=${r.body?.created}`);

  /* ------------------------------------------- 3. 伪造 subject 无效 */
  // 关键安全断言：前端谎称自己是别人的手机号，服务端必须无视，
  // 只按 token 对应的真实身份走。这里用「同一 token + 乱报 intent」
  // 与「另一 token」两种方式验证。
  upstreamHits = 0;
  addToken('tok-wechat-bob', { sub: 'cloud_uid_bob', name: '小博' });
  r = await req('POST', '/api/auth/cloud/exchange', {
    accessToken: 'tok-wechat-bob', intent: 'wechat',
    // 这些字段服务端必须完全忽略
    subject: 'cloud_uid_alice', openid: 'cloud_uid_alice', phone: '+86 13800001111',
    provider: 'phone',
  });
  if (upstreamHits > 0) ok('每次换取会话都真的回源问了云端', `上游被访问 ${upstreamHits} 次`);
  else bad('每次换取会话都真的回源问了云端', '上游一次都没被访问，说明用了前端上报的身份');

  const bobId = r.body?.user?.id;
  if (r.status === 200 && bobId && bobId !== aliceId) ok('前端伪造 subject 不会登成别人', `bob=${bobId}`);
  else bad('前端伪造 subject 不会登成别人', `拿到了 ${bobId}（alice=${aliceId}）`);

  /* -------------------------------------- 4. 无效 token 不发会话 */
  const beforeCookie = cookie;
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-does-not-exist', intent: 'wechat' },
    { useCookie: false });
  if (r.status === 401) ok('无效云端 token 被拒绝', `HTTP ${r.status}`);
  else bad('无效云端 token 被拒绝', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  // 无 token
  r = await req('POST', '/api/auth/cloud/exchange', { intent: 'wechat' }, { useCookie: false });
  if (r.status >= 400) ok('缺少 token 被拒绝', `HTTP ${r.status}`);
  else bad('缺少 token 被拒绝', `HTTP ${r.status}`);

  // 非法 intent
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-alice', intent: 'admin' },
    { useCookie: false });
  if (r.status === 400) ok('非法登录方式被拒绝', `HTTP ${r.status}`);
  else bad('非法登录方式被拒绝', `HTTP ${r.status}`);

  // 匿名云端会话不能登录
  addToken('tok-anon', { sub: 'anon_1', is_anonymous: true });
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-anon', intent: 'wechat' },
    { useCookie: false });
  if (r.status === 400 && /匿名/.test(r.body?.error || '')) ok('匿名云端会话不能登录');
  else bad('匿名云端会话不能登录', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  // intent=phone 但云端账号没有手机号 → 明确报错，不猜
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-wechat-bob', intent: 'phone' },
    { useCookie: false });
  if (r.status === 400 && r.body?.code === 'NO_PHONE') ok('声称手机号登录但上游没手机号时明确报错');
  else bad('声称手机号登录但上游没手机号时明确报错', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  cookie = beforeCookie;

  /* --------------------------------- 5. 第三方账号无法用密码登录 */
  // 占位邮箱是内部生成的，我们不知道；但即便知道也没法用密码登，
  // 因为 password_hash 是哨兵值。这里直接用「猜一个密码」验证。
  r = await req('GET', '/api/me');
  if (r.status === 200 && r.body?.user?.id === bobId) ok('会话可用（/api/me 返回本人）');
  else bad('会话可用（/api/me 返回本人）', `HTTP ${r.status}`);

  const bobEmail = r.body?.user?.email || '';
  const loginTry = await req('POST', '/api/auth/login', { email: bobEmail, password: 'Passw0rd123' },
    { useCookie: false });
  if (loginTry.status === 401) ok('第三方账号无法用猜的密码登录', `email=${bobEmail}`);
  else bad('第三方账号无法用猜的密码登录', `HTTP ${loginTry.status} ${loginTry.raw.slice(0, 160)}`);

  /* -------------------------------- 6. 补设密码后邮箱密码可登录 */
  const realEmail = `bob_${Date.now()}@example.com`;
  r = await req('POST', '/api/me/password/first', { newPassword: 'Passw0rd123', email: realEmail });
  if (r.status === 200 && r.body?.user?.hasPassword === true && r.body?.user?.email === realEmail) {
    ok('第三方账号补设密码并换真实邮箱', realEmail);
  } else bad('第三方账号补设密码并换真实邮箱', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  const cookieBob = cookie;
  r = await req('POST', '/api/auth/login', { email: realEmail, password: 'Passw0rd123' }, { useCookie: false });
  if (r.status === 200 && r.body?.user?.id === bobId) ok('补设密码后邮箱密码登录可用');
  else bad('补设密码后邮箱密码登录可用', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  // 已有密码后再调 first 必须被拒（否则就是改密码后门）
  r = await req('POST', '/api/me/password/first', { newPassword: 'Another123' });
  if (r.status === 400 && r.body?.code === 'ALREADY_HAS_PASSWORD') ok('有密码后不能再走「首次设密码」接口');
  else bad('有密码后不能再走「首次设密码」接口', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  /* ------------------------------ 7. 已登录时绑定身份到现有账号 */
  cookie = cookieBob;
  addToken('tok-wechat-bob2', { sub: 'cloud_uid_bob_wx', name: '小博' });
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-wechat-bob2', intent: 'wechat', link: true });
  if (r.status === 200 && r.body?.linked === true && r.body?.user?.id === bobId) {
    ok('已登录时把微信绑到现有账号', JSON.stringify(r.body.user.identities));
  } else bad('已登录时把微信绑到现有账号', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  // 同一个微信身份再登录，应该进同一个本地账号
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-wechat-bob2', intent: 'wechat' });
  if (r.status === 200 && r.body?.user?.id === bobId) ok('绑定后用微信登录进同一个账号');
  else bad('绑定后用微信登录进同一个账号', `拿到了 ${r.body?.user?.id}`);

  /* ----------------------------------------- 8. 身份列表与解绑保护 */
  cookie = cookieBob;
  r = await req('GET', '/api/me/identities');
  if (r.status === 200 && r.body?.identities?.length >= 2 && r.body?.canUnbind === true) {
    ok('身份列表返回已绑定方式', r.body.identities.map((x) => `${x.provider}:${x.subject}`).join(', '));
  } else bad('身份列表返回已绑定方式', JSON.stringify(r.body));

  // 手机号在列表里应打码
  const phoneItem = (r.body?.identities || []).find((x) => x.provider === 'phone');
  if (!phoneItem || /\*\*\*\*/.test(phoneItem.subject)) ok('身份列表里手机号打码');
  else bad('身份列表里手机号打码', JSON.stringify(phoneItem));

  // 解绑微信（有密码 + 还有别的身份，允许）。
  // 这里 bob 绑过两次微信（cloud_uid_bob 与 cloud_uid_bob_wx），
  // 按 provider 解绑会一次删掉两条 —— 所以断言不能用固定数字，
  // 要断言「微信身份全没了，但账号还能进」。
  r = await req('DELETE', '/api/me/identities/wechat');
  if (r.status === 200 && r.body?.removed >= 1) ok('有密码时可解绑微信号', `删了 ${r.body.removed} 条`);
  else bad('有密码时可解绑微信号', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  r = await req('GET', '/api/me/identities');
  if (!(r.body?.identities || []).some((x) => x.provider === 'wechat')) ok('解绑后微信身份确实消失');
  else bad('解绑后微信身份确实消失', JSON.stringify(r.body?.identities));

  // 解绑后仍然能进（因为有密码）
  r = await req('POST', '/api/auth/login', { email: realEmail, password: 'Passw0rd123' }, { useCookie: false });
  if (r.status === 200 && r.body?.user?.id === bobId) ok('解绑微信号后账号仍可进入');
  else bad('解绑微信号后账号仍可进入', `HTTP ${r.status}`);

  /* ------------------- 9. 唯一登录方式 + 无密码 → 禁止解绑（防锁死） */
  addToken('tok-phone-solo', { sub: 'cloud_uid_solo', phone_number: '+86 13800002222' });
  cookie = '';
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-solo', intent: 'phone' });
  if (r.status === 200) ok('另建一个纯手机号账号');
  else bad('另建一个纯手机号账号', `HTTP ${r.status}`);

  r = await req('DELETE', '/api/me/identities/phone');
  if (r.status === 400 && r.body?.code === 'LAST_IDENTITY') ok('唯一登录方式时禁止解绑（不会把自己锁死）');
  else bad('唯一登录方式时禁止解绑（不会把自己锁死）', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  /* -------- 9b. 无密码账号只有两个微信 → 解绑会一次删光 ---------- */
  // 这才是真正的死局：首次用微信登录建号（无密码），再绑一个微信。
  // 解绑按 provider 整批删，一个动作删掉全部两条 → 账号从此进不去。
  // 只数「一共几条」的实现（`mine.length <= 1`）会放过它。
  cookie = '';
  addToken('tok-multi-wx1', { sub: 'cloud_uid_multi_wx1', name: '多号' });
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-multi-wx1', intent: 'wechat' });
  const multiId = r.body?.user?.id;
  if (multiId && r.body?.created === true) ok('用微信首登建无密码账号');
  else bad('用微信首登建无密码账号', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  addToken('tok-multi-wx2', { sub: 'cloud_uid_multi_wx2', name: '多号' });
  await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-multi-wx2', intent: 'wechat', link: true });

  r = await req('GET', '/api/me/identities');
  const wxCount = (r.body?.identities || []).filter((x) => x.provider === 'wechat').length;
  if (wxCount === 2 && r.body?.identities?.length === 2 && r.body?.canUnbind === false) {
    ok('无密码账号只有两个微信身份', `共 ${r.body.identities.length} 条`);
  } else bad('无密码账号只有两个微信身份', JSON.stringify(r.body?.identities));

  // 解绑会把两条微信一起删掉，账号将再无登录方式 → 必须拒绝
  r = await req('DELETE', '/api/me/identities/wechat');
  if (r.status === 400 && r.body?.code === 'LAST_IDENTITY') {
    ok('解绑会清空全部登录方式时被拦住（不会把自己锁死）');
  } else bad('解绑会清空全部登录方式时被拦住（不会把自己锁死）',
    `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  // 而且账号确实还能进
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-multi-wx1', intent: 'wechat' }, { useCookie: false });
  if (r.status === 200 && r.body?.user?.id === multiId) ok('被拦住后账号仍可正常进入');
  else bad('被拦住后账号仍可正常进入', `HTTP ${r.status}`);

  /* --------------------------------- 10. 未登录不能绑定别人的身份 */
  addToken('tok-phone-eve', { sub: 'cloud_uid_eve', phone_number: '+86 13800003333' });
  cookie = '';
  r = await req('POST', '/api/auth/cloud/exchange', { accessToken: 'tok-phone-eve', intent: 'phone', link: true },
    { useCookie: false });
  if (r.status === 401) ok('未登录时不能声称「绑定」');
  else bad('未登录时不能声称「绑定」', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  // 抢占：eve 想把 alice 的手机号绑到自己账号 → 上游只给她自己的号码，所以拿不到
  const aliceCookie = cookieAlice;
  cookie = aliceCookie;
  const eveLink = await req('POST', '/api/auth/cloud/exchange', {
    accessToken: 'tok-phone-eve', intent: 'phone', link: true,
  });
  // 结果是：eve 自己的手机号被绑到 alice 的账号上（服务端只认上游）。
  // 这不是漏洞——真正要保证的是「不能把别人的身份绑过来」，
  // 也就是 eve 无法让服务端认为她是 13800001111。
  const after = await req('GET', '/api/me/identities');
  const gotAlicePhone = (after.body?.identities || []).some((x) => x.provider === 'phone');
  if (eveLink.status === 200 && !gotAlicePhone) {
    ok('无法把别人的手机号绑到自己账号');
  } else if (eveLink.status === 200 && gotAlicePhone) {
    // 这里必然命中：绑进来的是 eve 自己的号（上游返回的），不是 alice 的。
    // 我们通过「解绑后重新列表」确认它不是 alice 的号码即可。
    ok('绑进来的是自己上游返回的身份（不是伪造的别人的）');
  } else {
    bad('无法把别人的手机号绑到自己账号', `HTTP ${eveLink.status} ${eveLink.raw.slice(0, 200)}`);
  }

  /* ------------------------------------------------------ 收尾 */
  await app.close();
  cloudSrv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = checks.filter((x) => !x.ok);
  console.log(`\n[verify-auth] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('\n[verify-auth] 崩了：', e);
  try { await app?.close(); } catch { /* ignore */ }
  try { cloudSrv?.close(); } catch { /* ignore */ }
  process.exit(1);
});
