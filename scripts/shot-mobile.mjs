// 移动端视口截图：登录 → 逐页截图（iPhone 14 Pro 390x844）
import { launch } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:8080';
const OUT = process.argv[2] || '/tmp/shots-mobile';
const VW = Number(process.argv[3] || 390);
const VH = Number(process.argv[4] || 844);

import fs from 'node:fs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch();

const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

const shot = async (name) => {
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('shot', name);
};

// login
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));
await page.type('input[type="email"]', 'alice@example.com');
await page.type('input[type="password"]', 'GoodPass123');
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
await new Promise((r) => setTimeout(r, 1500));
console.log('url after login:', page.url());

await shot('01-dashboard');

const widthReport = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
}));
console.log('dashboard width:', JSON.stringify(widthReport));

// personas
await page.goto(`${BASE}/app/personas`, { waitUntil: 'networkidle2' });
await shot('02-personas');

// persona detail
const pid = await page.evaluate(async () => {
  const r = await fetch('/api/personas', { credentials: 'same-origin' });
  const j = await r.json();
  return j.personas?.[0]?.id || null;
});
console.log('persona:', pid);
if (pid) {
  await page.goto(`${BASE}/app/personas/${pid}`, { waitUntil: 'networkidle2' });
  await shot('03-persona-detail');
  const w = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
  console.log('persona detail width:', JSON.stringify(w));
}

// chat
if (pid) {
  await page.goto(`${BASE}/app/chat/${pid}`, { waitUntil: 'networkidle2' });
  await shot('04-chat');
  const w = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
  console.log('chat width:', JSON.stringify(w));
}

// settings
await page.goto(`${BASE}/app/settings`, { waitUntil: 'networkidle2' });
await shot('05-settings');
await page.goto(`${BASE}/app/settings/keys`, { waitUntil: 'networkidle2' });
await shot('06-settings-keys');
await page.goto(`${BASE}/app/voice`, { waitUntil: 'networkidle2' });
await shot('07-voice');

// landing
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await shot('08-landing');

await browser.close();
console.log('done ->', OUT);
