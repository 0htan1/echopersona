/**
 * 基准测量：3MB 聊天记录从解析到落库到底占多少 CPU。
 *
 * 这不是"猜哪个环节慢"，而是先量出每个阶段的实际耗时和 event loop 被阻塞
 * 的时长 —— 后者才是 504 的直接原因。Node 是单线程的，同步 CPU 计算期间
 * 连 health check 都排不上队，网关等不到响应就报 504。
 *
 * 用法：node scripts/bench-import.mjs [MB]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MB = Number(process.argv[2] || 3);

// DATA_DIR 必须在 import config.js 之前设置 —— config 是模块级常量，
// 一旦被求值就固定了，之后再改环境变量不会生效。
process.env.DATA_DIR = path.join(os.tmpdir(), `ep-bench-${Date.now()}`);

const { parseChatFile } = await import('../src/lib/parsers.js');
const dbMod = await import('../src/db/index.js');
dbMod.migrate();
const { run, get, all } = dbMod;
const { persistMessages } = await import('../src/routes/imports.js');
const { computeStyleStats, describeStats } = await import('../src/lib/persona.js');

/* ---------------------------------------------------------------- 造样本
 * 用真实微信导出的形态：`2023-01-01 12:00:00 昵称` 独立成行，内容在下一行。
 * 只有这样解析器才会走真实分支（单行 `昵称: 内容` 走的是另一条正则）。 */
function makeSample(targetBytes) {
  const senders = ['阿岸', '林小满', '阿岸', '老周'];
  const bodies = [
    '嗯', '行吧', '我在路上了', '今天好热啊', '你说这个我想起来了',
    '晚点再说', '哈哈哈哈哈', '真的假的', '那你自己看着办',
    '我先睡了，明天早起', '这个我记一下', '你吃了吗', '算了不折腾了',
  ];
  const out = [];
  let bytes = 0;
  let day = 1;
  let h = 8;
  let m = 0;
  while (bytes < targetBytes) {
    if (++m >= 60) { m = 0; if (++h >= 24) { h = 0; day += 1; } }
    const d = String(Math.min(day, 28)).padStart(2, '0');
    const ts = `2023-03-${d} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    const s = senders[m % senders.length];
    const body = bodies[(m + day) % bodies.length];
    const chunk = `${ts} ${s}\n${body}\n`;
    out.push(chunk);
    bytes += Buffer.byteLength(chunk);
  }
  return out.join('');
}

/* ------------------------------------------------- event loop 阻塞测量
 * 独立定时器每 16ms 打一次点。如果某两次打点间隔远超 16ms，
 * 说明中间那段是同步代码把 event loop 占死了 —— 这段时间里任何 HTTP
 * 请求都不会被处理。 */
function makeLagProbe() {
  let last = process.hrtime.bigint();
  let maxLag = 0;
  let totalLag = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lagMs = Number(now - last) / 1e6 - 16;
    if (lagMs > maxLag) maxLag = lagMs;
    if (lagMs > 0) totalLag += lagMs;
    last = now;
  }, 16);
  timer.unref?.();
  return {
    /* 必须先 await 一次让定时器跑完：同步代码执行期间 setInterval 回调
     * 根本不会被调度，直接 clearInterval 会把"积压到现在的这一跳"取消掉，
     * 于是最大阻塞永远显示成几十毫秒 —— 那就等于没测。 */
    async stop() {
      await new Promise((r) => setTimeout(r, 50));
      clearInterval(timer);
      return { maxLagMs: Math.round(maxLag), totalLagMs: Math.round(totalLag) };
    },
  };
}

const sample = makeSample(MB * 1024 * 1024);
const buf = Buffer.from(sample, 'utf8');
console.log(`样本: ${(buf.length / 1024 / 1024).toFixed(2)} MB, ${sample.split('\n').length} 行\n`);

/* ---- 阶段 1：解析 ---- */
const lag1 = makeLagProbe();
await new Promise((r) => setTimeout(r, 40));
let t = Date.now();
const parsed = parseChatFile({ filename: 'sample.txt', buffer: buf });
const parseMs = Date.now() - t;
const lagParse = await lag1.stop();
console.log(`[1] 解析        ${String(parseMs).padStart(6)} ms   阻塞峰值 ${String(lagParse.maxLagMs).padStart(5)} ms   ${parsed.messages.length} 条消息`);

/* ---- 阶段 2：写库 ---- */
const uid = 'usr_bench';
const pid = 'per_bench';
run(`INSERT INTO users (id,email,password_hash,display_name,role,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  [uid, 'bench@local', 'x', 'bench', 'user', 'active', Date.now(), Date.now()]);
run(`INSERT INTO personas (id,user_id,name,analysis_status,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`, [pid, uid, '阿岸', 'none', 'active', Date.now(), Date.now()]);

const lag2 = makeLagProbe();
await new Promise((r) => setTimeout(r, 40));
t = Date.now();
const res = await persistMessages({ userId: uid, personaId: pid, importId: 'imp_bench', messages: parsed.messages, mapping: { '阿岸': 'persona' } });
const writeMs = Date.now() - t;
const lagWrite = await lag2.stop();
console.log(`[2] 写库        ${String(writeMs).padStart(6)} ms   阻塞峰值 ${String(lagWrite.maxLagMs).padStart(5)} ms   新增 ${res.added} 去重 ${res.dup}`);

/* ---- 阶段 3：风格统计 ---- */
const lag3 = makeLagProbe();
await new Promise((r) => setTimeout(r, 40));
t = Date.now();
const lines = all(`SELECT content, ts FROM messages WHERE persona_id = ? AND is_imported = 1 AND role='persona' AND length(content)>0`, [pid]);
const stats = computeStyleStats(lines.map((r) => ({ content: r.content, ts: r.ts })));
const desc = describeStats(stats);
const statsMs = Date.now() - t;
const lagStats = await lag3.stop();
console.log(`[3] 风格统计    ${String(statsMs).padStart(6)} ms   阻塞峰值 ${String(lagStats.maxLagMs).padStart(5)} ms   ${lines.length} 条样本`);

/* ---- 汇总 ---- */
const total = parseMs + writeMs + statsMs;
const worstBlock = Math.max(lagParse.maxLagMs, lagWrite.maxLagMs, lagStats.maxLagMs);
console.log('');
console.log(`合计 ${total} ms（解析 ${Math.round(parseMs / total * 100)}% / 写库 ${Math.round(writeMs / total * 100)}% / 统计 ${Math.round(statsMs / total * 100)}%）`);
console.log(`最长一次 event loop 独占 ${worstBlock} ms`);
console.log(worstBlock > 1000
  ? `=> 这 ${worstBlock}ms 内服务器完全无响应，任何请求都排队。这就是 504 的来源。`
  : '=> 阻塞时间在可接受范围内。');

/* 不删临时库：node:sqlite 的连接在进程退出前不会释放，Windows 上
 * rmSync 会 EBUSY。临时目录留给系统清理即可，测完打印路径方便手动处理。 */
console.log(`\n(临时库: ${process.env.DATA_DIR})`);
