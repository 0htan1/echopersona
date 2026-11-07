/* 线上微信登录与手机端真实可用性验证。
 *
 * 本地跑不出这两件事：
 *   · 微信登录需要已发布的 https 域名（本地会被网关拒）
 *   · 手机端 virtualViewport / safe-area 行为要在真机尺寸下才成立
 *
 * 所以部署后单独验一遍。只读操作，不污染线上数据。
 *
 * 用法：node scripts/verify-online-wx.mjs "https://host/?sharecode=xxx"
 */
import fs from 'node:fs';
import { launch } from './lib/browser.mjs';

const RAW = process.argv[2];
if (!RAW) { console.error('用法: node scripts/verify-online-wx.mjs "<url?sharecode=...>"'); process.exit(1); }
const ORIGIN = new URL(RAW).origin;
const OUT = '.tmp/shots-online-wx';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0; let fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch();

/* ---------------------------------------------------------- 微信登录 */
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(RAW, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  await page.goto(`${ORIGIN}/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  /* 点微信按钮。
   * 关键是看它有没有报「只能在已发布的正式域名使用」——
   * 本地 http 一定报这个，线上 https 不该报。
   * 点完真去微信网关就算成功（我们不会也不该在这里完成扫码）。 */
  const before = await page.evaluate(() => location.href);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('微信'));
    if (!b) return false;
    b.click();
    return true;
  });
  ok(clicked, '点到微信登录按钮');
  await sleep(3000);

  const state = await page.evaluate(() => {
    const errEl = document.querySelector('.auth-err, .form-err, [role="alert"]');
    return {
      href: location.href,
      err: errEl ? errEl.textContent.trim() : '',
      bodyText: document.body.innerText.slice(0, 200),
    };
  });
  await page.screenshot({ path: `${OUT}/01-wx-click.png` });

  const blockedByLocalOnly = /只能在已发布的正式域名|本地或预览地址/.test(state.err);
  ok(!blockedByLocalOnly, '线上没被判成"本地/预览地址"', state.err || '(无错误提示)');

  // 要么已经跳去微信授权域，要么页面内出现了微信的扫码/跳转提示
  const wentWechat = /open\.weixin\.qq\.com|weixin:\/\/|qrconnect|wx\.qq\.com/i.test(state.href)
    || (state.href !== before && !state.href.includes('/login'));
  const hasWxUi = /微信扫码|请用微信|扫码登录|正在打开微信/.test(state.bodyText) || /wx-/.test(state.bodyText);
  ok(wentWechat || hasWxUi, '点微信后有真实的微信流程反应', JSON.stringify({ href: state.href.slice(0, 90), err: state.err.slice(0, 60) }));

  ok(errs.length === 0, '微信点击过程无 JS 报错', errs.slice(0, 2).join(' | '));
  await page.close();
}

/* --------------------------------------------- 手机端登录页细节 */
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await page.goto(`${ORIGIN}/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  const layout = await page.evaluate(() => {
    const form = document.querySelector('form.auth-form');
    const r = form?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      formW: r ? Math.round(r.width) : 0,
      formLeft: r ? Math.round(r.left) : -1,
      vw: window.innerWidth,
      inputsH: [...document.querySelectorAll('input')].map((i) => Math.round(i.getBoundingClientRect().height)),
      tapTargets: [...document.querySelectorAll('button, a.btn')]
        .map((b) => Math.round(b.getBoundingClientRect().height))
        .filter((h) => h > 0),
    };
  });

  ok(layout.overflow <= 1, '登录页无横向溢出', `overflow=${layout.overflow}`);
  ok(layout.formW > 0 && layout.formW <= layout.vw, '表单宽度不超过视口', `${layout.formW}/${layout.vw}`);
  ok(layout.formLeft >= 0 && layout.formLeft < 40, '表单左侧留白合理（没有贴边或跑出屏幕）', `left=${layout.formLeft}`);
  const tooSmall = layout.tapTargets.filter((h) => h < 36);
  ok(tooSmall.length === 0, '所有按钮高度 >= 36px（手指点得到）', tooSmall.length ? `有 ${tooSmall.length} 个过矮: ${tooSmall.join(',')}` : '');
  const smallInput = layout.inputsH.filter((h) => h < 36);
  ok(smallInput.length === 0, '输入框高度 >= 36px', smallInput.length ? smallInput.join(',') : '');

  await page.screenshot({ path: `${OUT}/02-mobile-login.png`, fullPage: true });
  await page.close();
}

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`截图: ${OUT}`);
process.exit(fail ? 1 : 0);
