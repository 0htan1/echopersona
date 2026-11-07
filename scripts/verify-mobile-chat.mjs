/* 手机端对话页布局验收。
 *
 * 用户的原话是「界面直接占 100%，只允许聊天内部滚动，不允许整个框架滚动，
 * 输入框要在输入法上方」。这三件事在浏览器里都能被真实测量，
 * 所以这里不靠肉眼截图，而是把每条要求变成一个可断言的数值。
 *
 * 断言的落点：
 *   1. 整页不滚   → documentElement.scrollHeight <= clientHeight + 1
 *   2. 只有内层滚 → .chat-scroll 是唯一的可滚动容器，且它自己确实能滚
 *   3. 占满 100%  → .chat-layout 的高度 ≈ 视口高度
 *   4. 输入框可达 → .composer-wrap 的底边在视口内，且不被键盘盖住
 *      （用 visualViewport 模拟：把 --app-h 改小，看输入框是否跟着上移）
 *   5. 新对话跳转 → 手机端点了「＋ 新对话」抽屉必须收起
 *   6. 删除对话   → 每个会话行都有删除按钮，且点它不会切换会话
 *
 * 用法：node scripts/verify-mobile-chat.mjs [baseUrl]
 */
import { launch } from './lib/browser.mjs';
import fs from 'node:fs';
import { loginFast } from './lib/test-login.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const OUT = '/tmp/verify-mobile-chat';
fs.mkdirSync(OUT, { recursive: true });

const VW = 390;
const VH = 844;

let pass = 0; let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await launch();

const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 登录（固定账号 + 直接开 session，见 scripts/lib/test-login.mjs） ----
// 不走登录表单：/api/auth/login 有 15 分钟 12 次的防刷限流，一轮全量回归
// 就能打满，之后全是 401 —— 那是"测试准备"失败，不该混进结论。
await loginFast(page, BASE);
await wait(600);
if (page.url().includes('/login')) {
  // 兜底：注入 cookie 的路子失效时退回表单
  await page.type('input[type="email"]', process.env.EP_TEST_EMAIL || 'e2e@example.com');
  await page.type('input[type="password"]', process.env.EP_TEST_PWD || 'Passw0rd123');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);
  await wait(1400);
}
ok(!page.url().includes('/login'), '登录', page.url());

// ---- 建一个人格（对话页需要它） ----
/* 先塞一个模型配置。
 * 一个模型都没配时，聊天页会整页显示「还差一个模型来源」的空状态 ——
 * 那是正确设计，但那样就没有 .chat-scroll 可量了。
 * 这里只是让页面进入真正的聊天界面，不会真的去调模型。 */
await page.evaluate(async () => {
  await fetch('/api/llm-configs', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: '本地假模型', baseUrl: 'http://127.0.0.1:8791/v1',
      model: 'mock-model', apiKey: 'sk-fake', isDefault: true,
    }),
  }).catch(() => {});
});

const pid = await page.evaluate(async () => {
  const mk = await fetch('/api/personas', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '林小满', relationship: '多年好友', description: '话不多，爱用短句' }),
  });
  const j = await mk.json();
  if (j.persona?.id) return j.persona.id;
  const list = await fetch('/api/personas', { credentials: 'same-origin' }).then((r) => r.json());
  return list.personas?.[0]?.id || null;
});
ok(!!pid, '拿到人格 id', pid || '无');
if (!pid) { await browser.close(); process.exit(1); }

await page.goto(`${BASE}/app/chat/${pid}`, { waitUntil: 'networkidle2' });
await wait(1500);
await page.screenshot({ path: `${OUT}/01-chat.png` });

/* 造几条消息，让聊天区真的能滚起来 —— 空对话测不出"只有内部滚动"，
 * 因为没有内容可滚，什么实现都会通过。 */
const chatId = await page.evaluate(async (personaId) => {
  const r = await fetch(`/api/personas/${personaId}/chats`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '手机端布局验收' }),
  });
  const j = await r.json();
  return j.chat?.id || null;
}, pid);
ok(!!chatId, '建测试会话');

if (chatId) {
  /* 直接写库灌入消息。
   * 不走 /chat 接口：那条路要求配置真实模型，而这个脚本要验的是
   * 布局（能不能滚、滚在哪一层），不该被上游模型卡住。 */
  const { run, get } = await import('../src/db/index.js');
  const ownerId = get('SELECT user_id FROM personas WHERE id = ?', [pid])?.user_id;
  const now = Date.now();
  for (let i = 0; i < 24; i += 1) {
    run(`INSERT INTO messages (id,user_id,persona_id,chat_id,role,sender_raw,content,msg_type,ts,seq,is_imported,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
      [`msg_${now}_${i}`, ownerId, pid, chatId, i % 2 ? 'persona' : 'user',
        i % 2 ? '林小满' : null,
        i % 2 ? `第 ${i} 条：嗯，知道了，那你早点睡。` : `第 ${i} 条：今天在公司被组长当众说了一顿，心里挺堵的。`,
        'text', now + i * 1000, i + 1, now + i * 1000]);
  }
}

await page.goto(`${BASE}/app/chat/${pid}${chatId ? `/${chatId}` : ''}`, { waitUntil: 'networkidle2' });
await wait(1600);
await page.screenshot({ path: `${OUT}/02-chat-msgs.png` });

/* ============================================================
 * 1. 整页不滚 + 只允许 внутренний 滚动
 * ============================================================ */
console.log('\n[1] 整页滚动约束');
const scroll = await page.evaluate(() => {
  const de = document.documentElement;
  const body = document.body;
  const cs = getComputedStyle(document.querySelector('.chat-scroll') || document.body);
  const scrollEl = document.querySelector('.chat-scroll');
  return {
    docScrollH: de.scrollHeight,
    docClientH: de.clientHeight,
    bodyScrollH: body.scrollHeight,
    bodyClientH: body.clientHeight,
    bodyOverflow: getComputedStyle(body).overflow,
    bodyHasChatClass: body.classList.contains('chat-page'),
    chatScrollOverflowY: cs.overflowY,
    chatScrollClientH: scrollEl?.clientHeight || 0,
    chatScrollScrollH: scrollEl?.scrollHeight || 0,
    layoutH: Math.round(document.querySelector('.chat-layout')?.getBoundingClientRect().height || 0),
    vh: window.innerHeight,
    shellOverflow: getComputedStyle(document.querySelector('.shell')).overflow,
  };
});
console.log('  ', JSON.stringify(scroll));
ok(scroll.bodyHasChatClass, 'body 打上 chat-page 标记');
ok(scroll.docScrollH <= scroll.docClientH + 1, '整页不可滚（documentElement）', `${scroll.docScrollH} > ${scroll.docClientH}`);
ok(scroll.bodyScrollH <= scroll.bodyClientH + 1, '整页不可滚（body）', `${scroll.bodyScrollH} > ${scroll.bodyClientH}`);
ok(scroll.bodyOverflow === 'hidden', 'body overflow:hidden', scroll.bodyOverflow);
ok(scroll.shellOverflow === 'hidden', '.shell overflow:hidden', scroll.shellOverflow);
ok(scroll.chatScrollOverflowY === 'auto' || scroll.chatScrollOverflowY === 'scroll', '聊天区自己可滚', scroll.chatScrollOverflowY);
ok(Math.abs(scroll.layoutH - scroll.vh) <= 2, '聊天布局占满视口高度', `layout=${scroll.layoutH} vh=${scroll.vh}`);
ok(scroll.chatScrollScrollH > scroll.chatScrollClientH, '聊天区内容确实超出（可滚）', `${scroll.chatScrollScrollH} vs ${scroll.chatScrollClientH}`);

// 真的滚一下：滚动应该只发生在 .chat-scroll，body 的 scrollTop 必须保持 0
console.log('\n[2] 滚动只发生在消息区');
const scrolled = await page.evaluate(async () => {
  const el = document.querySelector('.chat-scroll');
  el.scrollTop = 0;
  window.scrollTo(0, 400);
  el.scrollTop = el.scrollHeight;
  await new Promise((r) => requestAnimationFrame(r));
  return { winY: window.scrollY, bodyTop: document.body.scrollTop, elTop: el.scrollTop };
});
console.log('  ', JSON.stringify(scrolled));
ok(scrolled.winY === 0, '窗口自身没有被滚动', `scrollY=${scrolled.winY}`);
ok(scrolled.bodyTop === 0, 'body 没有被滚动', `scrollTop=${scrolled.bodyTop}`);
ok(scrolled.elTop > 0, '消息区滚到底', `scrollTop=${scrolled.elTop}`);

/* ============================================================
 * 3. 输入框在视口内 / 跟随可视高度上移
 * ============================================================ */
console.log('\n[3] 输入框位置与软键盘');
const composer = await page.evaluate(() => {
  const w = document.querySelector('.composer-wrap');
  const r = w.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
});
console.log('  ', JSON.stringify(composer));
ok(composer.bottom <= composer.vh + 1, '输入区底边在视口内', `${composer.bottom} > ${composer.vh}`);
ok(composer.top > 0, '输入区顶边在视口内', `top=${composer.top}`);

/* 模拟软键盘。
 *
 * 不能只改 --app-h 这个 CSS 变量 —— 那只是"把结果写进去"，
 * 而真正需要验证的是「JS 收到视口变矮后，界面会不会跟着收缩并重新贴底」。
 * 所以这里驱动真实的事件源：把 visualViewport.height 打个桩，
 * 然后派发 resize 事件，走和我们线上完全相同的那条代码路径。
 *
 * 如果浏览器不允许改写 visualViewport（只读属性），退回为：
 * 直接调 CSS 变量 + 手动派发 resize，此时只验布局，不验 JS 联动。
 */
const kb = await page.evaluate(async () => {
  const scrollEl = document.querySelector('.chat-scroll');
  scrollEl.scrollTop = scrollEl.scrollHeight;   // 先在键盘弹起前滚到底
  const before = document.querySelector('.composer-wrap').getBoundingClientRect().bottom;
  const shrunk = window.innerHeight - 320;

  let stubbed = false;
  const vv = window.visualViewport;
  if (vv) {
    try {
      Object.defineProperty(vv, 'height', { configurable: true, get: () => shrunk });
      stubbed = true;
    } catch { /* 只读，退回下面的兜底 */ }
  }
  if (stubbed) {
    window.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('resize'));
  } else {
    document.documentElement.style.setProperty('--app-h', `${shrunk}px`);
  }
  await new Promise((r) => setTimeout(r, 300));

  const after = document.querySelector('.composer-wrap').getBoundingClientRect().bottom;
  const layoutH = Math.round(document.querySelector('.chat-layout').getBoundingClientRect().height);
  const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  return {
    before: Math.round(before), after: Math.round(after), shrunk, layoutH,
    atBottomPx: Math.round(atBottom), stubbed,
    docScrollH: document.documentElement.scrollHeight,
    docClientH: document.documentElement.clientHeight,
  };
});
console.log('  ', JSON.stringify(kb));
ok(kb.after <= kb.shrunk + 2, '键盘弹起（模拟）后输入框收缩到键盘上方', `bottom=${kb.after} 可用=${kb.shrunk}`);
ok(kb.after < kb.before, '输入框确实向上移动了', `${kb.before} → ${kb.after}`);
ok(Math.abs(kb.layoutH - kb.shrunk) <= 2, '聊天布局跟着可用高度收缩', `layout=${kb.layoutH} 可用=${kb.shrunk}`);
ok(kb.docScrollH <= kb.docClientH + 1, '键盘弹起后整页仍然不滚', `${kb.docScrollH} > ${kb.docClientH}`);
/* 键盘吃掉大半屏幕后，如果消息区还停在旧位置，用户刚打的字就在视野外，
 * 看起来像"输入框跳走了"。所以收缩之后必须重新贴到底。 */
ok(kb.atBottomPx <= 4, '键盘弹起后消息区重新贴到底部', `距底部 ${kb.atBottomPx}px`);

await page.screenshot({ path: `${OUT}/03-kb-sim.png` });

// 恢复
await page.evaluate(() => document.documentElement.style.removeProperty('--app-h'));
await wait(200);

/* ============================================================
 * 4. 新对话：手机上必须收起抽屉并露出空对话
 * ============================================================ */
console.log('\n[4] 点「新对话」直接跳到新对话');
await page.evaluate(() => {
  document.querySelector('#rail-toggle')?.click();
});
await wait(500);
const railOpen = await page.evaluate(() => ({
  open: document.querySelector('#chat-rail')?.classList.contains('open'),
  bodyLocked: document.body.classList.contains('rail-open'),
}));
ok(railOpen.open, '抽屉已打开（前置条件）', JSON.stringify(railOpen));

// 抽屉里找「＋ 新对话」
const clickedNew = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#chat-rail button')]
    .find((b) => b.textContent.includes('新对话'));
  if (!btn) return false;
  btn.click();
  return true;
});
ok(clickedNew, '找到「新对话」按钮');
await wait(600);
const afterNew = await page.evaluate(() => ({
  open: document.querySelector('#chat-rail')?.classList.contains('open'),
  bodyLocked: document.body.classList.contains('rail-open'),
  msgCount: document.querySelectorAll('.msg-row').length,
  railDisplay: getComputedStyle(document.querySelector('#chat-rail')).display,
}));
console.log('  ', JSON.stringify(afterNew));
ok(!afterNew.open, '抽屉已自动收起', JSON.stringify(afterNew));
ok(!afterNew.bodyLocked, '背景滚动锁已解除');
ok(afterNew.railDisplay === 'none', '抽屉在窄屏上真的消失', afterNew.railDisplay);
ok(afterNew.msgCount === 0, '消息区已清空（露出新对话）', `还有 ${afterNew.msgCount} 条`);
await page.screenshot({ path: `${OUT}/04-new-chat.png` });

/* ============================================================
 * 5. 删除整个对话
 * ============================================================ */
console.log('\n[5] 删除整个对话');
await page.evaluate(() => document.querySelector('#rail-toggle')?.click());
await wait(500);

const delBtns = await page.evaluate(() => ({
  rows: document.querySelectorAll('.rail-chat').length,
  dels: document.querySelectorAll('.rail-chat-del').length,
  // 删除按钮不能嵌在 .rail-chat 里面（button 里套 button 是非法 HTML）
  nested: document.querySelectorAll('.rail-chat .rail-chat-del').length,
}));
console.log('  ', JSON.stringify(delBtns));
ok(delBtns.rows > 0, '有会话行可删', `rows=${delBtns.rows}`);
ok(delBtns.dels === delBtns.rows, '每个会话行都有删除按钮', `${delBtns.dels}/${delBtns.rows}`);
ok(delBtns.nested === 0, '删除按钮没有嵌套在会话按钮里', `nested=${delBtns.nested}`);

// 点删除 → 应出现确认框，而不是直接切换会话
const beforeDelete = await page.evaluate(() => {
  const btn = document.querySelector('.rail-chat-del');
  const activeBefore = document.querySelector('.rail-chat.active')?.querySelector('.t')?.textContent || '';
  btn.click();
  return { activeBefore };
});
await wait(500);
const modalShown = await page.evaluate(() => {
  const m = document.querySelector('.modal');
  return {
    hasModal: !!m,
    text: m?.textContent?.slice(0, 120) || '',
    stillOpenRail: document.querySelector('#chat-rail')?.classList.contains('open'),
  };
});
console.log('  ', JSON.stringify(modalShown));
ok(modalShown.hasModal, '删除前有二次确认', JSON.stringify(modalShown));
ok(/无法恢复|会被一起删除/.test(modalShown.text), '确认框说明了不可恢复', modalShown.text);

// 确认删除
const confirmed = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.modal-foot button, .modal button')];
  const b = btns.find((x) => x.textContent.includes('删除对话'));
  if (!b) return false;
  b.click();
  return true;
});
ok(confirmed, '确认框里有「删除对话」按钮');
await wait(1200);
const afterDelete = await page.evaluate(() => ({
  rows: document.querySelectorAll('.rail-chat').length,
  toastText: document.querySelector('.toast')?.textContent || '',
}));
console.log('  ', JSON.stringify(afterDelete));
ok(afterDelete.rows < delBtns.rows, '会话行确实减少了一条', `${delBtns.rows} → ${afterDelete.rows}`);
await page.screenshot({ path: `${OUT}/05-deleted.png` });

/* ============================================================
 * 6. 无横向溢出（手机上最容易翻车的一项）
 * ============================================================ */
console.log('\n[6] 横向溢出');
const hOverflow = await page.evaluate(() => {
  const de = document.documentElement;
  return { scrollW: de.scrollWidth, clientW: de.clientWidth };
});
console.log('  ', JSON.stringify(hOverflow));
ok(hOverflow.scrollW <= hOverflow.clientW + 1, '聊天页没有横向溢出', `${hOverflow.scrollW} > ${hOverflow.clientW}`);

// 窄屏 360（很多安卓机）也过一遍
console.log('\n[7] 360px 窄屏');
await page.setViewport({ width: 360, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(`${BASE}/app/chat/${pid}`, { waitUntil: 'networkidle2' });
await wait(1400);
const narrow = await page.evaluate(() => {
  const de = document.documentElement;
  const cs = document.querySelector('.composer-wrap').getBoundingClientRect();
  return {
    scrollW: de.scrollWidth, clientW: de.clientWidth,
    docScrollH: de.scrollHeight, docClientH: de.clientHeight,
    composerBottom: Math.round(cs.bottom), vh: window.innerHeight,
    headH: Math.round(document.querySelector('.chat-head')?.getBoundingClientRect().height || 0),
  };
});
console.log('  ', JSON.stringify(narrow));
ok(narrow.scrollW <= narrow.clientW + 1, '360px 无横向溢出', `${narrow.scrollW} > ${narrow.clientW}`);
ok(narrow.docScrollH <= narrow.docClientH + 1, '360px 整页不滚', `${narrow.docScrollH} > ${narrow.docClientH}`);
ok(narrow.composerBottom <= narrow.vh + 1, '360px 输入框在视口内', `${narrow.composerBottom} > ${narrow.vh}`);
await page.screenshot({ path: `${OUT}/06-360.png` });

console.log('\n[8] 运行期错误');
ok(errors.length === 0, '没有 JS 报错', errors.slice(0, 4).join(' | '));

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`截图: ${OUT}`);
process.exit(fail ? 1 : 0);
