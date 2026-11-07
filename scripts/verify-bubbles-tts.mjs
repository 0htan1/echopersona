#!/usr/bin/env node
/**
 * 验证「文字回复拆成多条」与「语音针对 TTS 优化」这两件事真的生效。
 *
 * 断言的落点不是「接口返回 200」，而是：
 *   1. 模型吐 `A|||B|||C` → **数据库里真有 3 条 persona 消息**，且 seq 连续
 *      （只在前端假装拆开是不行的，刷新页面就变回一条）
 *   2. 语音模式 → 只落成 1 条，不拆（连发多条语音是打扰）
 *   3. 语音提示词里含「TTS / 念出来」的明确要求，且要求保留标点
 *   4. 送去合成的文本里标点还在（这是 TTS 判断停顿的依据）
 *   5. 文字模式的提示词里含多条消息的规则
 *
 * 用法：node scripts/verify-bubbles-tts.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeTestSession } from './lib/test-login.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-bb-'));
const PORT = 4391;
const LLM_PORT = 4392;
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: TMP,
  MASTER_KEY: 'verify-bubbles-tts-0123456789abcdef',
  SSRF_ALLOW_PRIVATE: '1',
  BACKUP_INTERVAL_HOURS: '0',
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  ALLOW_REGISTRATION: 'true',
};

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? `  (${d})` : ''}`); };

/* ------------------------------------------------------- 假上游，可控输出 */
/* 它同时记录收到的 system prompt —— 想证明「模型真的被告知要拆多条 /
 * 要保留标点」，唯一可靠的办法就是看它到底收到了什么。 */
let nextReply = '在的';
let capturedSystem = '';
let capturedUser = '';

const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }

    /* 同一个端口上会来两种请求：
     *   · /v1/chat/completions  —— LLM 生成（要记录 system prompt）
     *   · /v1/audio/speech      —— TTS 合成（body 是 text/language_code）
     * 语音模式下两条都会发生，如果都写 capturedSystem，TTS 那次会把
     * LLM 那次的内容覆盖掉 —— 表现就是"提示词长度 0"，看起来很像是
     * 语音提示词没生效，其实只是被后一个请求抹了。必须按路径区分。 */
    const isSpeech = /audio|speech/i.test(req.url || '') || parsed.text !== undefined;
    if (isSpeech) {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.alloc(64));   // 一段假的 WAV 头，够让合成流程走完
      return;
    }

    const msgs = parsed.messages || [];
    capturedSystem = msgs.find((m) => m.role === 'system')?.content || '';
    capturedUser = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    /* 单元里 system 可能是字符串也可能是数组（部分上游允许多段 content），
     * 这里两种都兜一下，否则断言会因为拿不到内容而假失败。 */
    if (!capturedSystem) {
      const sys = msgs.find((m) => m.role === 'system');
      if (Array.isArray(sys?.content)) capturedSystem = sys.content.map((c) => c.text || '').join('\n');
    }

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    // 按字符分块推，模拟真实流式
    const chunks = [...nextReply];
    for (const ch of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

/* ------------------------------------------------------- 起服务 */
const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src/server.js')], {
  env, cwd: path.join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

async function waitUp() {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error(`服务没起来:\n${log.slice(-1500)}`);

  const token = makeTestSession({ dataDir: TMP });
  if (!token) throw new Error('建测试登录态失败');
  const cookie = `ep_session=${token}`;
  const H = { cookie, 'content-type': 'application/json' };

  /* ---- 配一个指向假上游的模型 ---- */
  const llmCfg = await fetch(`${BASE}/api/llm-configs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      label: '假上游', baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`,
      apiKey: 'sk-test-1234567890', model: 'test-model',
    }),
  });
  if (!llmCfg.ok) throw new Error(`建模型配置失败 ${llmCfg.status}: ${(await llmCfg.text()).slice(0, 300)}`);

  const per = await fetch(`${BASE}/api/personas`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: '阿岸', relationship: '朋友' }),
  });
  const personaId = (await per.json()).persona.id;

  /* ================================================================
   * 1. 文字模式：模型吐三条 → 数据库里就是三条独立消息
   * ================================================================ */
  nextReply = '刚到家|||累死了|||你吃了吗';
  const chat1 = await fetch(`${BASE}/api/personas/${personaId}/chat`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: '回来了吗', voiceMode: 'text' }),
  });
  const text1 = await chat1.text();
  const doneEv = text1.split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter((x) => x && x.type === 'done')[0];

  if (doneEv?.bubbles?.length === 3) ok('done 事件返回 3 条气泡', doneEv.bubbles.map((b) => b.content).join(' | '));
  else bad('done 事件返回 3 条气泡', JSON.stringify(doneEv?.bubbles || doneEv).slice(0, 200));

  // 关键断言：从数据库读回来，而不是信任 done 事件
  const chatId = doneEv?.chatId || (JSON.parse(text1.split('data: ').find((l) => l.includes('"type":"start"')) || '{}').chatId);
  const readBack = await fetch(`${BASE}/api/chats/${chatId}/messages`, { headers: { cookie } });
  const { messages } = await readBack.json();
  const personaMsgs = messages.filter((m) => m.role === 'persona');

  if (personaMsgs.length === 3) {
    ok('数据库里真的落了 3 条独立消息（刷新不回退）', personaMsgs.map((m) => m.content).join(' | '));
  } else {
    bad('数据库里真的落了 3 条独立消息', `实际 ${personaMsgs.length} 条: ${personaMsgs.map((m) => m.content).join(' | ')}`);
  }
  /* seq 断言必须直接查库：/api/chats/:id/messages 不返回 seq 字段
   * （前端用不到，没必要暴露），从接口读到的永远是 undefined，
   * 那样这条断言会永远"通过"或永远"失败"，等于没测。 */
  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = fs.readdirSync(TMP).find((f) => f.endsWith('.db'));
  const db = dbFile ? new DatabaseSync(path.join(TMP, dbFile), { readOnly: true }) : null;
  if (db) {
    const rows = db.prepare(
      `SELECT content, seq FROM messages WHERE chat_id = ? AND role = 'persona' ORDER BY seq ASC`,
    ).all(chatId);
    const seqs = rows.map((r) => r.seq);
    const consecutive = seqs.length === 3 && seqs[1] === seqs[0] + 1 && seqs[2] === seqs[1] + 1;
    if (consecutive) ok('三条消息 seq 连续递增（同毫秒也不会乱序）', seqs.join(','));
    else bad('三条消息 seq 连续递增', `实际 ${JSON.stringify(seqs)}`);
    db.close();
  } else {
    bad('能读到数据库以校验 seq', `目录里没有 .db: ${fs.readdirSync(TMP).join(',')}`);
  }
  if (!personaMsgs.some((m) => m.content.includes('|||'))) ok('库里不含分隔符残留');
  else bad('库里不含分隔符残留', personaMsgs.map((m) => m.content).join(' | '));

  /* ---- 提示词里有多条规则 ---- */
  if (capturedSystem.includes('多条消息') && capturedSystem.includes('|||')) {
    ok('文字提示词含「多条消息」规则');
  } else {
    bad('文字提示词含「多条消息」规则', 'system prompt 里没找到');
  }

  /* ================================================================
   * 2. 不需要拆时不要硬拆
   * ================================================================ */
  nextReply = '在的';
  const chat2 = await fetch(`${BASE}/api/personas/${personaId}/chat`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: '在吗', voiceMode: 'text', chatId }),
  });
  const t2 = await chat2.text();
  const d2 = t2.split('\n').filter((l) => l.startsWith('data: '))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter((x) => x && x.type === 'done')[0];
  if (!d2?.bubbles) ok('能一句话说完时不拆（不返回 bubbles）');
  else bad('能一句话说完时不拆', `却返回了 ${d2.bubbles.length} 条`);

  /* ================================================================
   * 3. 语音模式：不拆，且提示词针对 TTS
   *
   * 注意必须先配一个 TTS 配置。没有 TTS 时 canVoice=false、speaking=false，
   * 走的是**文字**提示词 —— 这是正确行为（没配语音就不该按语音的要求生成），
   * 但会让这里的断言测错对象。所以配一个 kind=auto 的配置把分支打开。
   * ================================================================ */
  /* 用 breezeblue：它的 ready 判定只需 remote_voice_id + apiKey，
   * 不要求本地有参考音频文件。
   *
   * 为什么不选 breeze_local：那个分支的 ready 要求 voiceRef.file_path
   * 存在（必须真的传一个 wav 上去）。这里只是想打开 speaking 分支，
   * 没必要为此造一个音频文件。 */
  const ttsCfg = await fetch(`${BASE}/api/tts-configs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      label: '假TTS', kind: 'breezeblue',
      baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'sk-test-1234567890',
    }),
  });
  if (!ttsCfg.ok) throw new Error(`建 TTS 配置失败 ${ttsCfg.status}: ${(await ttsCfg.text()).slice(0, 300)}`);

  /* 建一个远程音色（只给 voice id，不需要真实音频）。
   * voice_refs 的第一个会自动成为默认，所以不用再指定。 */
  const vref = await fetch(`${BASE}/api/voice-refs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: '测试音色', remoteVoiceId: 'test-voice-001', provider: 'breeze' }),
  });
  if (!vref.ok) throw new Error(`建音色失败 ${vref.status}: ${(await vref.text()).slice(0, 300)}`);

  nextReply = '我刚到家，累死了。你吃了吗';
  const chat3 = await fetch(`${BASE}/api/personas/${personaId}/chat`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: '回来了？', voiceMode: 'voice', chatId }),
  });
  const t3 = await chat3.text();
  const d3 = t3.split('\n').filter((l) => l.startsWith('data: '))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter((x) => x && x.type === 'done')[0];

  if (!d3?.bubbles) ok('语音模式不拆成多条（一条语音就是一条）');
  else bad('语音模式不拆成多条', `却拆了 ${d3.bubbles.length} 条`);

  if (capturedSystem.includes('念出来') || capturedSystem.includes('TTS')) {
    ok('语音提示词明确告诉模型「这段会被念出来」');
  } else {
    bad('语音提示词明确告诉模型「这段会被念出来」');
  }

  if (capturedSystem.includes('标点只用逗号和句号') || capturedSystem.includes('标停顿')) {
    ok('语音提示词要求「用标点标停顿」（不是全删标点）');
  } else {
    bad('语音提示词要求「用标点标停顿」', '仍可能是旧的「一个标点都不要」');
  }

  if (capturedSystem.includes('不要用') && capturedSystem.includes('拆成多条')) {
    ok('语音提示词明确禁止拆成多条');
  } else {
    bad('语音提示词明确禁止拆成多条');
  }

  /* ---- 送去合成的文本里标点还在 ---- */
  /* 语音没配 tts 时不会真的合成，所以这里单独验证清洗函数的行为：
   * 用和水合同一套逻辑的导出函数，确认标点被保留。 */
  const { sanitizeSpokenText } = await import('../src/lib/voice-mode.js');
  const spoken = sanitizeSpokenText('我刚到家，累死了。你吃了吗');
  if (spoken.includes('，') && spoken.includes('。')) {
    ok('送 TTS 的文本保留了句读（停顿的依据）', spoken);
  } else {
    bad('送 TTS 的文本保留了句读', JSON.stringify(spoken));
  }
} catch (e) {
  bad('整体执行', e.message);
  if (log) console.log(`\n--- 服务端日志 ---\n${log.slice(-2000)}`);
} finally {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  try { llm.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
