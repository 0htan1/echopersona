/* 线上真实注册 + 进应用 + 关键页面可达。
 *
 * 前两个脚本只验"打开能看"，这个脚本验"注册完真的能用"——
 * 线上首次部署最容易坏的正是这条链路（数据库没建表、session cookie
 * 在 https 下没设成 Secure、静态资源 404 导致 SPA 白屏）。
 *
 * 会创建一个一次性账号（时间戳邮箱），不碰别人的数据。
 *
 * 用法：node scripts/verify-online-e2e.mjs "https://host/?sharecode=xxx"
 */
import { launch } from './lib/browser.mjs';

const RAW = process.argv[2];
if (!RAW) { console.error('用法: node scripts/verify-online-e2e.mjs "<url?sharecode=...>"'); process.exit(1); }
const ORIGIN = new URL(RAW).origin;

let pass = 0; let fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const email = `live${Date.now()}@example.com`;
const pwd = 'LiveTest12345';

const browser = await launch({
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

try {
  /* 先过访问码门禁。
   *
   * 这个分享链接由平台的门禁保护：只有带着 ?sharecode= 请求一次，才会下发
   * 放行 cookie；直接跳到 /register 会被 403「链接不完整」拦掉。
   * 真实用户也是先点带码的链接、再在站内导航，所以这里照做。 */
  await page.goto(RAW, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const gateOk = await page.evaluate(() => !/链接不完整/.test(document.title));
  ok(gateOk, '过访问码门禁', await page.title());

  await page.goto(`${ORIGIN}/register`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  const hasForm = await page.evaluate(() => !!document.querySelector('input[type="email"]'));
  ok(hasForm, '注册页有邮箱输入框', page.url());
  if (!hasForm) throw new Error('注册页没渲染出来');

  await page.type('input[type="email"]', email);
  const pwdInputs = await page.$$('input[type="password"]');
  ok(pwdInputs.length >= 1, '注册页有密码输入框', `${pwdInputs.length} 个`);
  await pwdInputs[0].type(pwd);
  if (pwdInputs[1]) await pwdInputs[1].type(pwd); // 确认密码（如果有）

  // 有昵称字段就填上，没有也不影响
  const nameInput = await page.$('input[name="displayName"], input[placeholder*="昵称"]');
  if (nameInput) await nameInput.type('线上测试');

  // 必须勾选「已阅读并同意数据使用说明」，否则前端直接拦下不提交
  const consent = await page.$('input[type="checkbox"]');
  ok(!!consent, '注册页有数据使用同意勾选框');
  if (consent) {
    const checked = await page.evaluate(() => {
      const c = document.querySelector('input[type="checkbox"]');
      if (!c) return false;
      if (!c.checked) c.click();
      return c.checked;
    });
    ok(checked, '能勾选同意（真实用户点得到）');
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      const f = document.querySelector('form');
      if (f && f.requestSubmit) f.requestSubmit(); else f?.submit();
    }),
  ]);
  await sleep(3000);

  const afterRegister = page.url();
  const inApp = afterRegister.includes('/app');
  ok(inApp, '注册成功后进入应用', afterRegister);

  if (!inApp) {
    const err = await page.evaluate(() => {
      const e = document.querySelector('.auth-err, [role="alert"], .form-err');
      return e ? e.textContent.trim() : document.body.innerText.slice(0, 150).replace(/\n/g, ' ');
    });
    console.log('    注册页提示:', err);
  } else {
    // 关键页面逐个可达（线上静态资源与路由最容易在这里断）
    const routes = [
      ['/app', '工作台'],
      ['/app/personas', '人格'],
      ['app/personas/new', null],
      ['/app/settings/api', null],
      ['/app/settings/account', null],
      ['/app/settings/tts', null],
    ];
    for (const [r, _label] of routes) {
      const url = r.startsWith('app') ? `${ORIGIN}/${r}` : `${ORIGIN}${r}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => null);
      await sleep(1200);
      const state = await page.evaluate(() => ({
        url: location.pathname,
        textLen: document.body.innerText.trim().length,
        hasShell: !!document.querySelector('.shell, .sidebar, .side-nav'),
        title: document.title,
      }));
      const good = state.textLen > 50 && state.hasShell;
      ok(good, `${url.replace(ORIGIN, '')} 渲染正常`, JSON.stringify({ len: state.textLen, shell: state.hasShell }));
    }

    // 新建人格页真的能提交（线上写库链路）
    const made = await page.evaluate(async () => {
      const r = await fetch('/api/personas', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '线上冒烟人格', relationship: '测试' }),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, id: j.persona?.id || null, body: JSON.stringify(j).slice(0, 120) };
    });
    ok(made.status < 400 && !!made.id, '线上能建人格（写库链路通）', JSON.stringify(made));

    if (made.id) {
      await page.goto(`${ORIGIN}/app/chat/${made.id}`, { waitUntil: 'networkidle2', timeout: 40000 });
      await sleep(2500);
      const chat = await page.evaluate(() => ({
        path: location.pathname,
        hasComposer: !!document.querySelector('.composer-box textarea'),
        hasHead: !!document.querySelector('.chat-head'),
        // 一个模型都没配时，聊天页整页显示「还差一个模型来源」——这是正确设计，
        // 不是渲染失败。新账号必然是这个状态，所以要把它当成合法结果。
        hasNoModelState: /还差一个模型来源|没有可用的大模型|去配置/.test(document.body.innerText),
        text: document.body.innerText.slice(0, 100).replace(/\n/g, ' '),
      }));
      ok(chat.path.includes('/app/chat/'), '对话页路由正确', chat.path);
      // 要么是可对话的界面，要么是明确的「先配模型」空状态；两者都不是才是坏了
      const usable = (chat.hasHead && chat.hasComposer) || chat.hasNoModelState;
      ok(usable, '对话页给出可用的界面或明确的配置提示', JSON.stringify({
        head: chat.hasHead, composer: chat.hasComposer, noModel: chat.hasNoModelState,
      }));
      ok(!/Cannot read|undefined is not|页面不存在/.test(chat.text), '对话页没有崩溃痕迹', chat.text);
    }

    // 删掉刚才建的，别留垃圾
    if (made.id) {
      await page.evaluate(async (id) => {
        await fetch(`/api/personas/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
      }, made.id);
    }
  }

  const realErrs = errs.filter((e) => !/favicon|404 \(Not Found\)/i.test(e) && !/401 \(Unauthorized\)/.test(e));
  ok(realErrs.length === 0, '全流程无 JS 报错', realErrs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`测试账号: ${email}`);
process.exit(fail ? 1 : 0);
