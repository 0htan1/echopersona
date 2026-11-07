/* 线上版「3MB 卡死」回归验证。
 *
 * 用户报的问题是**线上**上传 3MB 聊天记录后整站 504、别的设备也打不开。
 * 本地 verify-large-import.mjs 只能证明本机不阻塞，证明不了线上 ——
 * 线上还有反向代理、网关超时、沙箱资源限制这些本地没有的层。
 *
 * 所以这个脚本直接打线上地址，量的还是同一件事：
 * 上传 3MB 的同时持续请求 /api/health，看服务器在导入期间是否还活着。
 *
 * 用法：node scripts/verify-online-large-import.mjs "<url?sharecode=...>" [MB]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const RAW = process.argv[2];
const MB = Number(process.argv[3] || 3);
if (!RAW) { console.error('用法: node scripts/verify-online-large-import.mjs "<url?sharecode=...>" [MB]'); process.exit(1); }

const ORIGIN = new URL(RAW).origin;

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? `  (${d})` : ''}`); };

/* ---------------------------------------------------------------- 门禁 */
/* 直接 goto /api/health 会 403「链接不完整」。必须先带 sharecode 拿 cookie，
 * 之后所有请求都复用这个 cookie，行为和真实浏览器一致。 */
async function passGate() {
  const r = await fetch(RAW, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const raw = r.headers.getSetCookie?.() || [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`门禁没下发 cookie（status=${r.status}）`);
  return cookie;
}

/* ---------------------------------------------------------------- 样本 */
function makeSample(targetBytes) {
  const senders = ['线上阿岸', '线上小满', '线上阿岸', '线上老周'];
  const bodies = ['嗯', '行吧', '我在路上了', '今天好热啊', '你说这个我想起来了', '晚点再说',
    '哈哈哈哈哈', '真的假的', '那你自己看着办', '我先睡了，明天早起',
    '这个我记一下', '你吃了吗', '算了不折腾了', '你看那个新闻了吗',
    '我刚到家', '明天见', '有点困了', '咋了'];
  const out = [];
  let bytes = 0; let m = 0; let h = 8; let day = 1;
  while (bytes < targetBytes) {
    if (++m >= 60) { m = 0; if (++h >= 24) { h = 0; day = day >= 28 ? 1 : day + 1; } }
    const chunk = `2023-03-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00 ${senders[m % senders.length]}\n${bodies[(m + day) % bodies.length]}\n`;
    out.push(chunk); bytes += Buffer.byteLength(chunk);
  }
  return out.join('');
}

const sample = makeSample(MB * 1024 * 1024);
console.log(`\n线上压测 ${ORIGIN}  样本 ${(Buffer.byteLength(sample) / 1024 / 1024).toFixed(2)} MB\n`);

let cookie = '';
try {
  cookie = await passGate();
  ok('通过访问码门禁', cookie.split('=')[0]);
} catch (e) {
  bad('通过访问码门禁', e.message);
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(1);
}

const H = { cookie };

/* ---------------------------------------------------------------- 基线 */
{
  const t = Date.now();
  const r = await fetch(`${ORIGIN}/api/health`, { headers: H, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (r.ok && j.ok) ok('线上 health 正常', `${Date.now() - t}ms`);
  else bad('线上 health 正常', `status=${r.status}`);
}

/* ---------------------------------------------------------------- 账号 */
/* 线上注册有限流（8 次/15 分钟），脚本只注册一次。邮箱带随机串避免撞库。 */
const email = `big${Date.now()}${crypto.randomInt(100, 999)}@example.com`;
let reg;
try {
  reg = await fetch(`${ORIGIN}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ email, password: 'Passw0rd123', displayName: '线上压测', consent: true }),
    signal: AbortSignal.timeout(30000),
  });
} catch (e) {
  bad('线上注册账号', e.message);
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(1);
}
if (!reg.ok) {
  bad('线上注册账号', `status=${reg.status} ${(await reg.text()).slice(0, 200)}`);
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(1);
}
/* 注意：这里是**字符串**拼接。早先写成 [...H.cookie, ...] —— 字符串会被展开成
 * 单个字符，拼出来的 cookie 变成 "__; _; w; b; ..."，服务端拿不到会话，
 * 后续每个请求都 403，看起来像"线上权限坏了"。 */
const regCookie = [
  H.cookie,
  ...(reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]),
].filter(Boolean).join('; ');
ok('线上注册账号');

/* ---------------------------------------------------------------- 人格 */
const per = await fetch(`${ORIGIN}/api/personas`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: regCookie },
  body: JSON.stringify({ name: '线上阿岸', relationship: '朋友' }),
  signal: AbortSignal.timeout(30000),
});
if (!per.ok) {
  bad('线上创建人格', `status=${per.status} ${(await per.text()).slice(0, 200)}`);
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(1);
}
const personaId = (await per.json()).persona.id;
ok('线上创建人格');

/* ---------------------------------------------------------------- 持续探活 */
/* 这是整个脚本的核心。探针必须在**上传之前**启动，
 * 覆盖上传 + 后台处理的完整窗口，否则测不到阻塞区间。 */
const probes = [];
let probing = true;
const probeLoop = (async () => {
  while (probing) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${ORIGIN}/api/health`, { headers: H, signal: AbortSignal.timeout(30000) });
      probes.push({ ms: Date.now() - t0, ok: r.ok, code: r.status });
    } catch (e) {
      probes.push({ ms: Date.now() - t0, ok: false, code: e.name || 'ERR' });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
})();

/* ---------------------------------------------------------------- 上传 3MB */
const boundary = '----onlinebig';
const body = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="personaSender"\r\n\r\n线上阿岸\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`),
  Buffer.from(sample),
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);

const tUpload = Date.now();
let up; let upBody = {};
try {
  up = await fetch(`${ORIGIN}/api/personas/${personaId}/imports`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: regCookie },
    body,
    signal: AbortSignal.timeout(180000),
  });
  upBody = await up.json().catch(() => ({}));
} catch (e) {
  bad('线上上传 3MB 立刻返回', `${e.name}: ${e.message}`);
}
const upMs = Date.now() - tUpload;

if (up?.status === 202 && upBody.jobId) {
  ok('线上上传立刻返回 202 + jobId（不是处理完才响应）', `${upMs}ms`);
} else if (up) {
  bad('线上上传立刻返回 202 + jobId', `status=${up.status} ${JSON.stringify(upBody).slice(0, 200)}`);
}

/* 504 的典型表现就是这里超时或返回网关错误页 */
if (upMs < 20000) ok('首字节响应没有撞网关超时', `${(upMs / 1000).toFixed(1)}s`);
else bad('首字节响应没有撞网关超时', `${(upMs / 1000).toFixed(1)}s`);

/* ---------------------------------------------------------------- 等 job */
let job = null;
if (upBody.jobId) {
  const tJob = Date.now();
  for (let i = 0; i < 3600; i++) {
    try {
      const r = await fetch(`${ORIGIN}/api/jobs/${upBody.jobId}`, { headers: { cookie: regCookie }, signal: AbortSignal.timeout(30000) });
      const j = (await r.json()).job;
      if (j?.status === 'done') { job = j; break; }
      if (j?.status === 'failed') throw new Error(j.error);
    } catch (e) {
      // 轮询本身失败不算致命，继续等（网络抖动）
      if (String(e.message || '').includes('failed')) throw e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const jobMs = Date.now() - tJob;
  if (job) ok('线上导入 job 完成', `${(jobMs / 1000).toFixed(1)}s, 新增 ${job.result?.added}`);
  else bad('线上导入 job 完成', '超时（可能被服务器终止）');
}

probing = false;
await probeLoop;

/* ---------------------------------------------------------------- 核心断言 */
const total = probes.length;
const fails = probes.filter((p) => !p.ok);
const slow = probes.filter((p) => p.ms > 3000);
const maxMs = Math.max(...probes.map((p) => p.ms), 0);
const avgMs = Math.round(probes.reduce((a, p) => a + p.ms, 0) / Math.max(total, 1));

console.log('');
if (fails.length === 0) ok('导入期间线上 health 零失败', `${total} 次请求`);
else bad('导入期间线上 health 零失败', `${fails.length}/${total} 次失败（这就是 504 的来源） codes=${[...new Set(fails.map((f) => f.code))].join(',')}`);

if (slow.length === 0) ok('没有任何请求被拖到 3 秒以上', `最慢 ${maxMs}ms，平均 ${avgMs}ms`);
else bad('没有任何请求被拖到 3 秒以上', `${slow.length} 次超过 3 秒，最慢 ${maxMs}ms`);

if (maxMs < 5000) ok('线上最慢响应在 5 秒内', `${maxMs}ms`);
else bad('线上最慢响应在 5 秒内', `${maxMs}ms`);

/* ---------------------------------------------------------------- 数据完整性 */
if (job) {
  const st = await fetch(`${ORIGIN}/api/personas/${personaId}/style-stats`, { headers: { cookie: regCookie } });
  const stats = await st.json();
  if (stats.sampleCount > 1000) ok('消息真实落库', `${stats.sampleCount} 条人格语句`);
  else bad('消息真实落库', `只有 ${stats.sampleCount} 条`);

  const sd = await fetch(`${ORIGIN}/api/personas/${personaId}/senders`, { headers: { cookie: regCookie } });
  const sj = await sd.json();
  const ps = (sj.senders || []).find((s) => s.role === 'persona');
  if (ps) ok('发送者角色判定正确', `${ps.name} · ${ps.count} 条`);
  else bad('发送者角色判定正确', JSON.stringify(sj).slice(0, 200));
}

/* ---------------------------------------------------------------- 收尾：确认服务仍可用 */
{
  const r = await fetch(`${ORIGIN}/api/health`, { headers: H, signal: AbortSignal.timeout(20000) });
  if (r.ok) ok('压测结束后线上仍正常（其他设备可访问）');
  else bad('压测结束后线上仍正常', `status=${r.status}`);
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
console.log(`(测试账号: ${email}；样本临时文件未落盘)`);
process.exit(fail === 0 ? 0 : 1);
