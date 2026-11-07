/* 线上手机端聊天页布局验证 —— 本轮 UI 改动的核心验收。
 *
 * 本地已经验过 39 项（verify-mobile-chat.mjs），但线上环境有三处不同：
 *   · https + 真实域名（safe-area、visualViewport 行为一致，但基准值不同）
 *   · 云端沙箱里没有 mock 上游，所以这里改成一个不可达但合法的公网地址：
 *     页面会进入"有模型但连不上"的状态，布局照样要成立 —— 布局不该依赖后端。
 *   · 访问码门禁：必须先带 sharecode 过一次。
 *
 * 断言仍然是那三件用户原话：
 *   整页不滚 / 只有聊天内部滚 / 输入框在视口内（且会被键盘顶上去）
 *
 * 用法：node scripts/verify-online-mobile.mjs "https://host/?sharecode=xxx"
 */
import { launch } from './lib/browser.mjs';

const RAW = process.argv[2];
if (!RAW) { console.error('用法: node scripts/verify-online-mobile.mjs "<url?sharecode=...>"'); process.exit(1); }
const ORIGIN = new URL(RAW).origin;

let pass = 0; let fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VW = 390; const VH = 844;
const email = `mob${Date.now()}@example.com`;

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

try {
  // 门禁
  await page.goto(RAW, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1800);

  // 注册（线上没有可控的库，只能走真实注册）
  await page.goto(`${ORIGIN}/register`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1800);
  await page.type('input[type="email"]', email);
  const pws = await page.$$('input[type="password"]');
  await pws[0].type('MobileTest123');
  if (pws[1]) await pws[1].type('MobileTest123');
  await page.evaluate(() => { const c = document.querySelector('input[type="checkbox"]'); if (c && !c.checked) c.click(); });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
    page.evaluate(() => document.querySelector('form')?.requestSubmit()),
  ]);
  await sleep(2500);
  ok(page.url().includes('/app'), '注册并进入应用', page.url());

  /* 配一个模型 + 建人格 + 建会话。
    * 模型地址用 api.openai.com：能过 SSRF 校验（域名可解析、非内网），
   * 但 key 是假的，所以不会真的回话 —— 这里只需要页面进入聊天界面。
   * 这里只需要页面进入"有模型的聊天界面"，不需要它真能回复。 */
  const setup = await page.evaluate(async () => {
    const j = (r) => r.json().catch(() => ({}));
    const cfg = await fetch('/api/llm-configs', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'online-smoke', baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini', apiKey: 'sk-smoke', isDefault: true,
      }),
    }).then(j);
    const per = await fetch('/api/personas', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '手机端验收', relationship: '测试' }),
    }).then(j);
    return { cfgOk: !cfg.error, personaId: per.persona?.id || null };
  });
  ok(setup.personaId, '线上建人格', JSON.stringify(setup));
  if (!setup.personaId) throw new Error('建人格失败');

  await page.goto(`${ORIGIN}/app/chat/${setup.personaId}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  /* ------------------------------------------------ 核心布局断言 */
  const L = await page.evaluate(() => {
    const de = document.documentElement;
    const q = (s) => document.querySelector(s);
    const box = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
    return {
      bodyClass: document.body.className,
      docScrollH: de.scrollHeight,
      docClientH: de.clientHeight,
      docScrollW: de.scrollWidth,
      docClientW: de.clientWidth,
      vh: window.innerHeight,
      appH: getComputedStyle(de).getPropertyValue('--app-h').trim(),
      layout: box('.chat-layout'),
      scroll: box('.chat-scroll'),
      scrollCanScroll: (() => { const el = q('.chat-scroll'); return el ? el.scrollHeight > el.clientHeight : false; })(),
      scrollOverflow: (() => { const el = q('.chat-scroll'); return el ? getComputedStyle(el).overflowY : null; })(),
      composer: box('.composer-wrap'),
      head: box('.chat-head'),
      railHidden: (() => { const el = q('.chat-rail'); return el ? getComputedStyle(el).display === 'none' : null; })(),
    };
  });

  ok(/chat-page/.test(L.bodyClass), 'body 带 chat-page（定高模式）', L.bodyClass);
  ok(L.docScrollH <= L.docClientH + 1, '整页不可滚', `scrollH=${L.docScrollH} clientH=${L.docClientH}`);
  ok(L.docScrollW - L.docClientW <= 1, '没有横向溢出', `overflow=${L.docScrollW - L.docClientW}`);
  ok(L.layout && Math.abs(L.layout.h - L.vh) <= 4, '聊天区高度≈视口高度', `layoutH=${L.layout?.h} vh=${L.vh}`);
  ok(L.layout && L.layout.top <= 1, '聊天区从顶部开始（没有被顶栏推下去）', `top=${L.layout?.top}`);
  ok(L.scrollOverflow === 'auto' || L.scrollOverflow === 'scroll', '消息区是可滚动容器', String(L.scrollOverflow));
  ok(L.composer && L.composer.bottom <= L.vh + 1, '输入框底边在视口内', `bottom=${L.composer?.bottom} vh=${L.vh}`);
  ok(L.composer && L.composer.bottom >= L.vh - 8, '输入框贴底（不悬空）', `bottom=${L.composer?.bottom} vh=${L.vh}`);
  ok(L.railHidden === true, '手机端会话列表默认收起', String(L.railHidden));

  /* -------------------------------------- 模拟键盘：--app-h 应缩小 */
  const kb = await page.evaluate(async () => {
    const before = { vh: window.innerHeight, appH: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim() };
    // 走真实代码路径：打桩 visualViewport.height 再派发 resize
    const vv = window.visualViewport;
    const origH = vv ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height') : null;
    try {
      if (vv) Object.defineProperty(vv, 'height', { configurable: true, get: () => 500 });
      vv?.dispatchEvent(new Event('resize'));
    } catch { /* 打桩失败就退回直接改变量 */ }
    await new Promise((r) => setTimeout(r, 600));
    const composer = document.querySelector('.composer-wrap')?.getBoundingClientRect();
    const out = {
      before,
      afterAppH: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
      afterComposerBottom: composer ? Math.round(composer.bottom) : null,
    };
    // 还原
    if (vv && origH) Object.defineProperty(vv, 'height', origH);
    vv?.dispatchEvent(new Event('resize'));
    return out;
  });
  ok(!!kb.afterAppH, '键盘弹出后 --app-h 被设置', JSON.stringify(kb));
  const kbPx = parseInt(kb.afterAppH, 10);
  ok(kbPx > 0 && kbPx <= 560, '--app-h 收缩到键盘上沿附近', `${kb.afterAppH}（原视口 ${kb.before.vh}）`);
  ok(kb.afterComposerBottom !== null && kb.afterComposerBottom <= kbPx + 12,
    '输入框跟着上移到键盘上方', `composerBottom=${kb.afterComposerBottom} appH=${kbPx}`);

  /* ------------------------------------- 新对话应关掉抽屉 */
  const newChat = await page.evaluate(async () => {
    document.querySelector('.rail-toggle, .chat-head .btn-icon')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const rail = document.querySelector('.chat-rail');
    const openedFirst = rail?.classList.contains('open') || false;
    const btn = [...document.querySelectorAll('button')].find((b) => /新对话|＋/.test(b.textContent));
    btn?.click();
    await new Promise((r) => setTimeout(r, 600));
    const rail2 = document.querySelector('.chat-rail');
    return {
      openedFirst,
      stillOpen: rail2?.classList.contains('open') || false,
      railDisplay: rail2 ? getComputedStyle(rail2).display : null,
    };
  });
  ok(!newChat.stillOpen, '点「新对话」后抽屉收起', JSON.stringify(newChat));

  ok(errs.filter((e) => !/favicon|404|401/.test(e)).length === 0, '手机端聊天页无 JS 报错',
    errs.filter((e) => !/favicon|404|401/.test(e)).slice(0, 2).join(' | '));

  await page.screenshot({ path: '.tmp/online-mobile-chat.png' });
} finally {
  await browser.close();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
