#!/usr/bin/env node
/**
 * 部署后冒烟检查：不依赖任何外部 API Key，只验证站点本身可用。
 * 用法： npm run smoke [baseUrl]
 *   - 默认读取 PUBLIC_URL，否则 http://127.0.0.1:$PORT
 *   - 退出码 0 = 全通过，1 = 有失败项
 */
const base = (process.argv[2] || process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 8080}`)
  .replace(/\/+$/, '');

const checks = [];
const pass = (name, detail = '') => checks.push({ ok: true, name, detail });
const fail = (name, detail = '') => checks.push({ ok: false, name, detail });

async function get(path, opts = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeout || 10000),
      headers: opts.headers || {},
    });
  } catch (e) {
    // undici 的 fetch 把真正原因藏在 cause 里，摊平后更好排障
    const cause = e.cause?.code || e.cause?.message || '';
    throw new Error(`${e.message}${cause ? ` (${cause})` : ''}`);
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function main() {
  console.log(`[smoke] 目标：${base}\n`);

  // 1. 健康检查
  try {
    const r = await get('/api/health');
    if (r.status !== 200) fail('健康检查', `HTTP ${r.status}`);
    else {
      const j = JSON.parse(r.text);
      if (j.ok && j.db) pass('健康检查', `uptime ${j.uptime}s, env ${j.env}`);
      else fail('健康检查', `ok=${j.ok} db=${j.db}`);
    }
  } catch (e) { fail('健康检查', e.message); }

  // 2. 首页可访问
  try {
    const r = await get('/');
    if (r.status === 200 && r.text.includes('id="app"')) pass('首页渲染');
    else fail('首页渲染', `HTTP ${r.status}`);
  } catch (e) { fail('首页渲染', e.message); }

  // 3. SPA 深链接回退
  try {
    const r = await get('/app/personas');
    if (r.status === 200 && r.text.includes('id="app"')) pass('SPA 深链接回退');
    else fail('SPA 深链接回退', `HTTP ${r.status}`);
  } catch (e) { fail('SPA 深链接回退', e.message); }

  // 4. 未登录访问受保护接口应 401
  try {
    const r = await get('/api/personas');
    if (r.status === 401) pass('未登录拦截返回 401');
    else fail('未登录拦截返回 401', `HTTP ${r.status}（期望 401）`);
  } catch (e) { fail('未登录拦截返回 401', e.message); }

  // 5. 未知 API 返回 JSON 404 而不是 HTML
  try {
    const r = await get('/api/__smoke_not_found__');
    if (r.status === 404 && r.text.trim().startsWith('{')) pass('未知 API 返回 JSON 404');
    else fail('未知 API 返回 JSON 404', `HTTP ${r.status}`);
  } catch (e) { fail('未知 API 返回 JSON 404', e.message); }

  // 6. 安全响应头
  try {
    const r = await get('/');
    const need = ['x-content-type-options', 'content-security-policy', 'referrer-policy'];
    const missing = need.filter((h) => !r.headers.get(h));
    if (!missing.length) pass('安全响应头齐备');
    else fail('安全响应头齐备', `缺少 ${missing.join(', ')}`);
  } catch (e) { fail('安全响应头齐备', e.message); }

  // 7. HTTPS 检查（公网地址才检查）
  if (base.startsWith('https://')) {
    try {
      const r = await get('/');
      if (r.headers.get('strict-transport-security')) pass('HSTS 已启用');
      else fail('HSTS 已启用', 'NODE_ENV 可能不是 production');
    } catch (e) { fail('HSTS 已启用', e.message); }
  } else {
    pass('HTTPS 检查', '目标为 http，已跳过（本地验证正常）');
  }

  // 8. 会话接口可达
  try {
    const r = await get('/api/auth/session');
    const j = JSON.parse(r.text);
    if (r.status === 200 && j.authenticated === false) pass('会话接口正常');
    else fail('会话接口正常', `HTTP ${r.status}`);
  } catch (e) { fail('会话接口正常', e.message); }

  // report
  const bad = checks.filter((c) => !c.ok);
  console.log('');
  for (const c of checks) {
    console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  console.log('');
  if (bad.length) {
    console.log(`[smoke] ${checks.length - bad.length} 通过 / ${bad.length} 失败`);
    process.exit(1);
  }
  console.log(`[smoke] 全部 ${checks.length} 项通过`);
  if (!base.startsWith('https://')) {
    console.log('[smoke] 提示：本地 http 通过，上线后请再用 https 域名跑一次。');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[smoke] 执行异常：', e);
  process.exit(1);
});
