#!/usr/bin/env node
/**
 * 「人格分析报 JSON 不合法」与「云模型却被要求配 Key」两条链路的真实验证。
 *
 * 不走单元测试的假分支，而是：
 *   1. 起一个真的假上游，第一次分析故意返回带代码块 + 裸换行 + 尾逗号的畸形 JSON，
 *      第二次（repair 请求）返回干净 JSON —— 断言最终分析成功、且真的发了修复请求。
 *   2. 只开云模型（llm_configs 里只有 workbuddy-cloud 一行，没有任何 api_key）时，
 *      /analyze 必须返回 409 + USE_CLOUD_ANALYZE，而不是让用户去「添加 API Key」。
 *
 * 用法： node scripts/verify-analysis.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-an-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'verify-analysis-key-0123456789ab';
process.env.SSRF_ALLOW_PRIVATE = '1';
process.env.BACKUP_INTERVAL_HOURS = '0';

const checks = [];
const ok = (n, d = '') => { checks.push({ ok: true, n }); console.log(`  PASS ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { checks.push({ ok: false, n }); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); };

const { buildServer } = await import('../src/server.js');

let cookie = '';
let app;

async function req(method, url, body) {
  const res = await app.inject({
    method, url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers['set-cookie'];
  if (sc) {
    const c = Array.isArray(sc) ? sc[0] : sc;
    const v = c.split(';')[0];
    if (v.startsWith('ep_session=')) cookie = v;
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { }
  return { status: res.statusCode, body: json, raw: res.body };
}

/* 畸形 JSON：外面裹 ```json、字符串里带裸换行、末尾多一个逗号。
 * 这三样合起来正是模型最常见的输出毛病，也是用户看到报错的真实原因。 */
const BROKEN = '```json\n'
  + '{\n'
  + '  "summary": "她说话很轻，爱用「嗯」「害」开头",\n'
  + '  "personality": {"traits": [{"trait": "温和", "confidence": 0.8}, {"trait": "黏人", "confidence": 0.7}]},\n'
  + '  "speaking_style": "语速偏慢，\n句尾常带「呀」「呢」",\n'
  + '  "relationship": "女朋友",\n'
  + '}\n'
  + '```\n'
  + '（以上是她的人格档案）';

/* 本地一定救不回来的坏输出：里面**一个合法的 JSON 结构都没有**
 * （单引号 + 未加引号的 key + 注释），只能用「发回模型让它重写」这条路。
 * 用来验证 repair 通道真的会被触发，而不是只有本地兜底在起作用。 */
const HOPELESS = "好的，我来分析一下。\n\n{ summary: '她说话很轻', "
  + "language_style: { tone: '平静' }, // 下面是性格\n  personality: { traits: [] } }\n"
  + "以上是我的分析，希望有帮助。";

const CLEAN = JSON.stringify({
  summary: '她说话很轻，爱用「嗯」「害」开头',
  personality: { traits: [{ trait: '温和', evidence: '句尾常带「呀」', confidence: 0.8 }, { trait: '黏人', evidence: '频繁追问你在干嘛', confidence: 0.7 }] },
  speaking_style: '语速偏慢，句尾常带「呀」「呢」',
  relationship: '女朋友',
});

let sawRepairRequest = false;
let analysisCalls = 0;
let seenMaxTokens = 0;
let seenTemperature = null;

function startFlakyLlm() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        if (req.url.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'fake-model' }, { id: 'fake-embed' }] }));
        }
        if (req.url.includes('/embeddings')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }] }));
        }
        // 从 messages 里判断这是不是「JSON 修复器」的请求。
        // 注意不能只匹配「只输出 JSON」—— 分析 prompt 里也写着
        // 「只输出 JSON，不要 markdown 代码块」，那样会把分析请求
        // 误判成修复请求，max_tokens 断言就永远读不到值。
        const sys = String(body.messages?.[0]?.content || '');
        const isRepair = /JSON\s*修复器/.test(sys);
        if (isRepair) sawRepairRequest = true;
        else {
          analysisCalls += 1;
          // 记下分析请求真实发出的预算 —— 截断根因就在这两个值上
          seenMaxTokens = Number(body.max_tokens) || 0;
          seenTemperature = body.temperature;
        }
        const content = isRepair ? CLEAN : HOPELESS;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function main() {
  const llm = await startFlakyLlm();
  app = await buildServer({ logger: false });
  await app.ready();
  console.log('\n[verify-analysis] 开始\n');

  let r = await req('POST', '/api/auth/register', {
    email: `an${Date.now()}@example.com`, password: 'Passw0rd123', displayName: '验证', consent: true,
  });
  if (r.status >= 400) return bad('注册账号', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);
  ok('注册账号');

  /* ------------------------------------------- 有自己 Key 的分支 */
  /* 关键：这里故意把用户配置成「API 配置」页面的默认值 —— max_tokens 1024、
   * 温度 0.9。这正是线上真实场景：用户什么都没改，用的是默认值。
   * 旧代码 { max_tokens: 8000, ...params } 会被这个 1024 覆盖掉，
   * 长 JSON 必然写到一半被截断，报「不是合法 JSON」。
   * 分析侧必须把预算抬到 8000、温度压到 0.6 以内。 */
  r = await req('POST', '/api/llm-configs', {
    label: '假模型', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'sk-test',
    model: 'fake-model', isDefault: true,
    params: { max_tokens: 1024, temperature: 0.9 },
  });
  if (r.status >= 400) return bad('创建模型配置', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);
  ok('创建模型配置');

  r = await req('POST', '/api/personas', { name: '林小满', relationship: '女朋友' });
  const personaId = r.body?.persona?.id;
  ok('创建人格', personaId || '');

  const chatTxt = `2024-03-12 21:04:33 林小满
你在干嘛呀

2024-03-12 21:05:02 我
在加班

2024-03-12 21:07:40 林小满
害 那你早点回来 给你留了饭

2024-03-12 21:09:02 我
好

2024-03-12 21:11:02 林小满
每次都这样
`;
  const form = new FormData();
  form.append('file', new Blob([chatTxt], { type: 'text/plain' }), 'wechat.txt');
  form.append('senderMap', JSON.stringify({ 林小满: 'persona', 我: 'user' }));
  const mp = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/imports`,
    headers: { cookie }, payload: form,
  });
  if (mp.statusCode === 200) ok('导入聊天记录');
  else bad('导入聊天记录', `HTTP ${mp.statusCode} ${mp.body.slice(0, 160)}`);

  /* 关键：上游给畸形 JSON，接口必须靠自动修复跑成功。
   * 分析是异步任务（202 + jobId），必须等 job 结束再看结果 ——
   * 只看 202 会把「排队成功」误当成「分析成功」。 */
  const waitJob = async (jobId) => {
    for (let i = 0; i < 120; i += 1) {
      const j = await req('GET', `/api/jobs/${jobId}`);
      const st = j.body?.job?.status;
      if (st === 'done' || st === 'failed') return j.body.job;
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  };

  r = await req('POST', `/api/personas/${personaId}/analyze`);
  let job = null;
  if (r.status === 202 && r.body?.jobId) job = await waitJob(r.body.jobId);
  if (job?.status === 'done') ok('畸形 JSON 下分析仍然成功');
  else bad('畸形 JSON 下分析仍然成功', job ? `job ${job.status}: ${String(job.error || '').slice(0, 200)}` : `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  if (sawRepairRequest) ok('确实向上游发了 JSON 修复请求');
  else bad('确实向上游发了 JSON 修复请求', `上游只收到 ${analysisCalls} 次普通分析`);

  /* 预算断言：只有真的发出 8000，才不会因为用户默认的 1024 被截断。
   * 这条是「分析一定要成功」的技术底线 —— 之前失败与模型强弱无关，
   * 是发出去的 max_tokens 只有 1024。 */
  if (seenMaxTokens >= 8000) ok('分析请求的 max_tokens 没被用户配置压小', String(seenMaxTokens));
  else bad('分析请求的 max_tokens 没被用户配置压小', `实际发了 ${seenMaxTokens}`);
  if (seenTemperature !== null && Number(seenTemperature) <= 0.6) {
    ok('分析请求的温度被压到 0.6 以内', String(seenTemperature));
  } else {
    bad('分析请求的温度被压到 0.6 以内', String(seenTemperature));
  }

  r = await req('GET', `/api/personas/${personaId}`);
  // profile 与 persona 同级，不是 persona 的子字段
  const prof = r.body?.profile;
  if (prof && (prof.summary || prof.speaking_style)) {
    ok('档案真的落库了', String(prof.summary || '').slice(0, 24));
  } else {
    bad('档案真的落库了', JSON.stringify(prof || null).slice(0, 200));
  }
  // 修复不能把内容改丢
  if (prof && /温和/.test(JSON.stringify(prof.personality || {}))) ok('修复过程没有丢失原内容');
  else bad('修复过程没有丢失原内容', JSON.stringify(prof?.personality || null));

  /* --------------------------------- 空档案必须当失败，不能装作成功 */
  const { parseProfileJson } = await import('../src/lib/persona.js');
  if (parseProfileJson('{}') === null) ok('解析出空对象按失败处理');
  else bad('解析出空对象按失败处理');
  if (parseProfileJson('我无法回答这个问题') === null) ok('纯文本按失败处理');
  else bad('纯文本按失败处理');

  /* ------------------- 只剩云模型时，必须当作「没有模型」 */
  /* 云通道已按需求整体移除：/api/cloud/* 不再注册，loadLlm 也排除
   * provider='workbuddy-cloud'。老库里的云通道行没有任何 api_key_enc，
   * 如果被选中会一路走到上游再报 401，用户看到的是"配置坏了"而不是
   * "你还没配自己的 Key"。所以这里断言的是 NO_LLM —— 明确要求用户
   * 填自己的第三方 API Key，而不是假装还能用云额度。 */
  const { run: dbRun, get: dbGet } = await import('../src/db/index.js');
  dbRun("DELETE FROM llm_configs WHERE user_id = (SELECT id FROM users WHERE email LIKE 'an%@example.com' ORDER BY created_at DESC LIMIT 1)");
  if (dbGet('SELECT COUNT(*) c FROM llm_configs WHERE provider = ?', ['workbuddy-cloud']).c === 0) {
    const uid = dbGet("SELECT id FROM users WHERE email LIKE 'an%@example.com' ORDER BY created_at DESC LIMIT 1").id;
    dbRun(`INSERT INTO llm_configs (id,user_id,label,provider,base_url,api_key_enc,model,params_json,is_default,created_at,updated_at)
           VALUES (?,?,?,?,?,NULL,?,'{}',1,?,?)`,
      [`llm_${Date.now()}`, uid, 'WorkBuddy 云模型', 'workbuddy-cloud', 'cloud', 'auto', Date.now(), Date.now()]);
  }

  r = await req('POST', `/api/personas/${personaId}/analyze`);
  if (r.status === 400 && r.body?.code === 'NO_LLM') {
    ok('只有已移除的云通道时，按「没有可用模型」处理', r.body.error.slice(0, 40));
  } else {
    bad('只剩云通道时返回 NO_LLM', `HTTP ${r.status} ${r.raw.slice(0, 220)}`);
  }
  // 而且要明确指向「填自己的 Key」，不能含糊地让人去猜
  if (r.body && /API Key/i.test(String(r.body.error))) {
    ok('提示里明确要求填自己的 API Key', r.body.error.slice(0, 40));
  } else {
    bad('提示里明确要求填自己的 API Key', String(r.body?.error));
  }

  const fail = checks.filter((c) => !c.ok);
  console.log(`\n[verify-analysis] ${checks.length - fail.length}/${checks.length} 通过\n`);
  for (const f of fail) console.log(' - ' + f.n);
  await app.close();
  llm.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
