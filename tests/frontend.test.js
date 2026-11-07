/**
 * 前端契约测试。
 *
 * 为什么需要这一层：后端 API 测试只能证明「接口按约定返回 JSON」，
 * 却无法证明「前端能吃掉这份 JSON」。真实翻车过的例子：
 *   /api/personas/:id 返回 { persona, imports, profile, chunkCount }，
 *   并没有 senders 字段（senders 在独立端点）。前端写 data.senders.length，
 *   接口测试全绿，页面一打开就 Cannot read properties of undefined。
 *
 * 这里因此做两件事：
 *   1. 起真实服务器 + 真实假上游，走完注册 → 建人格 → 导入 → 分析 → 建会话 → 聊天 全流程；
 *   2. 把这些真实响应喂给前端页面渲染函数，任何一处字段名对不上都会抛错。
 *
 * 依赖的是 public/js 下的真实产物 —— 不是 mock 出来的假前端，
 * 所以 h() / import 路径 / async 调用这些错误同样会被抓到。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLlm, startTts } from './helpers/upstreams.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echopersona-fe-'));process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'fe-master-key-0123456789abcdef';
process.env.SSRF_ALLOW_PRIVATE = '1';
process.env.BACKUP_INTERVAL_HOURS = '0';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');

let app;
let baseUrl;
let llmServer, ttsServer;
let llmPort, ttsPort;
let cookie = '';
let personaId = '';

/* ------------------------------------------------------- DOM 仿真 */
/**
 * 一个最小可用的 DOM。只实现前端真正会碰到的部分：
 * createElement / append / classList / 属性 / dataset / 简单查询。
 * 一旦页面用到没实现的方法，就会抛 TypeError —— 这正是我们要的，
 * 因为那意味着这段代码在真实浏览器里也可能挂。
 */
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    attrs: {},
    childNodes: [],
    parentNode: null,
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    files: [],
    classList: {
      add(...c) { el.className = [...new Set([...el.className.split(' ').filter(Boolean), ...c])].join(' '); },
      remove(...c) { el.className = el.className.split(' ').filter((x) => x && !c.includes(x)).join(' '); },
      toggle(c) { if (el.className.split(' ').includes(c)) el.classList.remove(c); else el.classList.add(c); },
      contains(c) { return el.className.split(' ').includes(c); },
    },
    get children() { return el.childNodes.filter((n) => n.nodeType === 1); },
    // 必须严格按 DOM 规范实现：append() 的参数只要不是 Node，
    // 一律 String() 之后当文本插进去 —— 包括 null / undefined / false。
    // 早期这里写的是 `else if (n)`，把假值悄悄丢掉，于是
    // `wrap.append(card, maybeNull, other)` 在测试里干干净净，
    // 到浏览器里就变成页面上三个孤零零的 "null"。测试替身比浏览器宽容，
    // 等于替被测代码兜了底，这条 bug 因此躲过了 103 个用例。
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === 'object' && (n.nodeType === 1 || n.nodeType === 3)) {
          n.parentNode = el; el.childNodes.push(n);
        } else {
          el.childNodes.push(makeText(n));
        }
      }
    },
    appendChild(n) { el.append(n); return n; },
    prepend(n) { el.childNodes.unshift(n); },
    insertBefore(n, ref) {
      const i = el.childNodes.indexOf(ref);
      if (i < 0) el.childNodes.push(n); else el.childNodes.splice(i, 0, n);
      return n;
    },
    removeChild(n) {
      const i = el.childNodes.indexOf(n);
      if (i >= 0) el.childNodes.splice(i, 1);
      return n;
    },
    remove() { el.parentNode?.removeChild(el); },
    replaceChildren(...n) { el.childNodes = []; el.append(...n); },
    replaceChild(n, old) { const i = el.childNodes.indexOf(old); if (i >= 0) el.childNodes[i] = n; return old; },
    cloneNode() { return makeEl(tag); },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
      if (k === 'class') el.className = String(v);
      if (k === 'id') el.id = String(v);
      if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
      if (k === 'value') el.value = String(v);
    },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    hasAttribute(k) { return k in el.attrs; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    scrollTo() {}, scrollBy() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0, clientWidth: 0,
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    matches() { return false; },
  };
  return el;
}
function makeText(t) {
  return { nodeType: 3, textContent: String(t), parentNode: null, remove() {} };
}

/** 页面 mount() 的目标容器，document.getElementById('app') 返回它。 */
const appRoot = makeEl('div');

/**
 * 从元素树里收集纯文本，用于断言「页面上真的渲染出了内容」。
 * 只断言「没抛异常」不够 —— 一个只渲染出空壳的页面也会通过。
 */
function textOf(node, depth = 0) {
  if (!node || depth > 200) return '';
  if (node.nodeType === 3) return node.textContent;
  const self = node.textContent && node.childNodes?.length === 0 ? node.textContent : '';
  return self + (node.childNodes || []).map((c) => textOf(c, depth + 1)).join(' ');
}

/** 深度遍历收集满足条件的元素，用于「树里有没有 SVG / 有没有某个 class」这类断言 */
function collect(node, pred, out = [], depth = 0) {
  if (!node || node.nodeType !== 1 || depth > 200) return out;
  if (pred(node)) out.push(node);
  for (const c of node.childNodes || []) collect(c, pred, out, depth + 1);
  return out;
}

const documentStub = {
  createElement: (t) => makeEl(t),
  // SVG 必须走命名空间版本。前端用 createElementNS 建喇叭图标，
  // 缺了这个方法页面一渲染语音气泡就直接 TypeError。
  createElementNS: (ns, t) => makeEl(t),
  createTextNode: (t) => makeText(t),
  createDocumentFragment: () => makeEl('fragment'),
  // 页面里 mount() 会找 #app 并 replaceChildren，这里给它一个真实容器
  getElementById: (id) => (id === 'app' ? appRoot : null),
  querySelector: (sel) => (sel === '#app' ? appRoot : null),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  title: '',
  body: makeEl('body'),
  head: makeEl('head'),
  documentElement: makeEl('html'),
  activeElement: null,
};

before(async () => {
  llmServer = await startLlm();
  ttsServer = await startTts();
  llmPort = llmServer.address().port;
  ttsPort = ttsServer.address().port;

  // 必须在 import 前端模块之前装好全局环境，模块加载期就会摸 document
  globalThis.Node = class Node {};
  globalThis.Element = class Element extends globalThis.Node {};
  globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
  // 让 makeEl 造出来的对象 instanceof Node 成立，h() 依赖这个判断
  Object.setPrototypeOf(makeEl('x'), globalThis.Node.prototype);

  const patched = new WeakSet();
  const origCreate = documentStub.createElement;
  documentStub.createElement = (t) => {
    const e = origCreate(t);
    if (!patched.has(e)) {
      Object.setPrototypeOf(e, globalThis.Node.prototype);
      patched.add(e);
    }
    return e;
  };
  const origText = documentStub.createTextNode;
  documentStub.createTextNode = (t) => {
    const e = origText(t);
    if (!patched.has(e)) { Object.setPrototypeOf(e, globalThis.Node.prototype); patched.add(e); }
    return e;
  };
  // SVG 元素同样必须是 Node，否则 h() 的 instanceof 判断会把喇叭图标
  // 当成普通字符串丢掉 —— 页面在浏览器里正常，测试里却是个空气泡。
  // 顺便把 namespaceURI 记下来：浏览器里 createElementNS 建出来的元素才有
  // 这个属性，而用 createElement 建 SVG 会得到一个 HTMLUnknownElement ——
  // 图形一个都不画。测试替身必须能分辨这两者，否则「图标是不是真 SVG」测不出来。
  const origNs = documentStub.createElementNS;
  documentStub.createElementNS = (ns, t) => {
    const e = origNs(ns, t);
    Object.defineProperty(e, 'namespaceURI', { value: ns, configurable: true, enumerable: true });
    if (!patched.has(e)) { Object.setPrototypeOf(e, globalThis.Node.prototype); patched.add(e); }
    return e;
  };

  globalThis.document = documentStub;
  const loc = {
    pathname: '/app', href: 'http://127.0.0.1/app', search: '', hash: '',
    origin: 'http://127.0.0.1', assign() {}, replace() {}, reload() {},
  };
  globalThis.location = loc;
  globalThis.history = { pushState() {}, replaceState() {}, back() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // navigator 在 Node 22 上是只读访问器，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-test', clipboard: { writeText: async () => {} } },
    configurable: true, writable: true,
  });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {} unobserve() {} disconnect() {}
  };
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.PopStateEvent = class PopStateEvent { constructor(t) { this.type = t; } };
  globalThis.Audio = class Audio {
    constructor() { this.paused = true; this.currentTime = 0; this.duration = 1; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {} removeEventListener() {}
  };
  globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
    open() {} setRequestHeader() {} send() { this.onerror?.(); }
    getAllResponseHeaders() { return ''; }
  };
  globalThis.EventSource = class EventSource {
    constructor() { this.readyState = 0; }
    addEventListener() {} close() {} removeEventListener() {}
  };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.ScrollBehavior = 'auto';

  globalThis.window = {
    document: documentStub, location: loc, history: globalThis.history,
    localStorage: globalThis.localStorage, navigator: globalThis.navigator,
    innerWidth: 1440, innerHeight: 900,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    scrollTo() {}, scrollY: 0, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };

  // 起真实服务器
  const { buildServer } = await import('../src/server.js');
  app = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  // 前端用的是相对路径 + same-origin cookie，这里把 fetch 转发过去并补上 cookie
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input).startsWith('http') ? String(input) : baseUrl + String(input);
    const headers = { ...(init.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await realFetch(url, { ...init, headers });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const m = sc.match(/ep_session=([^;]+)/);
      if (m) cookie = `ep_session=${m[1]}`;
    }
    return res;
  };

  // ---- 准备真实数据：注册 → 配置上游 → 建人格 → 导入 → 分析 → 建会话 → 聊天
  const post = async (p, body) => {
    const r = await globalThis.fetch(p, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, body: json };
  };
  const get = async (p) => {
    const r = await globalThis.fetch(p);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const reg = await post('/api/auth/register', {
    email: 'fe@example.com', password: 'fe-password-1234',
    displayName: '前端测试', consent: true,
  });
  assert.equal(reg.status, 200, `注册失败: ${JSON.stringify(reg.body)}`);

  const llm = await post('/api/llm-configs', {
    label: '测试 LLM', baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: 'sk-test-key-123456', model: 'fake-model', asDefault: true,
  });
  assert.equal(llm.status, 200, `LLM 配置失败: ${JSON.stringify(llm.body)}`);

  const tts = await post('/api/tts-configs', {
    label: '测试 TTS', kind: 'breeze_local',
    baseUrl: `http://127.0.0.1:${ttsPort}`,
    apiKey: 'tts-test-key-123456', asDefault: true,
  });
  assert.equal(tts.status, 200, `TTS 配置失败: ${JSON.stringify(tts.body)}`);

  const p = await post('/api/personas', {
    name: '林小满', relationship: '多年好友', bio: '总在加班的人',
    description: '说话短，爱自嘲。', language: 'zh', similarityMode: 'natural',
  });
  assert.equal(p.status, 200, `建人格失败: ${JSON.stringify(p.body)}`);
  personaId = p.body.persona.id;

  // 真实导入一段聊天记录，让后续页面有数据可渲染
  const txt = `2024-03-12 21:04:33 林小满
今天下班又是十点半，地铁上人还是好多。

2024-03-12 21:05:02 我
又加班？你们组是不要人活了吧

2024-03-12 21:05:41 林小满
害，习惯了，反正回去也是一个人待着。`;
  const boundary = '----fecontractboundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="personaSender"\r\n\r\n林小满\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="chat.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(txt),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const imp = await globalThis.fetch(`/api/personas/${personaId}/imports`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: payload,
  });
  const impBody = await imp.json();
  /* 导入已改为异步 job：立刻返回 202 + jobId，解析与入库在后台跑。
   * 这里必须真的等到 job 完成，否则后续页面渲染拿到的是空人格，
   * 测试会以"页面没有内容"的形式失败，看起来像前端 bug，其实是时序问题。 */
  assert.equal(imp.status, 202, `导入启动失败: ${JSON.stringify(impBody)}`);
  assert.ok(impBody.jobId, '导入应返回 jobId');
  let importDone = null;
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 60));
    const j = await get(`/api/jobs/${impBody.jobId}`);
    const st = j.body?.job?.status;
    if (st === 'done') { importDone = j.body.job; break; }
    assert.notEqual(st, 'failed', `导入失败: ${j.body?.job?.error}`);
  }
  assert.ok(importDone, '导入超时未完成');
  assert.ok((importDone.result?.added || 0) >= 2, '导入应该写入至少两条消息');

  const an = await post(`/api/personas/${personaId}/analyze`);
  assert.equal(an.status, 202, `分析启动失败: ${JSON.stringify(an.body)}`);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 60));
    const j = await get(`/api/jobs/${an.body.jobId}`);
    if (j.body?.job?.status === 'done') break;
    assert.notEqual(j.body?.job?.status, 'failed', `分析失败: ${j.body?.job?.error}`);
  }
  const ready = await get(`/api/personas/${personaId}`);
  assert.equal(ready.body.persona.analysisStatus, 'ready', '分析未完成，后续页面会渲染空态');

  // 建一个会话并真聊一句，让 chatPage 有消息可渲染
  const chat = await post(`/api/personas/${personaId}/chats`, { title: '契约测试会话' });
  assert.equal(chat.status, 200, `建会话失败: ${JSON.stringify(chat.body)}`);
  const chatId = chat.body.chat.id;

  // 发送走的是流式端点 POST /api/personas/:personaId/chat（带 chatId），
  // 不是 REST 风格的 /api/chats/:id/messages —— 后者只支持 GET。
  const send = await globalThis.fetch(`/api/personas/${personaId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ message: '你最近还好吗', chatId }),
  });
  assert.equal(send.status, 200, `发消息失败: ${send.status}`);
  const sse = await send.text();
  assert.match(sse, /event: done|"done"/, '流式响应应包含 done 事件');
});

after(async () => {
  await app?.close();
  llmServer?.close();
  ttsServer?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ------------------------------------------------------------- 断言 */
const url = (p) => pathToFileURL(path.join(PUBLIC_DIR, p)).href;
let shell, pages, routes, core;

before(async () => {
  shell = await import(url('js/shell.js'));
  routes = await import(url('js/routes.js'));
  core = await import(url('js/core.js'));
  pages = {
    dashboard: await import(url('js/pages/dashboard.js')),
    persona: await import(url('js/pages/persona.js')),
    chat: await import(url('js/pages/chat.js')),
    settings: await import(url('js/pages/settings.js')),
    auth: await import(url('js/pages/auth.js')),
    landing: await import(url('js/pages/landing.js')),
  };
});

/** 模块级 HTTP 小工具：复用 before() 里装好的 cookie 会话。 */
async function postJson(p, body) {
  const r = await globalThis.fetch(p, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function fetchDelete(p) {
  const r = await globalThis.fetch(p, { method: 'DELETE' });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** 把 location 切到某个路径，然后跑一次真实的路由分发。 */
async function visit(pathname, search = '') {
  // 还原 app.js 里 boot() 的顺序：先拿会话，再分发；否则 /app 会把用户
  // 当成未登录重定向去登录页（那是对的行为，只是不该在这个测试里发生）。
  await shell.loadSession();
  await shell.loadPersonas();
  globalThis.location.pathname = pathname;
  globalThis.location.search = search;
  appRoot.replaceChildren();
  await routes.render();
  return textOf(appRoot);
}

test('路由分发会把页面节点真正挂载到 #app（登录后转圈的回归测试）', async () => {
  // 历史上 render() 丢弃了页面函数的返回值，导致 /app 永远停在 index.html
  // 的「正在加载…」占位符上——请求全都 200，界面却一动不动。
  // 只断言「页面函数返回了节点」抓不到这个问题，必须断言挂载结果。
  const text = await visit('/app');
  assert.ok(appRoot.childNodes.length > 0, '/app 应当把节点挂进 #app，而不是留在占位符上');
  assert.match(text, /工作台/, '/app 应渲染出工作台');
  assert.match(text, /林小满/, '工作台应带上真实人格数据');
  assert.doesNotMatch(text, /正在加载/, '不应还停留在加载占位符');
});

test('各 app 路由都会挂载出内容', async () => {
  for (const [p, re] of [
    ['/app/personas', /人格/],
    ['/app/personas/new', /创建人格/],
    ['/app/voice', /语音/],
    ['/app/settings/keys', /配置|密钥|API/],
  ]) {
    const text = await visit(p);
    assert.ok(appRoot.childNodes.length > 0, `${p} 没有把节点挂进 #app`);
    assert.match(text, re, `${p} 渲染内容不符合预期: "${text.slice(0, 60)}"`);
  }
});

test('人格详情与对话路由都能挂载', async () => {
  for (const p of [`/app/personas/${personaId}`, `/app/chat/${personaId}`]) {
    const text = await visit(p);
    assert.ok(appRoot.childNodes.length > 0, `${p} 没有把节点挂进 #app`);
    assert.ok(text.length > 20, `${p} 内容为空`);
  }
});

test('/app 下写错的路径要给出 404，而不是永远停在「正在加载」', async () => {
  // 曾经这里断言的是「未知 app 路由不渲染 404」，理由是
  // requireUser() 重定向时页面函数返回 undefined。
  // 但那条断言把两种完全不同的情况混成了一个：
  //   a) 已登录、路径写错   → 必须 404，否则页面永久停在加载占位符上（像卡死）
  //   b) 未登录、被踢去登录 → 不该 404
  // 只测 a) 能抓到的那个缺陷，就是「URL 打错一个字，页面永远转圈」。
  const text = await visit('/app/nope/nope/nope');
  assert.ok(appRoot.childNodes.length > 0, '未知 app 路径必须挂载出内容（404 页）');
  assert.match(text, /404/, '未知 app 路径应渲染 404');
  assert.doesNotMatch(text, /正在加载/, '不应停在加载占位符上');
});

test('未登录时 app 路由重定向到登录页，不覆盖成 404', async () => {
  // 这一条保护上面那条修复不会把「权限重定向」也一起变成 404。
  const saved = shell.state.user;
  shell.state.user = null;
  try {
    globalThis.location.pathname = '/app/settings/keys';
    globalThis.location.search = '';
    appRoot.replaceChildren();
    await routes.render();
    const text = textOf(appRoot);
    assert.doesNotMatch(text, /404/, '未登录被重定向时不应渲染 404');
  } finally {
    shell.state.user = saved;
  }
});

test('前端能读到真实会话', async () => {
  const user = await shell.loadSession();
  assert.ok(user, 'loadSession 应该返回用户');
  assert.equal(user.email, 'fe@example.com');
  const list = await shell.loadPersonas();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '林小满');
});

test('侧边栏 shell 能渲染出导航与人格入口', () => {
  const node = shell.shell({ active: 'dashboard', title: '工作台', content: 'x' });
  const text = textOf(node);
  assert.match(text, /EchoPersona/);
  assert.match(text, /工作台/);
  assert.match(text, /林小满/, '侧边栏应列出我的人格');
});

test('侧边栏与顶栏的图标都是 SVG，不是单字符', () => {
  // 回归测试。以前侧边栏用的是 ◈ ❋ ◐ ♪ ⚙ ⚿ ☺ ⌗ 这些字符：
  // Windows 上靠系统字体渲染又细又糊，♪ / ☺ 还常被当成 emoji 画成彩色方块，
  // 跟界面完全不是一套视觉语言。现在全部换成 SVG 描边图标。
  const node = shell.shell({ active: 'dashboard', title: '工作台', content: 'x' });

  const icons = collect(node, (el) => el.classList?.contains('ico'));
  assert.ok(icons.length >= 5, `侧边栏应至少有 5 个导航图标，实际 ${icons.length}`);

  const charIcons = [];
  for (const ico of icons) {
    const svg = collect(ico, (el) => el.tagName?.toLowerCase() === 'svg')[0];
    if (!svg) {
      charIcons.push(`「${textOf(ico)}」`);
      continue;
    }
    // SVG 必须真的在 SVG 命名空间里建出来，否则浏览器只会得到一个
    // HTMLUnknownElement，图形一个都不画。
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg', '图标 SVG 必须在 SVG 命名空间');
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
    assert.ok(
      collect(svg, (el) => el.tagName?.toLowerCase() === 'path'
        || el.tagName?.toLowerCase() === 'circle'
        || el.tagName?.toLowerCase() === 'rect').length > 0,
      'SVG 图标里应有实际图形',
    );
  }
  assert.deepEqual(charIcons, [], `这些图标还是字符，应换成 SVG：${charIcons.join('、')}`);

  // 顶栏的菜单按钮同理
  const menuBtn = collect(node, (el) => el.getAttribute?.('aria-label') === '菜单')[0];
  assert.ok(menuBtn, '应有菜单按钮');
  assert.ok(
    collect(menuBtn, (el) => el.tagName?.toLowerCase() === 'svg').length > 0,
    '菜单按钮应是 SVG 图标，不是「☰」字符',
  );
});

test('登录 / 注册 / 找回 页面可渲染', () => {
  // app.js 里传的是 URLSearchParams(location.search)，测试保持同一契约。
  // 这几个页面是自己 mount 到 #app 的（不返回节点），所以检查容器内容。
  const params = new URLSearchParams('');
  for (const [name, fn] of [['login', pages.auth.loginPage], ['register', pages.auth.registerPage],
    ['forgot', pages.auth.forgotPage], ['reset', pages.auth.resetPage],
    ['phoneLogin', pages.auth.phoneLoginPage]]) {
    appRoot.replaceChildren();
    fn(params);
    assert.ok(textOf(appRoot).length > 10, `${name}Page 渲染内容为空`);
  }
});

test('手机号登录页有国家码、号码、验证码三个输入', () => {
  appRoot.replaceChildren();
  pages.auth.phoneLoginPage(new URLSearchParams('next=/app'));
  const text = textOf(appRoot);
  assert.match(text, /验证码/, '应该有验证码相关文案');
  // 验证码按钮要在，且初始文案是「获取验证码」。
  // 注意不能用 el.textContent 判断：h() 传入的字符串变成了子文本节点，
  // 替身里的 textContent 字段本身不会聚合，必须用 textOf 递归取。
  const btns = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tagName === 'BUTTON' && /获取验证码/.test(textOf(n))) btns.push(n);
    for (const c of n.childNodes || []) walk(c);
  };
  walk(appRoot);
  assert.equal(btns.length, 1, '应有一个「获取验证码」按钮');
});

test('云登录未配置时登录页不画微信按钮', async () => {
  // 这是重要的产品行为：云服务没配置时，按钮根本不该出现，
  // 而不是画出来、点一下才报错。
  const prev = shell.state.config;
  shell.state.config = { ...prev, cloudAuthEnabled: false };
  appRoot.replaceChildren();
  pages.auth.loginPage(new URLSearchParams(''));
  const text = textOf(appRoot);
  assert.ok(!/微信扫码登录/.test(text), `未配置云服务时不应出现微信按钮，实际渲染: ${text.slice(0, 200)}`);
  assert.ok(!/手机号验证码登录/.test(text), '未配置云服务时不应出现手机号入口');
  shell.state.config = prev;
});

test('云登录已配置时登录页出现微信与手机号入口', async () => {
  const prev = shell.state.config;
  shell.state.config = { ...prev, cloudAuthEnabled: true };
  appRoot.replaceChildren();
  pages.auth.loginPage(new URLSearchParams('next=/app'));
  const text = textOf(appRoot);
  assert.match(text, /微信扫码登录/, '应出现微信登录按钮');
  assert.match(text, /手机号验证码登录/, '应出现手机号登录入口');
  // 手机号入口要带着 next 走，否则登录完丢目标页
  const links = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tagName === 'A' && n.attrs?.href) links.push(n.attrs.href);
    for (const c of n.childNodes || []) walk(c);
  };
  walk(appRoot);
  assert.ok(links.some((x) => x.startsWith('/phone-login') && /next=%2Fapp/.test(x)),
    `手机号入口应带 next，实际: ${links.join(', ')}`);
  shell.state.config = prev;
});

test('落地页可渲染', () => {
  appRoot.replaceChildren();
  pages.landing.landingPage();
  const text = textOf(appRoot);
  assert.ok(text.length > 20, `落地页渲染内容为空: "${text.slice(0, 60)}"`);
});

test('工作台页面用真实数据渲染', async () => {
  const text = textOf(await pages.dashboard.dashboardPage());
  assert.match(text, /林小满/, '工作台应显示已有的人格');
});

test('人格列表 / 新建页可渲染', async () => {
  assert.match(textOf(await pages.dashboard.personasPage()), /林小满/);
  assert.ok(textOf(await pages.dashboard.newPersonaPage()).length > 20);
});

test('人格详情五个标签页都能用真实数据渲染', async () => {
  // import 标签页历史上就是在这里翻车的：它读了接口并不返回的 senders 字段
  for (const tab of ['overview', 'import', 'analysis', 'memories', 'settings']) {
    const node = await pages.persona.personaDetailPage(personaId, tab);
    assert.ok(node, `详情页 ${tab} 无返回`);
    assert.ok(textOf(node).length > 10, `详情页 ${tab} 渲染内容为空`);
  }
});

test('导入标签页把真实导入记录渲染成可读文字（不出现 null / undefined）', async () => {
  // 用户报障：导入聊天记录后「没有反应，只显示 NULL」。
  // 根因是 /api/personas/:id 返回 snake_case、前端读 camelCase，字段全是 undefined。
  // 断言真实数字与文件名都出现在页面上，并且没有把 undefined/null 印出来。
  const text = await visit(`/app/personas/${personaId}/import`);
  assert.match(text, /已导入文件/, '应渲染「已导入文件」卡片');
  assert.match(text, /sample|chat/, '应显示导入的文件名');
  assert.match(text, /\d+\s*条/, '应显示真实的条数，而不是占位符');

  assert.doesNotMatch(text, /\bnull\b/, '页面不应出现字面量 null');
  assert.doesNotMatch(text, /\bundefined\b/, '页面不应出现字面量 undefined');
  assert.doesNotMatch(text, /NaN/, '页面不应出现 NaN');
});

test('空人格的导入标签页也不会印出字面量 null', async () => {
  // 用户报障的第二现场：新建人格、还没导入任何东西时，导入页上孤零零挂着
  // 三个 "null"。根因同上——renderImportTab 里 `wrap.append(senderCard,
  // importRows, ...)` 用的是 DOM 原生 append()，它会把 null 当文本节点插进去；
  // 而 h() 是会跳过 null 的。没有发送者、没有导入记录、没有危险操作卡片，
  // 恰好三个 null，正好是页面上看到的那三个。
  const r = await postJson('/api/personas', { name: '空人格_null_check' });
  assert.equal(r.status, 200, `建空人格失败: ${JSON.stringify(r.body)}`);
  const emptyId = r.body?.persona?.id;
  assert.ok(emptyId, `创建人格应返回 persona.id，实际拿到: ${JSON.stringify(r.body)}`);

  for (const tab of ['import', 'analysis']) {
    const text = await visit(`/app/personas/${emptyId}/${tab}`);
    assert.doesNotMatch(text, /\bnull\b/, `${tab} 标签页不应出现字面量 null；实际文本: ${text.slice(0, 600)}`);
    assert.doesNotMatch(text, /\bundefined\b/, `${tab} 标签页不应出现字面量 undefined`);
    assert.doesNotMatch(text, /NaN/, `${tab} 标签页不应出现 NaN`);
  }

  await fetchDelete(`/api/personas/${emptyId}`);
});

test('对话页用真实会话历史渲染', async () => {  const node = await pages.chat.chatPage(personaId);
  const text = textOf(node);
  assert.ok(text.length > 10);
  assert.match(text, /你最近还好吗|林小满/, '对话页应显示历史消息或人格名');
});

test('对话页顶栏只剩两档回复形态（文字 / 语音），随机已删除', async () => {
  // 用户要的不是「文字转语音」开关，而是「TA 这次是打字还是发语音」的选择。
  // 「随机」这一档按历史语音占比掷骰子，实测几乎总是落回文字 ——
  // 用户选了它却永远收到文字，只会认为开关坏了。所以它必须不存在，
  // 而且不能只是按钮被藏起来：文案里也不该再出现，否则用户会去找它。
  const node = await pages.chat.chatPage(personaId);
  const text = textOf(node);
  for (const label of ['文字', '语音']) {
    assert.ok(text.includes(label), `顶栏缺少「${label}」选项；实际文本: ${text.slice(0, 400)}`);
  }
  assert.ok(!text.includes('随机'), `「随机」档应已删除；实际文本: ${text.slice(0, 400)}`);
});

test('有音频的消息渲染成微信式语音气泡，而不是文字气泡', async () => {
  // 造一条带 audioUrl 的历史消息：前端必须把它画成 .msg-bubble.is-voice
  // （喇叭 + 时长那种），文字内容只在「转文字」里出现。
  const chatId = await postJson(`/api/personas/${personaId}/chats`, { title: 'voice-bubble' })
    .then((r) => r.body?.chat?.id);
  assert.ok(chatId, '建会话失败');

  // 直接往库里插一条 assistant 消息 + 一条 ready 的 tts_audio，
  // 这样 /api/chats/:id/messages 就会带上 audioUrl。
  const { run, get } = await import('../src/db/index.js');
  const ownerId = get('SELECT user_id FROM personas WHERE id = ?', [personaId])?.user_id;
  assert.ok(ownerId, '拿不到 persona 的 user_id');
  const msgId = `msg_test_voiced_${Date.now()}`;
  const audioId = `aud_test_voiced_${Date.now()}`;
  const now = Date.now();
  run(`INSERT INTO messages (id,user_id,persona_id,chat_id,role,sender_raw,content,msg_type,ts,seq,is_imported,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    [msgId, ownerId, personaId, chatId, 'persona', '林小满',
      '嗯 那你早点回来 给你留了饭', 'text', now, 1, now]);
  run(`INSERT INTO tts_audio (id,user_id,persona_id,message_id,tts_config_id,voice_ref_id,text_hash,text,status,mime,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [audioId, ownerId, personaId, msgId, null, null, `h${now}`, '嗯', 'ready', 'audio/wav', now]);

  const node = await pages.chat.chatPage(personaId, chatId);
  // 找到那条消息对应的行，检查气泡类名
  const rows = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.dataset?.id === msgId) rows.push(n);
    for (const c of n.childNodes || []) walk(c);
  })(node);
  assert.ok(rows.length > 0, '找不到刚插入的消息行');

  const bubbles = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (String(n.className || '').includes('is-voice')) bubbles.push(n);
    for (const c of n.childNodes || []) walk(c);
  })(rows[0]);
  assert.ok(bubbles.length > 0, '语音消息应渲染成 .msg-bubble.is-voice 气泡');

  // 语音气泡里应该有喇叭图标（SVG 命名空间建出来的 path）
  const svgPaths = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.tagName === 'PATH') svgPaths.push(n);
    for (const c of n.childNodes || []) walk(c);
  })(bubbles[0]);
  assert.ok(svgPaths.length >= 2, `语音气泡里应有喇叭图标，实际 path 数: ${svgPaths.length}`);

  // 气泡上不该直接铺文字内容 —— 那是「转文字」才显示的
  assert.ok(!textOf(bubbles[0]).includes('给你留了饭'), '语音气泡本体不应直接显示文字内容');
});

test('设置页（API 配置 / 账户 / 语音 / 管理后台）可渲染', async () => {
  for (const [name, fn] of [
    ['keys', () => pages.settings.settingsPage('keys')],
    ['account', () => pages.settings.settingsPage('account')],
    ['voice', () => pages.settings.voicePage()],
    ['admin', () => pages.settings.adminPage()],
  ]) {
    const text = textOf(await fn());
    assert.ok(text.length > 10, `设置页 ${name} 渲染内容为空`);
  }
});

test('设置页能展示已保存的 LLM / TTS 配置', async () => {
  const text = textOf(await pages.settings.settingsPage('keys'));
  assert.match(text, /测试 LLM/, '应显示已保存的 LLM 配置名');
});

test('账户页展示登录方式，且不会把占位邮箱当真实邮箱印出来', async () => {
  const text = textOf(await pages.settings.settingsPage('account'));
  assert.match(text, /登录方式/, '应有「登录方式」卡片');
  // 邮箱账号没有绑定第三方身份时，要给一句说明而不是空白
  assert.match(text, /邮箱|微信|手机号/, '应列出可用的登录方式');
});

test('没有密码的账号看到「设置密码」而不是「修改密码」', async () => {
  // 微信/手机号登录建的账号没有密码。若仍显示「当前密码」那一格，
  // 用户永远填不对，页面看起来像坏了。
  const prev = shell.state.user;
  shell.state.user = { ...prev, hasPassword: false, placeholderEmail: true };
  const text = textOf(await pages.settings.settingsPage('account'));
  assert.match(text, /设置密码/, '无密码账号应看到「设置密码」');
  assert.ok(!/当前密码/.test(text), `无密码账号不该出现「当前密码」输入，实际: ${text.slice(0, 300)}`);
  assert.match(text, /微信\/手机号登录/, '应说明为什么没有密码');
  shell.state.user = prev;
});

test('有密码的账号仍然看到「修改密码」和当前密码输入', async () => {
  const prev = shell.state.user;
  shell.state.user = { ...prev, hasPassword: true, placeholderEmail: false };
  const text = textOf(await pages.settings.settingsPage('account'));
  assert.match(text, /修改密码/);
  assert.match(text, /当前密码/, '改密码必须验旧密码，这一格不能少');
  shell.state.user = prev;
});

test('不存在的资源 ID 不会把页面炸掉', async () => {
  // 前端必须优雅降级 —— 用户刷新一个已被删除的人格时不该看到白屏
  const node = await pages.persona.personaDetailPage('pid_does_not_exist', 'overview');
  assert.ok(node, '无效 ID 仍应返回可渲染的节点');
});

/* ---------------------------------------------------- 真实请求行为 */

test('api.post 不带 body 时不能发送 content-type: application/json', async () => {
  // 这条测试守的是一个真实出现过的 bug：
  // api.post() 曾经无条件带 content-type: application/json，
  // 而 Fastify 见到这个头就按 JSON 解析，空 body 直接 400
  // FST_ERR_CTP_EMPTY_JSON_BODY。
  // 表现是「运行人格分析」一点就报「请求错误」，而后端单测全绿 ——
  // 因为测试里的 postJson() 在无 body 时本来就没设这个头，比真实代码更宽松。
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    captured = { headers: { ...(init.headers || {}) }, body: init.body, method: init.method };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await core.api.post('/api/personas/whatever/analyze');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body, undefined, '无 body 时不应有 body');
  const ct = Object.entries(captured.headers)
    .find(([k]) => k.toLowerCase() === 'content-type');
  assert.equal(ct, undefined,
    '无 body 的 POST 不能带 content-type，否则 Fastify 会 400 空 JSON');
});

test('api.post 带 body 时仍然正确发送 JSON', async () => {
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    captured = { headers: { ...(init.headers || {}) }, body: init.body };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await core.api.post('/api/x', { a: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
  const ct = Object.entries(captured.headers)
    .find(([k]) => k.toLowerCase() === 'content-type');
  assert.ok(ct, '有 body 时必须带 content-type');
  assert.match(ct[1], /application\/json/);
  assert.equal(captured.body, JSON.stringify({ a: 1 }));
});

test('无 body 的 POST 接口在真实服务器上不会被 400 拒绝', async () => {
  // 端到端确认：用真实的 fetch 语义打一次 /analyze，不应再是
  // FST_ERR_CTP_EMPTY_JSON_BODY。用 204 也不合适（那是没内容），
  // 这里只断言不是「空 JSON body」这个特定错误。
  const r = await globalThis.fetch(`/api/personas/${personaId}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  const body = await r.json().catch(() => ({}));
  // 这条断言是反向的：证明服务端确实会拒绝这种请求，
  // 从而说明前端不带这个头是必须的，而不是可有可无的洁癖。
  assert.equal(r.status, 400, '服务端确实会拒绝「有 json 头但空 body」');
  assert.equal(body.code, 'FST_ERR_CTP_EMPTY_JSON_BODY');
});
