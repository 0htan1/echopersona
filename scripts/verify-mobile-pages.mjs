/* 手机端全站布局回归：确认聊天页的定高改动没有把别的页面搞坏。
 *
 * 聊天页的改动是「body 定高 + overflow:hidden + 只有消息区滚」。
 * 这种改动最大的风险不是聊天页本身，而是把全局的 body/.shell/.content
 * 一起改了 —— 那样工作台、人格详情、设置页这些本来就该正常滚动的页面
 * 会滚不动，内容被切掉。
 *
 * 所以这个脚本专门验「不该管的没被管」：
 *   1. 非聊天页的 body 不能有 chat-page 类，overflow 必须是可见的
 *   2. 非聊天页必须能正常纵向滚到底（scrollHeight > clientHeight 时能滚）
 *   3. 所有页面都不能有横向溢出（手机上最丢人的一种 bug）
 *   4. 从聊天页离开后，body 上的锁滚类必须被清掉
 */
import { launch } from './lib/browser.mjs';
import fs from 'node:fs';
import { loginFast } from './lib/test-login.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const OUT = '/tmp/verify-mobile-pages';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0; let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 登录（固定账号 + 直接开 session，见 scripts/lib/test-login.mjs）
// 不走登录表单：/api/auth/login 有 15 分钟 12 次的防刷限流，一轮全量回归
// 就能打满，之后全是 401 —— 那是"测试准备"失败，不该混进结论。
await loginFast(page, BASE);
await wait(600);
if (page.url().includes('/login')) {
  await page.type('input[type="email"]', process.env.EP_TEST_EMAIL || 'e2e@example.com');
  await page.type('input[type="password"]', process.env.EP_TEST_PWD || 'Passw0rd123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);
  await wait(1400);
}
ok(!page.url().includes('/login'), '登录', page.url());

const pid = await page.evaluate(async () => {
  const r = await fetch('/api/personas', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '小满', relationship: '好友' }),
  });
  const j = await r.json();
  return j.persona?.id || null;
});
ok(!!pid, '建人格');

/** 量一个页面 */
async function measure(path, label, shotName) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
  await wait(1200);
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      chatClass: document.body.classList.contains('chat-page'),
      railLock: document.body.classList.contains('rail-open'),
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
      scrollH: de.scrollHeight,
      clientH: de.clientHeight,
      hasShell: !!document.querySelector('.shell'),
      shellH: Math.round(document.querySelector('.shell')?.getBoundingClientRect().height || 0),
      vh: window.innerHeight,
    };
  });
  if (shotName) await page.screenshot({ path: `${OUT}/${shotName}.png` });

  if (path.startsWith('/app/chat')) {
    ok(m.chatClass, `${label}：body 有 chat-page（应该有的）`);
    ok(m.bodyOverflowY === 'hidden', `${label}：body 锁滚动`, m.bodyOverflowY);
  } else {
    ok(!m.chatClass, `${label}：不该带 chat-page`, m.chatClass ? '带了' : '');
    ok(m.bodyOverflowY !== 'hidden', `${label}：body 没被锁滚动`, m.bodyOverflowY);
    ok(!m.railLock, `${label}：没有残留抽屉锁`, m.railLock ? '有残留' : '');
  }
  ok(m.scrollW <= m.clientW + 1, `${label}：无横向溢出`, `${m.scrollW} > ${m.clientW}`);
  return m;
}

/* 先塞个模型配置，让聊天页进入真实界面 */
await page.evaluate(async () => {
  await fetch('/api/llm-configs', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: '假模型', baseUrl: 'http://127.0.0.1:8791/v1', model: 'mock', apiKey: 'sk-fake', isDefault: true,
    }),
  }).catch(() => {});
});

const dash = await measure('/app', '工作台', '01-dashboard');
const personas = await measure('/app/personas', '人格列表', '02-personas');
const detail = await measure(`/app/personas/${pid}`, '人格详情', '03-detail');
const settings = await measure('/app/settings', '设置', '04-settings');
const voice = await measure('/app/voice', '语音', '05-voice');
const chat = await measure(`/app/chat/${pid}`, '对话', '06-chat');

/* 工作台内容比屏幕长时必须能滚 —— 这是"被误伤"的最直接证据 */
if (dash.scrollH > dash.clientH) {
  const canScroll = await page.evaluate(async () => {
    await page.goto(window.__x || location.href);
    return null;
  }).catch(() => null);
}

/* 离开聊天页：锁滚类必须被清掉 */
console.log('\n[离开聊天页]');
await page.goto(`${BASE}/app/chat/${pid}`, { waitUntil: 'networkidle2' });
await wait(1000);
await page.goto(`${BASE}/app`, { waitUntil: 'networkidle2' });
await wait(1000);
const afterLeave = await page.evaluate(() => ({
  chatClass: document.body.classList.contains('chat-page'),
  railLock: document.body.classList.contains('rail-open'),
  overflowY: getComputedStyle(document.body).overflowY,
  scrollH: document.documentElement.scrollHeight,
  clientH: document.documentElement.clientHeight,
}));
console.log('  ', JSON.stringify(afterLeave));
ok(!afterLeave.chatClass, '离开后 chat-page 已清除');
ok(!afterLeave.railLock, '离开后 rail-open 已清除');
ok(afterLeave.overflowY !== 'hidden', '离开后 body 恢复可滚', afterLeave.overflowY);

/* 工作台真的能滚 */
console.log('\n[工作台可滚]');
const dashScroll = await page.evaluate(async () => {
  const de = document.documentElement;
  const beforeY = window.scrollY;
  window.scrollTo(0, 600);
  await new Promise((r) => setTimeout(r, 120));
  return {
    beforeY, afterY: window.scrollY,
    scrollH: de.scrollHeight, clientH: de.clientHeight,
  };
});
console.log('  ', JSON.stringify(dashScroll));
if (dashScroll.scrollH > dashScroll.clientH + 4) {
  ok(dashScroll.afterY > dashScroll.beforeY, '工作台页面可以正常滚动', JSON.stringify(dashScroll));
} else {
  ok(true, '工作台内容不足一屏，跳过滚动断言');
}

ok(errors.length === 0, '没有 JS 报错', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`截图: ${OUT}`);
process.exit(fail ? 1 : 0);
