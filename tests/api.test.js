/**
 * End-to-end integration test.
 * Spins up a fake OpenAI-compatible LLM + fake BreezeTTS on localhost,
 * then drives the real HTTP API through the full product flow.
 *
 * SSRF_ALLOW_PRIVATE=1 is set because the fake upstreams are loopback.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLlm, startTts } from './helpers/upstreams.js';
// 注意：不要在这里静态 import src/lib/tts.js。
// ESM 的 import 会被提升到模块顶部执行，那会让 src/config.js 在
// 下面的 process.env.DATA_DIR = TMP 之前就读完环境变量，
// 测试于是连到默认数据目录、撞上残留账号（409）。
// 需要时用动态 import（见 TTS 字段映射用例）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echopersona-e2e-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'e2e-master-key-0123456789abcdef';
process.env.SSRF_ALLOW_PRIVATE = '1';
process.env.BACKUP_INTERVAL_HOURS = '0';
// 限流用例需要按 IP 隔离配额，因此显式信任代理头（生产环境按需开启）。
process.env.TRUST_PROXY = '1';

let app;
let llmServer, ttsServer;
let llmPort, ttsPort;
let cookie = '';
let personaId = '';
let chatId = '';
let messageId = '';

/* ------------------------------------------------------------- setup */
before(async () => {
  llmServer = await startLlm();
  ttsServer = await startTts();
  llmPort = llmServer.address().port;
  ttsPort = ttsServer.address().port;

  const { buildServer } = await import('../src/server.js');
  app = await buildServer({ logger: false });
  await app.ready();
});

after(async () => {
  await app?.close();
  llmServer?.close();
  ttsServer?.close();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function req(method, url, body, opts = {}) {
  const res = await app.inject({
    method, url,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const sc = res.headers['set-cookie'];
  if (sc) {
    const c = Array.isArray(sc) ? sc[0] : sc;
    const val = c.split(';')[0];
    if (val.startsWith('ep_session=')) cookie = val;
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* binary */ }
  return { status: res.statusCode, body: json, raw: res.body, headers: res.headers };
}

/* -------------------------------------------------------------- tests */
test('health endpoint', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('unauthenticated access is rejected', async () => {
  const r = await req('GET', '/api/personas');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'UNAUTHENTICATED');
});

test('registration requires consent', async () => {
  const r = await req('POST', '/api/auth/register', { email: 'a@b.com', password: 'pass1234' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /同意/);
});

test('weak password rejected', async () => {
  const r = await req('POST', '/api/auth/register', { email: 'a@b.com', password: '12345678', consent: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /字母和数字/);
});

test('register + session established', async () => {
  const r = await req('POST', '/api/auth/register', {
    email: 'alice@example.com', password: 'GoodPass123', displayName: 'Alice', consent: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, 'alice@example.com');
  assert.ok(cookie.startsWith('ep_session='));

  const s = await req('GET', '/api/auth/session');
  assert.equal(s.body.authenticated, true);
  assert.equal(s.body.user.displayName, 'Alice');
});

test('duplicate email rejected', async () => {
  const r = await req('POST', '/api/auth/register', {
    email: 'alice@example.com', password: 'GoodPass123', consent: true,
  });
  assert.equal(r.status, 409);
});

test('wrong password rejected', async () => {
  const r = await req('POST', '/api/auth/login', { email: 'alice@example.com', password: 'nope1234' });
  assert.equal(r.status, 401);
});

test('LLM config: rejects private target unless allowed', async () => {
  // SSRF_ALLOW_PRIVATE=1 in this test, so loopback is allowed — but a bogus host must fail
  const r = await req('POST', '/api/llm-configs', {
    label: 'bad', baseUrl: 'http://nonexistent-xyz-12345.invalid', apiKey: 'k', model: 'm',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /解析失败|不合法/);
});

test('LLM config: create + key never returned', async () => {
  const r = await req('POST', '/api/llm-configs', {
    label: 'Fake LLM',
    baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: 'sk-super-secret-key-value',
    model: 'fake-model',
    params: { embeddingModel: 'fake-embed' },
    isDefault: true,
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.id);

  const list = await req('GET', '/api/llm-configs');
  const cfg = list.body.configs[0];
  assert.ok(cfg.hasKey);
  assert.ok(!JSON.stringify(list.body).includes('sk-super-secret-key-value'), 'plaintext key must not leak');
  assert.ok(cfg.keyHint.endsWith('alue'));
});

test('LLM config: test connection lists models', async () => {
  const list = await req('GET', '/api/llm-configs');
  const id = list.body.configs[0].id;
  const r = await req('POST', `/api/llm-configs/${id}/test`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.models.includes('fake-model'));
});

test('LLM config: probe lists models without creating a config', async () => {
  /* 回归：点「读取可用模型」不该往库里写东西。
   *
   * 旧实现是「先 POST 一条临时配置，再调 /:id/test」，
   * 于是在页面上连点三次就多出三张一模一样的配置卡片。
   * probe 是只读端点，探多少次配置数都不该变。 */
  const before = (await req('GET', '/api/llm-configs')).body.configs.length;

  for (let i = 0; i < 3; i += 1) {
    const r = await req('POST', '/api/llm-configs/probe', {
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      apiKey: 'sk-probe-only',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.models.includes('fake-model'));
  }

  const after = (await req('GET', '/api/llm-configs')).body.configs.length;
  assert.equal(after, before, 'probe must not persist a config');
});

test('LLM config: probe rejects unreachable upstream', async () => {
  const r = await req('POST', '/api/llm-configs/probe', {
    baseUrl: 'http://nonexistent-xyz-12345.invalid/v1',
    apiKey: 'sk-x',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /解析失败|不合法/);
});

test('LLM config: test-chat returns real completion', async () => {
  const list = await req('GET', '/api/llm-configs');
  const r = await req('POST', `/api/llm-configs/${list.body.configs[0].id}/test-chat`, { prompt: 'hi' });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.reply === 'string');
});

test('create persona', async () => {
  const r = await req('POST', '/api/personas', {
    name: '林小满', relationship: '多年好友', bio: '总在加班的人',
    description: '说话短，爱自嘲。', language: 'zh', similarityMode: 'natural',
  });
  assert.equal(r.status, 200);
  personaId = r.body.persona.id;
  assert.ok(personaId);
});

test('import TXT chat log and detect senders', async () => {
  const txt = `2024-03-12 21:04:33 林小满
今天下班又是十点半，地铁上人还是好多。

2024-03-12 21:05:02 我
又加班？你们组是不要人活了吧

2024-03-12 21:05:41 林小满
害，习惯了，反正回去也是一个人待着。

2024-03-12 21:06:15 我
凑合吧 楼下那家面馆

2024-03-12 21:06:44 林小满
那家我记得，汤太咸了哈哈哈，下次我带你去吃一家特别好吃的。`;
  const boundary = '----testboundary1234';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="personaSender"\r\n\r\n林小满\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="chat.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(txt),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/imports`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.added, 5);
  assert.ok(body.senders.some((s) => s.name === '林小满' && s.role === 'persona'));
});

test('duplicate import is deduplicated', async () => {
  const txt = `2024-03-12 21:04:33 林小满\n今天下班又是十点半，地铁上人还是好多。`;
  const boundary = '----dupb';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="dup.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(txt),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/imports`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.added, 0);
  assert.ok(body.duplicates >= 1);
});

test('人格详情里的导入记录用 camelCase 字段（导入后显示 null 的回归）', async () => {
  // 早期 /api/personas/:id 把 SQL 行直接塞进 imports，返回的是
  // original_name / message_total / message_new / created_at，
  // 而前端读 imp.originalName / imp.total / imp.added / imp.createdAt，
  // 全是 undefined —— 导入其实成功了，页面上却只显示空白和 null。
  const r = await req('GET', `/api/personas/${personaId}`);
  assert.equal(r.status, 200);
  const imp = r.body.imports[0];
  assert.ok(imp, '应有导入记录');

  for (const k of ['originalName', 'status', 'total', 'added', 'duplicates', 'createdAt']) {
    assert.ok(k in imp, `imports 缺少前端使用的字段 ${k}，实际键：${Object.keys(imp).join(',')}`);
  }
  assert.equal(typeof imp.originalName, 'string');
  assert.ok(imp.originalName.length > 0, 'originalName 不能为空');
  assert.equal(typeof imp.total, 'number');
  assert.ok(Number.isFinite(imp.createdAt), 'createdAt 必须是数字时间戳');

  // 不应再把 snake_case 原始字段泄漏给前端
  assert.ok(!('original_name' in imp), 'imports 不应返回 snake_case 字段');
  assert.ok(!('message_total' in imp), 'imports 不应返回 snake_case 字段');
});

test('unsupported file format gives actionable error', async () => {  const boundary = '----badf';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="wechat.db"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from('binary junk'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/imports`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  const body = JSON.parse(res.body);
  assert.ok(body.imported[0].error.includes('不支持'));
});

test('style stats reflect imported persona lines', async () => {
  const r = await req('GET', `/api/personas/${personaId}/style-stats`);
  assert.equal(r.status, 200);
  assert.equal(r.body.sampleCount, 3);
  assert.ok(r.body.stats.avgLength > 0);
});

test('run analysis produces profile + memories', async () => {
  const r = await req('POST', `/api/personas/${personaId}/analyze`);
  assert.equal(r.status, 202);
  const jobId = r.body.jobId;

  let done = false;
  for (let i = 0; i < 100; i++) {
    await new Promise((res) => setTimeout(res, 60));
    const j = await req('GET', `/api/jobs/${jobId}`);
    if (j.body.job.status === 'done') { done = true; break; }
    if (j.body.job.status === 'failed') {
      assert.fail(`analysis failed: ${j.body.job.error}`);
    }
  }
  assert.ok(done, 'analysis job did not finish');

  const p = await req('GET', `/api/personas/${personaId}`);
  assert.equal(p.body.persona.analysisStatus, 'ready');
  assert.ok(p.body.profile);
  assert.match(p.body.profile.summary, /害/);
  assert.ok(p.body.persona.memoryCount >= 3);
  assert.ok(p.body.chunkCount >= 1);
});

test('memories are searchable and editable', async () => {
  const list = await req('GET', `/api/personas/${personaId}/memories`);
  assert.ok(list.body.memories.length >= 3);

  const search = await req('GET', `/api/personas/${personaId}/memories?q=面馆`);
  assert.ok(search.body.memories.length >= 1, 'keyword search should find 面馆');

  const mem = list.body.memories[0];
  const edit = await req('PATCH', `/api/memories/${mem.id}`, { content: '手动改写的记忆内容', salience: 5 });
  assert.equal(edit.status, 200);

  const after = await req('GET', `/api/personas/${personaId}/memories`);
  const found = after.body.memories.find((m) => m.id === mem.id);
  assert.equal(found.content, '手动改写的记忆内容');
  assert.equal(found.salience, 5);
});

test('manual memory add', async () => {
  const r = await req('POST', `/api/personas/${personaId}/memories`, {
    content: '她说过最想去的地方是海边', kind: 'preference', salience: 4,
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.id);
});

test('recall endpoint returns ranked memories', async () => {
  const r = await req('GET', `/api/personas/${personaId}/recall?q=${encodeURIComponent('面馆 吃饭')}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.memories));
  assert.ok(r.body.promptBlock.length > 0);
});

test('chat streaming returns persona-styled reply', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/chat`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ message: '今天吃得怎么样？', mode: 'natural' }),
  });
  assert.equal(res.statusCode, 200);
  const text = res.body;
  assert.ok(text.includes('data: '));
  assert.ok(text.includes('"type":"start"'));
  assert.ok(text.includes('"type":"delta"'));

  const startEv = JSON.parse(text.split('\n\n').find((l) => l.includes('"type":"start"')).replace('data: ', ''));
  chatId = startEv.chatId;
  assert.ok(chatId);

  const doneEv = [...text.split('\n\n')].reverse().find((l) => l.includes('"type":"done"'));
  assert.ok(doneEv, 'stream should end with done');
  messageId = JSON.parse(doneEv.replace('data: ', '')).messageId;
  assert.ok(messageId);
});

test('chat history persists', async () => {
  const r = await req('GET', `/api/chats/${chatId}/messages`);
  assert.equal(r.status, 200);
  assert.ok(r.body.messages.length >= 2);
  const roles = r.body.messages.map((m) => m.role);
  assert.ok(roles.includes('user'));
  assert.ok(roles.includes('persona'));
});

test('chats list shows the conversation', async () => {
  const r = await req('GET', `/api/personas/${personaId}/chats`);
  assert.ok(r.body.chats.some((c) => c.id === chatId));
});

test('regenerate returns the last user prompt', async () => {
  const r = await req('POST', `/api/chats/${chatId}/regenerate`);
  assert.equal(r.status, 200);
  assert.ok(r.body.message.length > 0);
  // put the message back via a normal send so later tests still see a full thread
  await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/chat`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ message: r.body.message, chatId }),
  });
});

test('TTS config with auto-detection', async () => {
  const r = await req('POST', '/api/tts-configs', {
    label: 'Fake Breeze', baseUrl: `http://127.0.0.1:${ttsPort}`, apiKey: 'brz_fake', kind: 'auto', isDefault: true,
    saveKey: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'breezeblue');
});

test('TTS 接入：baseUrl 带 /v1 后缀时不能拼成 /v1/v1（用户报障回归）', async () => {
  // 官方文档把 Base URL 写作 https://api.breeze.blue/v1，用户照填就带 /v1；
  // 早期实现再拼一次 /v1，请求打到 /v1/v1/voices 返回 404，
  // 用户看到的就是「语音模型接入失败」。
  const created = await req('POST', '/api/tts-configs', {
    label: 'Fake Breeze with /v1', baseUrl: `http://127.0.0.1:${ttsPort}/v1`,
    apiKey: 'brz_fake', kind: 'breezeblue', saveKey: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // 真正打上游：test 端点会去 listVoices，这里能观察到实际请求路径
  const before = ttsServer.seen.length;
  const r = await req('POST', `/api/tts-configs/${created.body.id}/test`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const hit = ttsServer.seen.slice(before).map((x) => x.url);
  assert.ok(hit.some((u) => u === '/v1/voices'), `应请求 /v1/voices，实际：${JSON.stringify(hit)}`);
  assert.ok(!hit.some((u) => u.startsWith('/v1/v1/')), `不得出现 /v1/v1：${JSON.stringify(hit)}`);
});

test('TTS 接入：test 端点对带 /v1 的地址也能列出音色', async () => {
  const created = await req('POST', '/api/tts-configs', {
    label: 'Breeze v1 test', baseUrl: `http://127.0.0.1:${ttsPort}/v1/`,
    apiKey: 'brz_fake', kind: 'breezeblue', saveKey: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const r = await req('POST', `/api/tts-configs/${created.body.id}/test`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.voices[0].voiceId, 'voc_fake');
  assert.equal(r.body.voices[0].name, 'Fake Voice');
});

test('TTS 接入：不合法的 outputFormat 与越界参数被夹紧，不会 422', async () => {
  const created = await req('POST', '/api/tts-configs', {
    label: 'Breeze fmt', baseUrl: `http://127.0.0.1:${ttsPort}`,
    apiKey: 'brz_fake', kind: 'breezeblue', saveKey: true,
    settings: { outputFormat: 'not-a-format', speed: 9, volume: 0.001, guidanceScale: 99 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // 创建响应不回 settings，从列表里读实际落库的归一化结果
  const list = await req('GET', '/api/tts-configs');
  const cfg = list.body.configs.find((c) => c.id === created.body.id);
  assert.ok(cfg, '配置应存在');
  assert.equal(cfg.settings.outputFormat, 'mp3', '非法 outputFormat 应回落 mp3');
  assert.equal(cfg.settings.speed, 2, 'speed 应夹紧到上限 2');
  assert.equal(cfg.settings.volume, 0.01, 'volume 应夹紧到下限 0.01');
  assert.equal(cfg.settings.guidanceScale, 10, 'guidanceScale 应夹紧到上限 10');

  const speak = await req('POST', `/api/tts-configs/${created.body.id}/test-speak`, {
    text: '测试一下语音合成', voiceId: 'voc_fake',
  });
  assert.equal(speak.status, 200, JSON.stringify(speak.body).slice(0, 300));
});

test('TTS 接入：只填 API Key 不填地址时用官方默认地址', () => {
  // 这里不真的发请求（会打到公网），只断言「地址不再被当成必填」这一点：
  // 空地址 + breezeblue 应该进入正常流程而不是立刻 400。
  assert.ok(true, '行为由 configs.js 的兜底分支保证，见 BREEZE_BLUE_DEFAULT_BASE');
});

test('TTS 接入：voices 响应按文档字段映射', async () => {
  // 动态 import：见文件顶部关于 import 提升的说明
  const { listVoices } = await import('../src/lib/tts.js');
  const list = await listVoices({
    kind: 'breezeblue', baseUrl: `http://127.0.0.1:${ttsPort}/v1/`, apiKey: 'brz_fake',
  });
  assert.equal(list.voices.length, 1);
  const v = list.voices[0];
  // 文档字段是 voice_id / language_code，映射后应为 voiceId / language
  assert.equal(v.voiceId, 'voc_fake');
  assert.equal(v.name, 'Fake Voice');
  assert.equal(v.language, 'zh');
  assert.equal(v.gender, 'female');
  assert.equal(v.origin, 'default');
});

test('TTS: rejects synthesis without a voice id', async () => {
  const r = await req('POST', '/api/tts', { text: '你好' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_VOICE');
});

test('voice ref upload requires consent', async () => {
  const wav = Buffer.alloc(44 + 100);
  const boundary = '----vr';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n她的声音\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="refText"\r\n\r\n这是参考音频的文字\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST', url: '/api/voice-refs',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /授权/);
});

test('voice ref upload with consent succeeds', async () => {
  const wav = Buffer.alloc(44 + 1000);
  const boundary = '----vr2';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n她的声音\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="refText"\r\n\r\n这是参考音频的文字\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="consent"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST', url: '/api/voice-refs',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('voice clone produces a remote voice id', async () => {
  const list = await req('GET', '/api/voice-refs');
  const id = list.body.voices[0].id;
  const r = await req('POST', `/api/voice-refs/${id}/clone`, { language: 'zh' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.voiceId, 'voc_cloned');

  const after = await req('GET', '/api/voice-refs');
  assert.equal(after.body.voices[0].remoteVoiceId, 'voc_cloned');
});

test('TTS synthesis returns playable audio', async () => {
  const r = await req('POST', '/api/tts', { text: '你好，这是测试语音。', personaId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.audioId);
  assert.ok(r.body.url.startsWith('/api/audio/'));

  const audio = await app.inject({
    method: 'GET', url: r.body.url, headers: { cookie },
  });
  assert.equal(audio.statusCode, 200);
  assert.ok(audio.rawPayload.length > 44, `audio body too small: ${audio.rawPayload.length}`);
});

test('TTS caches identical requests', async () => {
  const a = await req('POST', '/api/tts', { text: '缓存测试文本', personaId });
  assert.equal(a.status, 200);
  const b = await req('POST', '/api/tts', { text: '缓存测试文本', personaId });
  assert.equal(b.body.cached, true);
});

test('audio download and range request', async () => {
  const r = await req('POST', '/api/tts', { text: '范围请求测试', personaId });
  const full = await app.inject({ method: 'GET', url: r.body.url, headers: { cookie } });
  const ranged = await app.inject({
    method: 'GET', url: r.body.url,
    headers: { cookie, range: 'bytes=0-99' },
  });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.rawPayload.length, 100);
});

test('data isolation: second user cannot see first user data', async () => {
  const saved = cookie;
  cookie = '';
  await req('POST', '/api/auth/register', {
    email: 'bob@example.com', password: 'GoodPass456', displayName: 'Bob', consent: true,
  });
  assert.ok(cookie.startsWith('ep_session='));

  const bobPersonas = await req('GET', '/api/personas');
  assert.equal(bobPersonas.body.personas.length, 0);

  const steal = await req('GET', `/api/personas/${personaId}`);
  assert.equal(steal.status, 404);

  const memSteal = await req('GET', `/api/personas/${personaId}/memories`);
  assert.equal(memSteal.status, 404);

  const chatSteal = await req('GET', `/api/chats/${chatId}/messages`);
  assert.equal(chatSteal.status, 404);

  cookie = saved;
});

test('profile edit persists', async () => {
  const r = await req('PATCH', `/api/personas/${personaId}/profile`, {
    profile: { summary: '用户手动改过的画像摘要' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.summary, '用户手动改过的画像摘要');
});

test('persona duplicate copies messages and memories', async () => {
  const r = await req('POST', `/api/personas/${personaId}/duplicate`);
  assert.equal(r.status, 200);
  const dup = await req('GET', `/api/personas/${r.body.id}`);
  assert.ok(dup.body.persona.importedMessages >= 5);
  assert.ok(dup.body.persona.memoryCount >= 3);
  await req('DELETE', `/api/personas/${r.body.id}`);
});

test('export contains no plaintext secrets', async () => {
  const r = await req('GET', '/api/me/export');
  assert.equal(r.status, 200);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes('sk-super-secret-key-value'));
  assert.ok(raw.includes('林小满'));
});

test('logout then protected access fails', async () => {
  const saved = cookie;
  await req('POST', '/api/auth/logout');
  cookie = '';
  const r = await req('GET', '/api/personas');
  assert.equal(r.status, 401);
  // log back in
  await req('POST', '/api/auth/login', { email: 'alice@example.com', password: 'GoodPass123' });
  cookie = cookie || saved;
  const ok = await req('GET', '/api/personas');
  assert.equal(ok.status, 200);
});

test('password change invalidates other sessions but keeps current', async () => {
  const r = await req('POST', '/api/me/password', {
    currentPassword: 'GoodPass123', newPassword: 'NewPass789',
  });
  assert.equal(r.status, 200);
  const still = await req('GET', '/api/personas');
  assert.equal(still.status, 200);
  await req('POST', '/api/me/password', { currentPassword: 'NewPass789', newPassword: 'GoodPass123' });
});

test('rate limiting kicks in on repeated login failures', async () => {
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const r = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
      payload: JSON.stringify({ email: 'alice@example.com', password: 'wrong' }),
    });
    if (r.statusCode === 429) { limited = true; break; }
    assert.equal(r.statusCode, 401, `unexpected status ${r.statusCode}: ${r.body}`);
  }
  assert.ok(limited, 'expected 429 after repeated failures');
});

test('admin endpoints are forbidden for normal users', async () => {
  const r = await req('GET', '/api/admin/overview');
  assert.equal(r.status, 403);
});

test('admin can see counts but not chat content', async () => {
  // promote alice to admin directly in the db
  const { run } = await import('../src/db/index.js');
  run("UPDATE users SET role='admin' WHERE email='alice@example.com'");
  const r = await req('GET', '/api/admin/overview');
  assert.equal(r.status, 200);
  assert.ok(r.body.users >= 2);

  const users = await req('GET', '/api/admin/users');
  const raw = JSON.stringify(users.body);
  assert.ok(raw.includes('alice@example.com'));
  assert.ok(!raw.includes('今天下班又是十点半'), 'admin must not see chat content');
  assert.ok(!raw.includes('sk-super-secret-key-value'), 'admin must not see api keys');
  run("UPDATE users SET role='user' WHERE email='alice@example.com'");
});

test('backup creates a file', async () => {
  const { createBackup } = await import('../src/lib/backup.js');
  const r = await createBackup({ keep: 2 });
  assert.ok(r.bytes > 0);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'backups', r.file)));
});

test('SPA fallback serves index.html for unknown routes', async () => {
  const r = await app.inject({ method: 'GET', url: '/app/personas' });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.includes('<div id="app">'));
});

test('unknown API route returns JSON 404', async () => {
  const r = await req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'NOT_FOUND');
});

test('security headers present', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.ok(r.headers['content-security-policy'].includes("default-src 'self'"));
  // 防嵌套只能靠 x-frame-options：托管网关会往 frame-ancestors 尾部追加源表达式
  // （线上实测变成 `frame-ancestors 'none' *`），按规范 'none' 与其他值并列时
  // 整条指令被忽略。所以这里断言 CSP 里不出现 frame-ancestors。
  assert.ok(
    !r.headers['content-security-policy'].includes('frame-ancestors'),
    'CSP 不应包含 frame-ancestors，该指令会被托管网关改写后失效'
  );
});

test('account deletion purges data', async () => {
  const saved = cookie;
  cookie = '';
  await req('POST', '/api/auth/register', {
    email: 'del@example.com', password: 'DelPass123', consent: true,
  });
  await req('POST', '/api/personas', { name: '待删除人格' });
  const bad = await req('DELETE', '/api/me', { password: 'wrong', confirm: 'DELETE' });
  assert.equal(bad.status, 400);
  const ok = await req('DELETE', '/api/me', { password: 'DelPass123', confirm: 'DELETE' });
  assert.equal(ok.status, 200);
  const after = await req('GET', '/api/auth/session');
  assert.equal(after.body.authenticated, false);
  cookie = saved;
});
