/* 验收脚本共用的浏览器启动器。
 *
 * 为什么单独抽出来：
 *   这些脚本原来每个都把 puppeteer-core 的绝对路径和 Chrome 可执行文件路径
 *   写死在 import 行里（`file:///C:/Users/<某个人>/...`）。那种写法只在一台
 *   机器上成立：换个人 clone 下来第一行就 import 失败，而且把开发机的用户名
 *   和本地 Node 安装位置一起带进了公开仓库。
 *
 * 现在按这个顺序找 puppeteer：
 *   1. 环境变量 PUPPETEER_PATH（指向 puppeteer-core 的入口文件）
 *   2. 项目自己的 node_modules（`npm i -D puppeteer-core` 之后就是这条）
 *   3. 全局 npm 根目录
 * 找不到就给一句能照做的提示，而不是抛 ERR_MODULE_NOT_FOUND。
 *
 * Chrome 同理：优先 CHROME_PATH，其次各平台常见安装位置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const CHROME_CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

export function resolveChrome() {
  const env = String(process.env.CHROME_PATH || '').trim();
  if (env) {
    if (!fs.existsSync(env)) throw new Error(`CHROME_PATH 指向的文件不存在：${env}`);
    return env;
  }
  for (const p of CHROME_CANDIDATES[process.platform] || []) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    '找不到 Chrome/Edge。请安装 Chrome，或设置环境变量 CHROME_PATH 指向浏览器可执行文件。',
  );
}

/** 在若干候选目录里找 puppeteer-core 的入口，返回 file:// URL。 */
function findPuppeteerEntry() {
  const explicit = String(process.env.PUPPETEER_PATH || '').trim();
  if (explicit) {
    const p = pathToFileURL(path.resolve(explicit)).href;
    if (!fs.existsSync(path.resolve(explicit))) {
      throw new Error(`PUPPETEER_PATH 指向的文件不存在：${explicit}`);
    }
    return p;
  }

  const probes = [
    () => path.join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
    () => createRequire(path.join(ROOT, 'package.json')).resolve('puppeteer-core'),
    // 便携版 / nvm 风格的 Node：依赖装在 node 可执行文件同级的 node_modules 里
    () => path.join(path.dirname(process.execPath), 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
    () => path.join(path.dirname(process.execPath), '../lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
  ];
  // 全局安装（npm i -g puppeteer-core）时的兜底
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    probes.push(() => path.join(globalRoot, 'puppeteer-core/lib/puppeteer/puppeteer-core.js'));
  } catch { /* npm 不可用就算了 */ }

  for (const probe of probes) {
    try {
      const p = probe();
      if (p && fs.existsSync(p)) return pathToFileURL(p).href;
    } catch { /* 换下一个 */ }
  }
  throw new Error(
    '找不到 puppeteer-core。验收脚本需要它来驱动真实浏览器：\n'
    + '    npm i -D puppeteer-core\n'
    + '    # 或者：npm i -g puppeteer-core，或设置 PUPPETEER_PATH 指向它的入口文件',
  );
}

/** 供 `await launch()` 使用：自动补齐 executablePath 与常用参数。 */
export async function launch(overrides = {}) {
  const mod = await import(findPuppeteerEntry());
  const puppeteer = mod.default || mod;
  return puppeteer.launch({
    executablePath: resolveChrome(),
    headless: 'new',
    // --no-proxy-server：本机验收走 127.0.0.1，任何系统代理都会把请求吃掉
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    ...overrides,
  });
}

export default { launch, resolveChrome, ROOT };
