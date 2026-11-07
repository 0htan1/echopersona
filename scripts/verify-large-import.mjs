/**
 * 线上卡死场景的回归验证。
 *
 * 复现条件：上传 3MB 聊天记录，**同时**不断请求 /api/health。
 *
 * 改造前：写库全程同步，event loop 被独占十几秒，health 请求一直排队 ——
 * 网关等不到响应就报 504，别的设备也打不开页面。
 *
 * 改造后：health 应该全程保持毫秒级响应，即便导入还在跑。
 * 这个脚本就是量的这件事：不是"导入变快了"，而是"导入期间服务器还活着"。
 *
 * 用法：node scripts/verify-large-import.mjs [MB]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MB = Number(process.argv[2] || 3);
const PORT = 3971;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), `ep-big-${Date.now()}`);

let pass = 0; let fail = 0;
const ok = (name, extra = '') => { pass++; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); };
const bad = (name, extra = '') => { fail++; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ''}`); };

/* ---------------------------------------------------------------- 样本 */
function makeSample(targetBytes) {
  const senders = ['阿岸', '林小满', '阿岸', '老周'];
  const bodies = ['嗯', '行吧', '我在路上了', '今天好热啊', '你说这个我想起来了', '晚点再说',
    '哈哈哈哈哈', '真的假的', '那你自己看着办', '我先睡了，明天早起',
    '这个我记一下', '你吃了吗', '算了不折腾了', '你看那个新闻了吗',
    '我刚到家', '明天见', '有点困了', '咋了'];
  const out = [];
  let bytes = 0; let day = 1; let h = 8; let m = 0;
  while (bytes < targetBytes) {
    if (++m >= 60) { m = 0; if (++h >= 24) { h = 0; day = day >= 28 ? 1 : day + 1; } }
    const d = String(day).padStart(2, '0');
    const ts = `2023-03-${d} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    const chunk = `${ts} ${senders[m % senders.length]}\n${bodies[(m + day) % bodies.length]}\n`;
    out.push(chunk); bytes += Buffer.byteLength(chunk);
  }
  return out.join('');
}

const samplePath = path.join(os.tmpdir(), `ep-big-${Date.now()}.txt`);
fs.writeFileSync(samplePath, makeSample(MB * 1024 * 1024));
const sizeMb = (fs.statSync(samplePath).size / 1024 / 1024).toFixed(2);
console.log(`\n样本 ${sizeMb} MB：${samplePath}\n`);

/* ---------------------------------------------------------------- 启动服务 */
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  DATA_DIR,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  ALLOW_REGISTRATION: 'true',
  LOG_LEVEL: 'error',
  MASTER_KEY: crypto.randomBytes(32).toString('hex'),
};

const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function kill() {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

try {
  if (!(await waitUp())) throw new Error(`服务没起来：\n${serverLog.slice(-2000)}`);
  ok('服务启动');

  /* ---- 注册账号 ---- */
  const email = `big${Date.now()}@example.com`;
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123', displayName: '压测', consent: true }),
  });
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!reg.ok) throw new Error(`注册失败: ${await reg.text()}`);
  ok('注册账号');

  /* ---- 建人格 ---- */
  const per = await fetch(`${base}/api/personas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '阿岸', relationship: '朋友' }),
  });
  const personaId = (await per.json()).persona.id;
  ok('创建人格');

  /* ---- 后台持续打 health，记录每次耗时 ---- */
  const probes = [];
  let probing = false;
  const probeLoop = async () => {
    probing = true;
    while (probing) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20000) });
        probes.push({ ms: Date.now() - t0, ok: r.ok });
      } catch {
        probes.push({ ms: Date.now() - t0, ok: false });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const probeTask = probeLoop();

  /* ---- 上传 3MB ---- */
  const boundary = '----bigimport';
  const buf = fs.readFileSync(samplePath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="personaSender"\r\n\r\n阿岸\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const tUpload = Date.now();
  const up = await fetch(`${base}/api/personas/${personaId}/imports`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie },
    body,
    signal: AbortSignal.timeout(120000),
  });
  const upMs = Date.now() - tUpload;
  const upBody = await up.json();
  if (up.status === 202 && upBody.jobId) ok('上传立刻返回 202 + jobId', `${upMs}ms`);
  else bad('上传立刻返回 202 + jobId', `status=${up.status} body=${JSON.stringify(upBody).slice(0, 200)}`);

  // 上传响应必须在很短时间内返回，否则就是又回到"同步处理完才响应"
  if (upMs < 8000) ok('首字节响应够快（不是处理完才返回）', `${upMs}ms`);
  else bad('首字节响应够快（不是处理完才返回）', `${upMs}ms，太慢了`);

  /* ---- 等 job 完成 ---- */
  const tJob = Date.now();
  let job = null;
  for (let i = 0; i < 1800; i++) {
    const r = await fetch(`${base}/api/jobs/${upBody.jobId}`, { headers: { cookie } });
    const j = (await r.json()).job;
    if (j.status === 'done') { job = j; break; }
    if (j.status === 'failed') throw new Error(`导入失败: ${j.error}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const jobMs = Date.now() - tJob;
  if (job) ok('导入 job 完成', `${(jobMs / 1000).toFixed(1)}s, 新增 ${job.result?.added} 条`);
  else bad('导入 job 完成', '超时');

  probing = false;
  await probeTask;

  /* ---- 核心断言：导入期间的 health 响应 ---- */
  const total = probes.length;
  const fails = probes.filter((p) => !p.ok).length;
  const slow = probes.filter((p) => p.ms > 3000);
  const maxMs = Math.max(...probes.map((p) => p.ms), 0);
  const avgMs = Math.round(probes.reduce((a, p) => a + p.ms, 0) / Math.max(total, 1));

  if (fails === 0) ok('导入期间 health 请求零失败', `${total} 次`);
  else bad('导入期间 health 请求零失败', `${fails}/${total} 次失败（这就是 504）`);

  if (slow.length === 0) ok('没有任何请求被拖到 3 秒以上', `最慢 ${maxMs}ms，平均 ${avgMs}ms`);
  else bad('没有任何请求被拖到 3 秒以上', `${slow.length} 次超过 3 秒，最慢 ${maxMs}ms`);

  if (maxMs < 2000) ok('最慢响应在 2 秒内', `${maxMs}ms`);
  else bad('最慢响应在 2 秒内', `${maxMs}ms`);

  /* ---- 数据完整性：消息真的进库了，且 role 判定正确 ---- */
  const del = await fetch(`${base}/api/personas/${personaId}`, { headers: { cookie } });
  const detail = await del.json();
  const st = await fetch(`${base}/api/personas/${personaId}/style-stats`, { headers: { cookie } });
  const stats = await st.json();
  if (stats.sampleCount > 1000) ok('消息落库并统计到人格发言', `${stats.sampleCount} 条 persona 语句`);
  else bad('消息落库并统计到人格发言', `只有 ${stats.sampleCount} 条`);

  const senders = await fetch(`${base}/api/personas/${personaId}/senders`, { headers: { cookie } });
  const sj = await senders.json();
  const personaSender = (sj.senders || []).find((s) => s.role === 'persona');
  if (personaSender) ok('发送者角色判定正确（一次查询替代逐条全表扫描）', `${personaSender.name} · ${personaSender.count}`);
  else bad('发送者角色判定正确', JSON.stringify(sj).slice(0, 200));

  if (detail.persona) ok('人格详情可正常读取（服务仍然健康）');

  /* ---- 重复导入：应该全部去重 ---- */
  const up2 = await fetch(`${base}/api/personas/${personaId}/imports`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie },
    body,
    signal: AbortSignal.timeout(120000),
  });
  const job2id = (await up2.json()).jobId;
  let job2 = null;
  for (let i = 0; i < 1800; i++) {
    const r = await fetch(`${base}/api/jobs/${job2id}`, { headers: { cookie } });
    const j = (await r.json()).job;
    if (j.status === 'done') { job2 = j; break; }
    if (j.status === 'failed') throw new Error(`二次导入失败: ${j.error}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (job2 && job2.result.added === 0 && job2.result.duplicates > 1000) {
    ok('重复导入全部去重', `新增 0，跳过 ${job2.result.duplicates}`);
  } else {
    bad('重复导入全部去重', JSON.stringify(job2?.result || {}).slice(0, 200));
  }
} catch (e) {
  bad('整体执行', e.message);
  if (serverLog) console.log(`\n--- 服务端日志尾部 ---\n${serverLog.slice(-3000)}`);
} finally {
  kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(samplePath, { force: true }); } catch { /* ignore */ }
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  console.log(`(临时数据目录: ${DATA_DIR})`);
  process.exit(fail === 0 ? 0 : 1);
}
