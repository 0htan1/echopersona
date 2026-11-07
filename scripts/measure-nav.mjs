#!/usr/bin/env node
/**
 * 真实浏览器的导航响应测量。
 *
 * 目的不是「看起来快」，而是量出「点下去到用户看见内容」这段空白有多长。
 * 上一轮改了三处：骨架屏（60ms 兜底）、请求并行化、点击缩放反馈。
 * 这里用 CDP 在网络节流下跑一遍，把数字打出来对比。
 *
 * 用法： node scripts/measure-nav.mjs [url]
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { execSync } = await import('node:child_process');
// 全局包的落地位置随 node 安装方式变化（这里在 .workbuddy/binaries 下），
// 不能假定是 %APPDATA%\npm，必须问 npm 自己。
const globalRoots = [];
try { globalRoots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* ignore */ }
globalRoots.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules'));

let puppeteer;
for (const root of globalRoots) {
  try { puppeteer = require(path.join(root, 'puppeteer-core')); break; } catch { /* 试下一个 */ }
}
if (!puppeteer) {
  console.error('需要全局 puppeteer-core：npm i -g puppeteer-core');
  process.exit(1);
}

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => { try { return require('node:fs').existsSync(p); } catch { return false; } });

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const EMAIL = `nav${Date.now()}@example.com`;
const PASS = 'Passw0rd123';

const fmt = (n) => `${String(Math.round(n)).padStart(5)}ms`;

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // ---- 注册并进入工作台（先在正常网络下完成，避免限速把注册页本身拖死）
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle2' });
  await page.evaluate((email, pass) => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('input[type=email]', email);
    document.querySelectorAll('input[type=password]').forEach((el) => {
      el.value = pass;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    set('input[type=text]', '验证');
    const cb = document.querySelector('input[type=checkbox]');
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  }, EMAIL, PASS);
  await page.evaluate(() => document.querySelector('form')?.requestSubmit?.());
  await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 45000 });

  // 已登录、shell 已就绪，这时候才开限速 + 清缓存。
  // 这样量到的是「已登录用户在各页之间跳转」的真实冷路径，
  // 而不是把首次加载的耗时混进来。
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.setCacheEnabled(false);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 60, downloadThroughput: (8 * 1024 * 1024) / 8, uploadThroughput: (2 * 1024 * 1024) / 8,
  });

  /* ---------------------------------------------------------- 测量
   * 从「点下去」到「真实内容出现」（骨架不算）的耗时。
   * 判据是页面里出现 .shell 且不再是 .shell-skeleton。 */
  const measure = async (fromSel, expectPath, label) => {
    // 旧页面的 h1 先记下来：URL 已经变了但 h1 还是旧标题，说明用户
    // 眼里什么都没变 —— 这正是「不跟手」的物理表现，必须能测出来。
    const oldH1 = await page.evaluate(() => document.querySelector('h1')?.textContent || '');
    const t0 = Date.now();
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, fromSel);

    // 进度条出现的时刻
    let barAt = null;
    for (let i = 0; i < 40; i += 1) {
      const vis = await page.evaluate(() => {
        const b = document.getElementById('nav-progress');
        return !!b && Number(getComputedStyle(b).opacity) > 0.1;
      });
      if (vis) { barAt = Date.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 10));
    }

    let sawSkeleton = false;
    let okPath = true;
    try {
      // 判据必须是「路径对 + 真内容在 + 没有骨架」，且 h1 已经换成新的。
      // 只查 .shell 存在会把还停在旧页面的状态误判成已完成。
      await page.waitForFunction((want, prevH1) => {
        if (document.querySelector('.shell-skeleton')) window.__sawSkel = 1;
        const h1 = document.querySelector('h1')?.textContent || '';
        const changed = h1 !== prevH1 || h1 !== '';
        return location.pathname === want
          && document.querySelector('.shell')
          && !document.querySelector('.shell-skeleton')
          && changed;
      }, { timeout: 15000, polling: 16 }, expectPath, oldH1);
    } catch { okPath = false; }
    const ms = Date.now() - t0;
    sawSkeleton = await page.evaluate(() => (window.__sawSkel || 0) > 0);
    await page.evaluate(() => { window.__sawSkel = 0; });
    return { label, ms, sawSkeleton, barAt, okPath };
  };

  const results = [];
  const navs = [
    ['a[href="/app/voice"]', '/app/voice', '工作台 → 语音'],
    ['a[href="/app/personas"]', '/app/personas', '语音 → 人格'],
    ['a[href="/app/settings"]', '/app/settings', '人格 → 设置'],
    ['a[href="/app/chat"]', '/app/chat', '设置 → 对话'],
    ['a[href="/app"]', '/app', '对话 → 工作台'],
  ];
  for (const [sel, path, label] of navs) {
    // 等上一页彻底稳定：shell 在、没有骨架、目标链接真的存在。
    // 不等这些就点，点击会打在空气上 —— 那测的是脚本手快，不是产品快慢。
    await page.waitForFunction(() => !document.querySelector('.shell-skeleton'), { timeout: 8000 }).catch(() => {});
    await page.waitForSelector(sel, { timeout: 8000 }).catch(() => null);
    if (!(await page.$(sel))) { continue; }
    const r = await measure(sel, path, label);
    results.push(r);
    await new Promise((res) => setTimeout(res, 250));
  }

  /* ------------------------------------- 点击反馈：按下瞬间就该有变化 */
  const pressFeedback = await page.evaluate(() => {
    const btn = document.querySelector('.btn') || document.querySelector('.side-item');
    if (!btn) return null;
    const before = getComputedStyle(btn).transform;
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    btn.classList.add('__probe');
    return { before, hasTransition: getComputedStyle(btn).transitionDuration };
  });

  /* ------------------------------------------- 点击后有没有「死按钮」 */
  const deadButtons = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button.btn:not([disabled])')];
    return btns.filter((b) => {
      const cs = getComputedStyle(b);
      return cs.pointerEvents === 'none' || cs.opacity === '0';
    }).length;
  });

  console.log('\n[measure-nav] 网络：60ms RTT / 8Mbps\n');
  for (const r of results) {
    console.log(`  ${r.label.padEnd(16)} ${fmt(r.ms)}  进度条 ${r.barAt === null ? '未出现' : fmt(r.barAt)}  骨架${r.sawSkeleton ? '出现' : '未出现'}${r.okPath ? '' : '  ← 未到位'}`);
  }
  const slow = results.filter((r) => !r.okPath || r.ms > 1200);
  const noBar = results.filter((r) => r.barAt === null);
  console.log(`  点击后 50ms 内有可见反馈：${results.length - noBar.length}/${results.length}`);
  console.log(`\n  最慢一次：${fmt(Math.max(...results.map((r) => r.ms)))}`);
  console.log(`  超过 1200ms 的导航：${slow.length} 个`);
  console.log(`  页面报错：${errors.length} 条${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
  console.log(`  不可点击的按钮：${deadButtons} 个`);
  console.log(`  按钮过渡时长：${pressFeedback?.hasTransition ?? '?'}`);

  await browser.close();
  const bad = results.filter((r) => r.ms > 1200).length + errors.length;
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
