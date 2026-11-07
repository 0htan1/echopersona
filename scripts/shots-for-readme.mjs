#!/usr/bin/env node
/**
 * 生成 README 用的界面截图。
 *
 * 只写给文档用的一次性脚本，不进验收链路（`scripts/verify-*.mjs` 是回归，
 * 这里只是把界面拍下来）。截图落盘到 docs/images/，README 直接引用。
 *
 * 数据由 mkdocs-demo.mjs 预先造好：一个演示账号 + 一个已完成分析的人格
 * + 一段导入记录 + 一段像样的对话。**不要用真实聊天记录截图** ——
 * 那是别人的隐私。
 *
 * 用法：node scripts/shots-for-readme.mjs [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, ROOT } from './lib/browser.mjs';
import { makeTestSession, loginWithToken } from './lib/test-login.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
// browser.mjs 的 ROOT 是 scripts/ 目录（它自己就在 scripts/lib 下往上两级才是项目根），
// 所以这里再往上走一级。
const OUT = path.join(ROOT, '..', 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });

const PERSONA_ID = process.env.DEMO_PERSONA_ID || 'per_demo_readme';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 先登录拿到 token，再用**同一个 token** 去造演示数据。
 *
 * 顺序很重要：makeTestSession 会清空该账号的业务数据（否则「默认值」类断言
 * 测到的不是默认值）。所以必须「先建会话、后灌数据」，
 * 反过来会把刚写进去的对话整套删掉，截图就变成空白页了。 */
const token = makeTestSession({ dataDir: process.env.DATA_DIR });
if (!token) { console.error('建测试会话失败'); process.exit(1); }

execFileSync(process.execPath, [path.join(ROOT, 'mkdocs-demo.mjs'), token], {
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR: process.env.DATA_DIR || '' },
});

const browser = await launch({ defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 } });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

async function shot(name, { full = false } = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ✓ ${name}.png (${kb} KB)`);
}

try {
  console.log('\n[docs] 生成 README 截图 →', OUT, '\n');

  /* 1. 对话页 —— 放最前面，这是产品最想让人看到的一屏。
   *    先把会话滚到最底部，让最近几轮完整可见。 */
  await loginWithToken(page, BASE, token);
  await page.goto(`${BASE}/app/chat/${PERSONA_ID}`, { waitUntil: 'networkidle2' });
  await sleep(2200);
  await page.evaluate(() => {
    const sc = document.querySelector('.chat-scroll, .messages, main');
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
  await sleep(700);
  await shot('chat');

  /* 2. 工作台 —— 展示「人格 / 消息 / 记忆」三组数字和引导清单 */
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle2' });
  await sleep(1800);
  await shot('dashboard');

  /* 3. 人格详情 —— 语言风格档案，这是「像不像」的证据 */
  await page.goto(`${BASE}/app/personas/${PERSONA_ID}`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  await shot('persona', { full: true });

  /* 4. 人格分析页 —— 确定性指标 + 带置信度的结论 */
  await page.goto(`${BASE}/app/personas/${PERSONA_ID}/analysis`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  await shot('analysis', { full: true });

  /* 5. 导入页 —— 拖拽多选、发送者映射 */
  await page.goto(`${BASE}/app/personas/${PERSONA_ID}/import`, { waitUntil: 'networkidle2' });
  await sleep(1600);
  await shot('import');

  /* 6. 设置页 —— 让「Key 只存服务端」看得见 */
  await page.goto(`${BASE}/app/settings/keys`, { waitUntil: 'networkidle2' });
  await sleep(1600);
  await shot('settings');

  /* 7. 登录页 —— README 顶部大图的气质版 */
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await sleep(1400);
  await shot('login');

  console.log('\n完成。\n');
} finally {
  await browser.close();
}
