#!/usr/bin/env node
/**
 * 把 node_modules 里的浏览器端依赖搬到 public/vendor/，转成原生 ESM。
 *
 * 为什么需要这一步：
 * 本项目没有打包器（不引入 vite/webpack 是刻意的，前端就是原生 ESM），
 * 而 @tencent-ai/workbuddy-cloud-sdk 的浏览器产物 index.global.js 是 IIFE
 * （`var WorkBuddyCloud = (() => {...})()`），里面一个 export 都没有。
 * 直接用 `await import('/vendor/xxx.js')` 加载会得到一个空模块对象，
 * 表现为 `createWorkBuddyCloud is not a function`，而且报错点离根因很远。
 *
 * 所以在文件末尾补一段具名导出。构建可重复执行，升级 SDK 后重跑即可。
 *
 * 用法：node scripts/build-vendor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public/vendor');

/** 需要搬运的包：源文件 → 输出文件 */
const TARGETS = [
  {
    pkg: '@tencent-ai/workbuddy-cloud-sdk',
    src: 'lib/index.global.js',
    out: 'workbuddy-cloud-sdk.js',
    // IIFE 里的全局变量名
    globalName: 'WorkBuddyCloud',
  },
];

/**
 * 从 IIFE 产物里读出它导出的成员名。
 *
 * 产物结构固定为 `At(nr,{Name:()=>local,Other:()=>x})` —— 一次 Object.defineProperty
 * 把所有成员挂到导出对象上。**只能在这一个块里找**：全文搜 `Name:()=>` 会把
 * 对象字面量里的普通 getter（例如某处 `get:()=>this.x`）也当成导出，
 * 生成出一条 `export const get = undefined`。
 */
function detectExports(code) {
  const marker = code.indexOf('At(nr,{');
  if (marker < 0) {
    throw new Error('找不到导出目录块 At(nr,{...})，产物结构可能变了，请人工确认。');
  }
  // 从块开头做花括号配对，取出完整的成员清单
  const start = code.indexOf('{', marker + 'At(nr,'.length);
  let depth = 0;
  let end = -1;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('导出目录块括号不闭合，产物结构可能变了。');

  const block = code.slice(start + 1, end);
  const names = new Set();
  const re = /([A-Za-z_$][\w$]*):\(\)=>/g;
  let m;
  while ((m = re.exec(block))) names.add(m[1]);
  return [...names].sort();
}

function buildOne(t) {
  const pkgDir = path.join(ROOT, 'node_modules', t.pkg);
  const srcPath = path.join(pkgDir, t.src);
  if (!fs.existsSync(srcPath)) {
    /* 云登录是**可选**功能：没配置 EP_CLOUD_* 时前端根本不会 import 这个文件。
     * 所以依赖缺失不该让整个安装/构建失败 —— 一个只想用邮箱登录的自建用户，
     * 不应该因为拉不到某个闭源 SDK 就装不上项目。
     * 返回 null，由调用方决定怎么提示。 */
    return null;
  }
  const code = fs.readFileSync(srcPath, 'utf8');

  if (/\bexport\s*\{/.test(code) || /\bexport\s+(const|function|class)\b/.test(code)) {
    throw new Error(`${t.src} 已经是 ESM 了，不需要再转换。请更新本脚本的 TARGETS 配置。`);
  }

  // 从 IIFE 尾部确认全局变量名真的存在，避免版本变化后静默产出坏文件
  if (!code.includes(`var ${t.globalName}=`)) {
    throw new Error(`${t.src} 里找不到 var ${t.globalName}=，产物结构可能变了，请人工确认。`);
  }

  const names = detectExports(code);
  if (!names.length) {
    throw new Error(`没能从 ${t.src} 里识别出任何导出成员，产物结构可能变了。`);
  }

  const banner = `/* 由 scripts/build-vendor.mjs 生成，请勿手工编辑。
 * 来源：${t.pkg}/${t.src}
 * 处理：原样保留 IIFE，仅在末尾补 ESM 具名导出。 */
`;
  const footer = `
/* ---- ESM 导出桥接（build-vendor.mjs 追加）---- */
${names.map((n) => `export const ${n} = ${t.globalName}.${n};`).join('\n')}
export default ${t.globalName};
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, t.out);
  fs.writeFileSync(outPath, banner + code + footer, 'utf8');

  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  return { outPath, names, kb };
}

const results = [];
const skipped = [];
for (const t of TARGETS) {
  const r = buildOne(t);
  if (!r) { skipped.push(t); continue; }
  // 把产物真的 import 一次：只看文本无法保证导出名在运行时有效，
  // 生成一条 `export const get = undefined` 这类坏桥接时必须在构建期就炸掉。
  const mod = await import(`file://${r.outPath.replace(/\\/g, '/')}?t=${Date.now()}`);
  const broken = r.names.filter((n) => mod[n] === undefined);
  if (broken.length) {
    throw new Error(`${t.out} 有导出成员在运行时是 undefined：${broken.join(', ')}`);
  }
  if (!mod.createWorkBuddyCloud) {
    throw new Error(`${t.out} 缺少 createWorkBuddyCloud，前端无法初始化云客户端。`);
  }
  results.push(r);
}

for (const r of results) {
  console.log(`✓ ${path.relative(ROOT, r.outPath)} (${r.kb} KB, ${r.names.length} exports)`);
  console.log(`  ${r.names.join(', ')}`);
}
for (const t of skipped) {
  console.log(`– 跳过 ${t.pkg}/${t.src}（依赖未安装）`);
  console.log('  云登录是可选功能：不配置 EP_CLOUD_* 时前端不会加载它。');
  console.log('  需要微信/手机号登录时：npm install 后重跑 npm run vendor');
}
