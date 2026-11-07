/* 线上冒烟：只验证"打开就能用"，不做数据写入。
 *
 * 目的不是重复本地那 242 项断言，而是确认发布这件事本身没坏：
 *   1. 访问码门禁能过，SPA 能加载
 *   2. 登录页渲染正常，没有 JS 报错
 *   3. 手机视口下登录页不横向溢出
 *   4. 微信登录按钮在 https 下是真的可点（本地会被拦，这是关键差异点）
 *
 * 用法：node scripts/verify-online.mjs "https://host/?sharecode=xxx"
 */
import fs from 'node:fs';
import { launch } from './lib/browser.mjs';

const RAW = process.argv[2];
if (!RAW) { console.error('用法: node scripts/verify-online.mjs "<url?sharecode=...>"'); process.exit(1); }
const ORIGIN = new URL(RAW).origin;
const OUT = '.tmp/shots-online';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0; let fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch();

/* 桌面：门禁 + 登录页 */
{
  const page = await browser.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

  await page.goto(RAW, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/01-gate.png` });

  // 首页是落地页（介绍 + 两个入口），登录表单在 /login
  const landing = await page.evaluate(() => ({
    url: location.pathname,
    text: document.body.innerText.slice(0, 80).replace(/\n/g, ' '),
    hasLoginEntry: [...document.querySelectorAll('a,button')].some((x) => /登录|已有账户/.test(x.textContent)),
    hasStart: [...document.querySelectorAll('a,button')].some((x) => /开始使用|免费创建人格/.test(x.textContent)),
  }));
  ok(landing.hasLoginEntry, '落地页有登录入口', landing.text);
  ok(landing.hasStart, '落地页有开始使用入口', landing.text);

  await page.goto(`${ORIGIN}/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/02-login.png` });

  const onLogin = await page.evaluate(() => location.pathname);
  ok(onLogin.includes('login') || onLogin.includes('auth'), '能直接进 /login', onLogin);

  const hasField = await page.evaluate(() => !!document.querySelector('input[type="email"]') && !!document.querySelector('input[type="password"]'));
  ok(hasField, '邮箱与密码输入框都在');

  // 微信按钮：本地 http 会被拦，线上 https 应该是活的
  const wx = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('微信'));
    if (!b) return null;
    return { text: b.textContent.trim(), disabled: b.disabled, visible: b.offsetParent !== null };
  });
  ok(!!wx, '微信登录按钮存在', JSON.stringify(wx));
  ok(wx && wx.visible && !wx.disabled, '微信按钮可点击（线上 https 才成立）', JSON.stringify(wx));

  // 主题变量确实生效（说明 CSS 真加载了，不是门禁页）
  const themed = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    return { bg, webFont: getComputedStyle(document.body).fontFamily.slice(0, 40) };
  });
  ok(!/rgba\(0, 0, 0, 0\)/.test(themed.bg), '页面有实际背景色（CSS 已加载）', themed.bg);

  const realErrs = errs.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  ok(realErrs.length === 0, '桌面登录页无 JS 报错', realErrs.slice(0, 2).join(' | '));
  await page.close();
}

/* 手机：登录页布局 */
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(RAW, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/03-mobile-landing.png`, fullPage: false });

  const m0 = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyText: document.body.innerText.slice(0, 60).replace(/\n/g, ' '),
  }));
  ok(m0.overflow <= 1, '手机落地页无横向溢出', `overflow=${m0.overflow}`);
  ok(m0.bodyText.length > 10, '手机落地页渲染出内容', m0.bodyText);

  // 手机登录页
  await page.goto(`${ORIGIN}/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/04-mobile-login.png`, fullPage: false });

  const m = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hasEmail: !!document.querySelector('input[type="email"]'),
    bodyText: document.body.innerText.slice(0, 60),
  }));
  ok(m.overflow <= 1, '手机登录页无横向溢出', `overflow=${m.overflow}`);
  ok(m.hasEmail, '手机登录页表单可交互', m.bodyText.replace(/\n/g, ' '));
  ok(errs.length === 0, '手机登录页无 JS 报错', errs.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
console.log(`截图: ${OUT}`);
process.exit(fail ? 1 : 0);
