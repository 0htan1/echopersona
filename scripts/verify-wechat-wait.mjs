/* 微信登录等待页验收。
 *
 * 用户的原话是「微信登录时候的等待页面也要有提示，而不是在登录页面空等」。
 *
 * 这条不能靠"真的去微信扫码"来验 —— relay 只接受已发布的 https 域名，
 * 本地跑不通。但用户抱怨的那个状态是可复现的：地址栏带着
 * ?wechat=1&code=xxx 从微信跳回来之后，换 token 需要 1~3 秒，
 * 这几秒里页面原本毫无变化。
 *
 * 所以这里直接模拟这个状态：拦截 /api/auth/cloud-config 和
 * /api/auth/cloud/exchange，让换取身份这一步慢下来，然后观察：
 *   1. 等待层是否出现、是否有明确文案
 *   2. 等待层是否盖住了底下的表单（防止同时登另一个号）
 *   3. 进度/阶段文案是否会随时间推进（不是一张静止的图）
 *   4. 失败后等待层必须撤掉，并给出人能看懂的错误
 *   5. 成功路径等待层必须撤掉
 */
import { launch } from './lib/browser.mjs';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const OUT = '/tmp/verify-wechat-wait';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0; let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch();

/* 一个受控的假 SDK。
 *
 * 为什么不直接给真 SDK 一个假 publishableKey：它会在构造时就校验前缀
 * 并同步抛错，于是整个流程在等待层出现之前就结束了 —— 那测不到任何东西。
 * 这里替换掉 /vendor/workbuddy-cloud-sdk.js，只实现被用到的那两个方法，
 * 让"换 token 很慢"这个场景可以被精确复现。
 */
const FAKE_SDK = `
export function createWorkBuddyCloud() {
  return {
    auth: {
      async signInWithOAuth() {
        return { data: { url: 'https://relay.invalid/oauth' } };
      },
      async handleWechatWebCallback() {
        // 真 SDK 这一步要跟微信网关来回一次，实测 1~3 秒
        await new Promise((r) => setTimeout(r, 1200));
        return { data: { accessToken: 'fake_access_token_for_test' } };
      },
      async sendOtp() { return { data: {} }; },
      async verifyOtp() { return { data: {} }; },
    },
  };
}
`;

/* ---------------------------------------------------------------- *
 * 第一轮：从微信回跳，等待层必须在第一帧就出现。
 * 让 exchange 慢 1.8 秒再 401 —— 这正是用户"空等"的那段时间。
 * ---------------------------------------------------------------- */
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/vendor/workbuddy-cloud-sdk.js')) {
    return req.respond({ status: 200, contentType: 'text/javascript', body: FAKE_SDK });
  }
  if (url.includes('/api/auth/cloud-config')) {
    return req.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        endpoint: 'https://example.invalid',
        oauthRelayBaseUrl: 'https://relay.example.invalid',
        publishableKey: 'wbpk_test_key',
      }),
    });
  }
  if (url.includes('/api/auth/cloud/exchange')) {
    return setTimeout(() => req.respond({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: '微信授权已失效，请重新登录' }),
    }), 1800);
  }
  return req.continue();
});

console.log('[1] 从微信回跳：等待层出现');
await page.goto(`${BASE}/login?next=%2Fapp&wechat=1&code=fake_code_123&state=fake_state`, {
  waitUntil: 'domcontentloaded',
});
// 等 SDK 那个 import 失败之前先抓一眼等待层 —— 它必须在第一帧就有
await wait(400);
const firstFrame = await page.evaluate(() => {
  const w = document.querySelector('.wx-wait');
  return {
    exists: !!w,
    title: w?.querySelector('.wx-wait-title')?.textContent || '',
    label: w?.querySelector('.wx-wait-label')?.textContent || '',
    note: w?.querySelector('.wx-wait-note')?.textContent || '',
    zIndex: w ? getComputedStyle(w).zIndex : '',
    position: w ? getComputedStyle(w).position : '',
    role: w?.getAttribute('role') || '',
  };
});
console.log('  ', JSON.stringify(firstFrame));
ok(firstFrame.exists, '等待层已渲染');
ok(/微信/.test(firstFrame.title), '有明确的标题「正在完成微信登录」', firstFrame.title);
ok(firstFrame.label.length > 0, '有阶段文案', firstFrame.label);
ok(/不要关闭|不要刷新/.test(firstFrame.note), '提示了「不要关闭页面」', firstFrame.note);
ok(firstFrame.position === 'fixed', '覆盖整屏（fixed）', firstFrame.position);
ok(Number(firstFrame.zIndex) >= 100, '层级足够高，盖住表单', firstFrame.zIndex);
ok(firstFrame.role === 'status', '对读屏软件可播报（role=status）', firstFrame.role);

await page.screenshot({ path: `${OUT}/01-wait-overlay.png` });

console.log('\n[2] 阶段文案会推进（不是一张静止的图）');
const t0Label = await page.evaluate(() => document.querySelector('.wx-wait-label')?.textContent || '');
const t0Bar = await page.evaluate(() => {
  const f = document.querySelector('.wx-wait-bar-fill');
  return f ? getComputedStyle(f).transform : '';
});
await wait(1700);
const t1Label = await page.evaluate(() => document.querySelector('.wx-wait-label')?.textContent || '');
const t1Bar = await page.evaluate(() => {
  const f = document.querySelector('.wx-wait-bar-fill');
  return f ? getComputedStyle(f).transform : '';
});
console.log('  label:', JSON.stringify([t0Label, t1Label]));
console.log('  bar:', JSON.stringify([t0Bar, t1Bar]));
ok(t0Label !== t1Label || t0Bar !== t1Bar, '等待期间界面确实在动（文案或进度条）',
  `label ${t0Label === t1Label ? 'same' : 'changed'}, bar ${t0Bar === t1Bar ? 'same' : 'changed'}`);

console.log('\n[3] 等待层挡住底下的登录表单');
const blocked = await page.evaluate(() => {
  const w = document.querySelector('.wx-wait');
  if (!w) return { exists: false };
  const r = w.getBoundingClientRect();
  // 命中测试：屏幕中心的元素必须是等待层（或其子元素），不能是底下的输入框
  const mid = document.elementFromPoint(r.width / 2, r.height / 2);
  return {
    exists: true,
    coversForm: !!(mid && (mid.closest('.wx-wait') || mid === w)),
    top: Math.round(r.top), height: Math.round(r.height),
  };
});
console.log('  ', JSON.stringify(blocked));
ok(blocked.coversForm, '屏幕中心被等待层占据（点不到表单）', JSON.stringify(blocked));

console.log('\n[4] 失败后等待层撤掉并给出错误');
await wait(2600);
const afterFail = await page.evaluate(() => ({
  overlayGone: !document.querySelector('.wx-wait'),
  errText: document.querySelector('.auth-form .tiny')?.textContent
    || [...document.querySelectorAll('.tiny')].map((x) => x.textContent).find((t) => t && t.length > 4) || '',
  urlHasCode: location.search.includes('code='),
}));
console.log('  ', JSON.stringify(afterFail));
ok(afterFail.overlayGone, '失败后等待层已移除');
ok(afterFail.errText.length > 0, '页面上给出了错误提示', afterFail.errText.slice(0, 60));
ok(!afterFail.urlHasCode, '地址栏上的 code 已被清掉（刷新不会重复失败）', afterFail.urlHasCode ? '还在' : '');

await page.screenshot({ path: `${OUT}/02-after-fail.png` });

/* ---------------------------------------------------------------- *
 * 第二轮：正常登录页（没有 code）不该出现等待层
 * ---------------------------------------------------------------- */
console.log('\n[5] 普通登录页不显示等待层');
const page2 = await browser.newPage();
await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page2.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
await wait(600);
const plain = await page2.evaluate(() => ({
  overlay: !!document.querySelector('.wx-wait'),
  hasForm: !!document.querySelector('.auth-form'),
}));
console.log('  ', JSON.stringify(plain));
ok(!plain.overlay, '普通登录页没有等待层（不会误黑屏）');
ok(plain.hasForm, '登录表单正常渲染');

/* ---------------------------------------------------------------- *
 * 第三轮：微信按钮点击后的忙碌态
 *
 * 注意这一轮在本地**必然失败**，而且不该算代码的错：
 * startWechat() 有意在跳转之前就拦下 localhost / http —— relay 只接受
 * 已发布的 https 域名，照直跳过去用户会落在一个纯 JSON 的错误页上。
 * 所以在本地，按钮被点亮后立刻报错并复位，这是正确行为。
 * 这里只断言"用户点下去有可见反应"（要么忙碌态，要么错误提示），
 * 不去假装能验证线上跳转。
 * ---------------------------------------------------------------- */
console.log('\n[6] 点微信登录按钮后用户看得到反应');
const wxBtnState = await page2.evaluate(async () => {
  const btns = [...document.querySelectorAll('.auth-social button, .auth-social a')];
  const wx = btns.find((b) => /微信/.test(b.textContent));
  if (!wx) return { found: false };
  const beforeLabel = wx.textContent.trim();
  const errBefore = document.querySelector('.auth-form .tiny')?.textContent || '';
  wx.click();
  await new Promise((r) => setTimeout(r, 600));
  const errAfter = document.querySelector('.auth-form .tiny')?.textContent || '';
  return {
    found: true,
    beforeLabel,
    afterLabel: wx.textContent.trim(),
    busy: wx.classList.contains('is-busy'),
    disabled: wx.disabled,
    errChanged: errBefore !== errAfter,
    errAfter: errAfter.slice(0, 70),
  };
});
console.log('  ', JSON.stringify(wxBtnState));
ok(wxBtnState.found, '页面有微信登录按钮');
/* 本地点了必然报错（localhost 被主动拦下，这是设计），
 * 所以判据是"要么进入忙碌态，要么给出了错误提示" —— 两者都证明
 * 用户点下去之后界面有反应，而不是毫无动静。 */
ok(wxBtnState.busy || wxBtnState.errChanged || wxBtnState.afterLabel !== wxBtnState.beforeLabel,
  '点击后有可见反馈（忙碌态或错误提示）', JSON.stringify(wxBtnState));

await page2.screenshot({ path: `${OUT}/03-plain-login.png` });

ok(errors.length === 0, '没有未捕获的 JS 报错', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`截图: ${OUT}`);
process.exit(fail ? 1 : 0);
