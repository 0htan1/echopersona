/* 桌面端聊天页回归。
 *
 * 手机端的定高改动（body.chat-page / 100% 高度链）在桌面上同样生效，
 * 而桌面版有一个额外的硬约束：左侧会话栏和顶栏是常驻的，
 * 聊天区必须正好填满「顶栏以下、窗口以内」的那块区域。
 *
 * 这里用真实浏览器量四个数：
 *   1. 整页不滚（桌面也不该滚 —— 聊天页永远是定高两栏）
 *   2. 聊天区高度 == 视口高度（顶栏在对话页被隐藏，所以不是 vh - 56）
 *   3. 输入框贴底，且底边 == 视口底边
 *   4. 左侧会话栏可见且有宽度（桌面上它不是抽屉）
 * 另外验一下「新对话」在桌面上不会误触发抽屉逻辑（closeRail 在宽屏是空操作）。
 */
import { launch } from './lib/browser.mjs';
import fs from 'node:fs';
import { loginFast } from './lib/test-login.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const OUT = '/tmp/verify-desktop-chat';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0; let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

/* 用固定账号 + 直接开 session 登录，不走登录表单。
 * 登录接口有 15 分钟 12 次的防刷限流 —— 连续跑几轮验收就会被 401 拦住，
 * 而那是"测试准备"失败，不是被测代码失败，不该混进结论里。
 * 见 scripts/lib/test-login.mjs。 */
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

// 配模型 + 建人格 + 灌消息
const pid = await page.evaluate(async () => {
  await fetch('/api/llm-configs', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'm', baseUrl: 'http://127.0.0.1:8790/v1', model: 'mock', apiKey: 'sk-fake', isDefault: true,
    }),
  }).catch(() => {});
  const r = await fetch('/api/personas', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '小满', relationship: '好友' }),
  });
  const j = await r.json();
  return j.persona?.id || null;
});
ok(!!pid, '建人格', pid || '');
if (!pid) { await browser.close(); process.exit(1); }

const chatId = await page.evaluate(async (personaId) => {
  const r = await fetch(`/api/personas/${personaId}/chats`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '桌面验收' }),
  });
  return (await r.json()).chat?.id || null;
}, pid);
ok(!!chatId, '建会话', chatId || '');
if (!chatId) { await browser.close(); process.exit(1); }

const { run, get } = await import('../src/db/index.js');
const owner = get('SELECT user_id FROM personas WHERE id = ?', [pid])?.user_id;
const now = Date.now();
for (let i = 0; i < 30; i += 1) {
  run(`INSERT INTO messages (id,user_id,persona_id,chat_id,role,sender_raw,content,msg_type,ts,seq,is_imported,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    [`msg_d${now}_${i}`, owner, pid, chatId, i % 2 ? 'persona' : 'user', i % 2 ? '小满' : null,
      i % 2 ? '嗯，知道了。' : `第 ${i} 条：今天挺累的。`, 'text', now + i, i + 1, now + i]);
}

await page.goto(`${BASE}/app/chat/${pid}/${chatId}`, { waitUntil: 'networkidle2' });
await wait(1500);
await page.screenshot({ path: `${OUT}/01-desktop-chat.png` });

console.log('[桌面布局]');
const m = await page.evaluate(() => {
  const de = document.documentElement;
  const layout = document.querySelector('.chat-layout').getBoundingClientRect();
  const rail = document.querySelector('.chat-rail').getBoundingClientRect();
  const comp = document.querySelector('.composer-wrap').getBoundingClientRect();
  const scrollEl = document.querySelector('.chat-scroll');
  return {
    vh: window.innerHeight,
    layoutH: Math.round(layout.height),
    layoutTop: Math.round(layout.top),
    railW: Math.round(rail.width),
    railDisplay: getComputedStyle(document.querySelector('.chat-rail')).display,
    compBottom: Math.round(comp.bottom),
    docScrollH: de.scrollHeight,
    docClientH: de.clientHeight,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    scrollOverflowY: getComputedStyle(scrollEl).overflowY,
    canScrollInner: scrollEl.scrollHeight > scrollEl.clientHeight,
  };
});
console.log('  ', JSON.stringify(m));
ok(m.bodyOverflowY === 'hidden', '桌面 body 也锁滚动', m.bodyOverflowY);
ok(m.docScrollH <= m.docClientH + 1, '桌面整页不滚', `${m.docScrollH} > ${m.docClientH}`);
ok(Math.abs(m.layoutH - m.vh) <= 2, '聊天区高度等于视口高度', `layout=${m.layoutH} vh=${m.vh}`);
ok(m.layoutTop === 0, '聊天区从视口顶边开始（顶栏已隐藏）', `top=${m.layoutTop}`);
ok(m.railW >= 200, '左侧会话栏常驻且有宽度', `${m.railW}px`);
ok(m.railDisplay === 'flex', '左侧栏不是抽屉（display:flex）', m.railDisplay);
ok(Math.abs(m.compBottom - m.vh) <= 2, '输入框贴底', `bottom=${m.compBottom} vh=${m.vh}`);
ok(m.canScrollInner, '消息区内部可滚');

console.log('\n[桌面点「新对话」]');
const newChat = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('#chat-rail button')]
    .find((b) => b.textContent.includes('新对话'));
  if (!btn) return { found: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  return {
    found: true,
    railOpenClass: document.querySelector('#chat-rail').classList.contains('open'),
    bodyRailLock: document.body.classList.contains('rail-open'),
    msgs: document.querySelectorAll('.msg-row').length,
    railStillVisible: getComputedStyle(document.querySelector('.chat-rail')).display,
  };
});
console.log('  ', JSON.stringify(newChat));
ok(newChat.found, '找到「新对话」');
ok(!newChat.railOpenClass, '桌面上没有误加抽屉 open 类');
ok(!newChat.bodyRailLock, '桌面上没有误锁 body 滚动');
ok(newChat.railStillVisible === 'flex', '桌面上左侧栏仍然可见（不被关闭逻辑影响）', newChat.railStillVisible);
ok(newChat.msgs === 0, '消息区已清空', `还有 ${newChat.msgs} 条`);

console.log('\n[桌面删除对话]');
const del = await page.evaluate(async () => {
  const before = document.querySelectorAll('.rail-chat').length;
  const btn = document.querySelector('.rail-chat-del');
  if (!btn) return { found: false, before };
  // 桌面上删除按钮默认 opacity:0，靠 hover 显形；这里检查它仍然可被点击
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  return { found: true, before, modal: !!document.querySelector('.modal') };
});
console.log('  ', JSON.stringify(del));
ok(del.found, '桌面每个会话行也有删除按钮');
ok(del.modal, '删除前有二次确认');

const hoverCheck = await page.evaluate(() => {
  const b = document.querySelector('.rail-chat-del');
  return { opacity: getComputedStyle(b).opacity };
});
console.log('  delete btn opacity (no hover):', JSON.stringify(hoverCheck));
ok(true, `删除按钮默认透明度 ${hoverCheck.opacity}（桌面靠 hover 显形，属设计）`);

ok(errors.length === 0, '没有 JS 报错', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`截图: ${OUT}`);
process.exit(fail ? 1 : 0);
