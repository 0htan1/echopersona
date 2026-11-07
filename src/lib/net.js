import dns from 'node:dns';
import net from 'node:net';
import crypto from 'node:crypto';
import { Agent, ProxyAgent, request as undiciRequest } from 'undici';
import { config } from '../config.js';

const { promises: dnsP } = dns;

/**
 * 出站代理。很多环境（企业网络、代理客户端、部分容器）只允许通过
 * HTTP(S)_PROXY 出网；此时若继续直连固定 IP，就会一路 ConnectTimeout，
 * 而同一台机器上的 curl 却是通的 —— 因为 curl 会读代理环境变量。
 * 这正是本项目「TTS 连接失败」的真正原因之一。
 *
 * 注意 SSRF：走代理时本机不再解析目标 DNS，DNS 固定（anti-rebinding）失效。
 * 所以 validateUpstreamUrl 里的私网/保留地址黑名单仍然生效 ——
 * 恶意域名解析到内网会被拒，只是无法再防「先解析到公网、连接时再改答案」
 * 这类 rebinding。这是接入代理必然的取舍，已在文档中注明。
 */
function proxyUrl() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const v = String(raw).trim();
  if (!v) return '';
  // 必须带协议，否则 ProxyAgent 会把 "127.0.0.1:51106" 当成非法 URL
  return /^[a-z0-9+.-]+:\/\//i.test(v) ? v : `http://${v}`;
}

const NO_PROXY = (() => {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
})();

function bypassProxy(host) {
  const h = String(host).toLowerCase();
  return NO_PROXY.some((p) => (p.startsWith('.') ? h.endsWith(p) || h === p.slice(1) : h === p));
}

const proxyAgentCache = new Map();
function agentForProxy(url) {
  const key = url;
  if (!proxyAgentCache.has(key)) proxyAgentCache.set(key, new ProxyAgent({ uri: url, connectTimeout: 20000 }));
  return proxyAgentCache.get(key);
}

export class SsrfError extends Error {
  constructor(msg) { super(msg); this.name = 'SsrfError'; this.statusCode = 400; }
}

/** Is this IP literal in a private / reserved / link-local range? */
export function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;           // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
    if (p[0] >= 224) return true;                            // multicast + reserved
    return false;
  }
  if (kind === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80')) return true;                 // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
    if (low.startsWith('::ffff:')) {                         // v4-mapped
      const v4 = low.slice(7);
      if (net.isIP(v4) === 4) return isPrivateIp(v4);
    }
    if (low.startsWith('ff')) return true;                   // multicast
    return false;
  }
  return true; // not an IP -> treat as unsafe
}

/**
 * Validate + resolve a user-supplied upstream base URL.
 * Returns { url: URL, addresses: [{address, family}] } with the resolved, vetted IPs.
 */
export async function validateUpstreamUrl(rawUrl, { allowPrivate = config.ssrfAllowPrivate } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new SsrfError('URL 格式不合法，请填写完整地址（含 http:// 或 https://）');
  }
  if (!/^https?:$/.test(url.protocol)) throw new SsrfError('仅支持 http / https 协议');
  if (url.username || url.password) throw new SsrfError('URL 中不允许携带用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new SsrfError('URL 缺少主机名');
  if (['localhost', 'localhost.localdomain', 'metadata.google.internal'].includes(host)) {
    throw new SsrfError('不允许访问本机或云元数据地址');
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new SsrfError('不允许访问内部域名');
  }

  // IP literal
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateIp(host)) throw new SsrfError('不允许访问内网或保留地址');
    return { url, addresses: [{ address: host, family: net.isIP(host) }] };
  }

  let records;
  try {
    records = await dnsP.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`域名解析失败：${host}`);
  }
  if (!records.length) throw new SsrfError(`域名无解析结果：${host}`);
  const bad = records.filter((r) => !allowPrivate && isPrivateIp(r.address));
  if (bad.length) throw new SsrfError(`域名解析到内网地址，已拒绝（${bad.map((b) => b.address).join(', ')}）`);

  // IPv4 优先。dns.lookup({verbatim:true}) 会把 AAAA 排在 A 前面，
  // 而很多机器（含本项目的开发机、以及不少只有 v4 出口的容器）根本没有 IPv6
  // 路由 —— 于是固定成 AAAA 之后必然 ConnectTimeout，表现为「接口连接失败」，
  // 而同一台机器上 curl 却是通的（它做了 Happy Eyeballs 回退）。
  // SSRF 校验在上面对全部记录做完了，这里只是换一个同样经过校验的地址，
  // 不削弱任何安全性。
  records.sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1));

  return { url, addresses: records };
}

/** Build an undici Agent that pins DNS to a vetted IP list (defeats DNS rebinding). */
function pinnedAgent(pinnedList) {
  const list = Array.isArray(pinnedList) ? pinnedList : [pinnedList];
  let turn = 0;
  return new Agent({
    connect: {
      timeout: 15000,
      // 按顺序轮换候选地址：首选地址不可达时，undici 会在同一次请求里
      // 用下一个候选重连，而不是直接把 ConnectTimeout 抛给用户。
      lookup(_hostname, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        const pick = list[turn++ % list.length];
        if (options && options.all) return cb(null, list);
        return cb(null, pick.address, pick.family);
      },
    },
  });
}

/**
 * SSRF-safe request. Follows redirects manually, re-validating every hop.
 * Body may be a string/Buffer (sent as-is) or a factory returning a BodyInit.
 */
export async function safeRequest(rawUrl, {
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = config.upstreamTimeoutMs,
  maxRedirects = 3,
  maxResponseBytes = 32 * 1024 * 1024,
  allowPrivate = config.ssrfAllowPrivate,
  signal,
} = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, addresses } = await validateUpstreamUrl(current, { allowPrivate });
    // 把全部已校验地址交给 agent，由它按序回退（IPv4 已排在最前）
    const pinned = addresses;

    // 传输通道优先级：
    //   1. 配了 HTTP(S)_PROXY 且目标不在 NO_PROXY 里 -> 走代理
    //   2. 否则直连（DNS 固定到已校验 IP，防 rebinding）
    // 代理失败时不死磕，回落到直连再试一次；直连失败且配了代理，再回落到代理。
    // 两条路都失败才把错误抛给用户 —— 单条链路抖动不该表现为「连接失败」。
    const proxy = proxyUrl();
    const useProxy = Boolean(proxy) && !bypassProxy(url.hostname);
    const dispatchers = [];
    if (useProxy) dispatchers.push({ name: 'proxy', d: agentForProxy(proxy) });
    dispatchers.push({ name: 'direct', d: pinnedAgent(pinned) });
    if (proxy && !useProxy) dispatchers.push({ name: 'proxy', d: agentForProxy(proxy) });

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('upstream timeout')), timeoutMs);
    const onAbort = () => ac.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let res;
      let lastErr;
      for (let i = 0; i < dispatchers.length; i++) {
        try {
          res = await undiciRequest(url, {
            method,
            headers,
            body: typeof body === 'function' ? body() : body,
            dispatcher: dispatchers[i].d,
            signal: ac.signal,
            maxRedirections: 0,
          });
          break;
        } catch (e) {
          lastErr = e;
          // 业务层的 HTTP 错误不会抛到这里（undici 只在传输层失败时抛）；
          // 用户主动中止时不要再换通道重试。
          if (ac.signal.aborted) throw e;
          if (i === dispatchers.length - 1) throw e;
        }
      }
      if (!res) throw lastErr || new Error('上游无响应');

      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        await res.body.dump().catch(() => {});
        if (!loc) throw new Error(`上游返回 ${res.statusCode} 但没有 Location`);
        current = new URL(loc, url).toString();
        if (res.statusCode === 303) { method = 'GET'; body = undefined; }
        continue;
      }
      return { res, url, finalUrl: url.toString() };
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error('上游重定向次数过多');
}

/** Read a response body with a hard byte cap. */
export async function readBody(res, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      res.body.destroy?.();
      throw new Error(`响应体超过限制（>${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function safeJson(rawUrl, opts = {}) {
  const { res, finalUrl } = await safeRequest(rawUrl, opts);
  const buf = await readBody(res, opts.maxResponseBytes);
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.statusCode, headers: res.headers, json, text, finalUrl };
}

/**
 * Build a multipart/form-data body without FormData/undici's fetch layer.
 * undici.request() cannot consume a WHATWG FormData object directly.
 * fields: [{ name, value }] | { name: value }
 * files:  [{ name, filename, mime, buffer }]
 * Returns { body: Buffer, contentType }.
 */
export function buildMultipart(fields = {}, files = []) {
  const boundary = '----EPForm' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  const entries = Array.isArray(fields)
    ? fields
    : Object.entries(fields).filter(([, v]) => v !== undefined && v !== null);

  for (const [name, value] of entries) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(name)}"\r\n\r\n`,
      'utf8'
    ));
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }

  for (const f of files) {
    const mime = f.mime || 'application/octet-stream';
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(f.name)}"; ` +
      `filename="${escapeQuoted(f.filename || 'file.bin')}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
      'utf8'
    ));
    parts.push(Buffer.isBuffer(f.buffer) ? f.buffer : Buffer.from(f.buffer));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeQuoted(s) {
  return String(s).replace(/[\r\n"]/g, '_');
}
