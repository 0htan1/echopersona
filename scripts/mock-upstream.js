#!/usr/bin/env node
/**
 * 本地 mock 上游：给没有 LLM / TTS Key 的用户提供一个「能走通全流程」的测试入口。
 *
 * 重要：它返回的是**模拟数据**，不是真实模型输出。
 * 所有响应都带 X-EP-Mock: 1 头，服务端会在结果里标注 mock=true，
 * 前端也会显示「模拟模式」标识，避免被误认为真实效果。
 *
 * 用法： node scripts/mock-upstream.js [port]
 *       默认 8790，同时提供 OpenAI 兼容与 BreezeTTS 两种协议。
 */
import http from 'node:http';

const port = Number(process.argv[2] || process.env.MOCK_PORT || 8790);
/* 人为延迟（毫秒）：本地验证「分析进度是否在等待期间前进」时，
 * 真模型要几十秒，mock 瞬时返回就永远看不到中间态。
 * 默认 0，不影响其他脚本。 */
const DELAY = Number(process.env.MOCK_DELAY_MS || 0);
const wait = () => (DELAY > 0 ? new Promise((r) => setTimeout(r, DELAY)) : Promise.resolve());

const STYLE_PROFILE = {
  summary: '【模拟数据】说话偏短，习惯先应一声再慢慢讲，语气里有疲惫但很在意对方的反应。',
  language_style: {
    tone: '平静、略带自嘲',
    sentence_pattern: '短句为主，常拆成两三条发',
    punctuation_habit: '少用句号，喜欢省略号和「哈哈哈」',
    favorite_words: ['害', '反正', '记得'],
    catchphrases: ['害，习惯了', '你别老是不当真嘛'],
    reply_rhythm: '回得快，单条很短',
    initiative: '常主动问对方吃饭了没',
  },
  personality: {
    traits: [
      { trait: '体贴', evidence: '反复提醒对方吃饭', confidence: 0.8 },
      { trait: '习惯性示弱', evidence: '用「害」开头淡化自己的处境', confidence: 0.65 },
    ],
    humor: '自嘲式',
    emotion_expression: '难过时先说不出口，再慢慢讲',
    communication_style: '直接但会留余地',
    topic_reactions: [{ topic: '加班', reaction: '用「害」带过，转移话题' }],
    with_familiar: '话多，愿意示弱',
    with_stranger: '客气简短',
  },
  relationship_memory: {
    shared_experiences: [{ content: '一起去过巷子里的面馆', when: '2024 年春', confidence: 0.6 }],
    important_events: [],
    common_topics: ['加班', '吃饭'],
    interests: ['晒被子'],
    preferences: [{ content: '不喜欢别人说「随便」', confidence: 0.55 }],
    agreements: [{ content: '要带对方去吃那家面馆', confidence: 0.7 }],
    nicknames: [{ term: '你', context: '日常' }],
    key_quotes: ['害，习惯了，反正回去也是一个人待着。'],
  },
  memories: [
    { kind: 'event', content: '答应带对方去巷子里的面馆', salience: 4, confidence: 0.75 },
    { kind: 'preference', content: '觉得楼下那家面馆汤太咸', salience: 3, confidence: 0.6 },
    { kind: 'fact', content: '经常加班到十点半', salience: 3, confidence: 0.85 },
  ],
  caution_notes: '【模拟数据】以上内容由本地 mock 生成，仅用于验证流程是否跑通，不代表真实分析结果。',
};

const REPLY_PARTS = ['害，', '还行吧', '，就是有点累。', '你呢，', '今天吃饭了没'];
const MOCK_AUDIO = (() => {
  // 0.5s 静音 WAV，足够验证播放器链路
  const samples = 12000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
})();

const MOCK_HEADER = { 'x-ep-mock': '1' };

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', ...MOCK_HEADER });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const raw = await readAll(req);
  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* multipart etc. */ }

  // ---------------- OpenAI 兼容 ----------------
  if (url.endsWith('/models')) {
    return json(res, 200, {
      data: [{ id: 'mock-chat' }, { id: 'mock-embed' }],
    });
  }

  if (url.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    return json(res, 200, {
      data: inputs.map((txt, i) => ({
        embedding: Array.from({ length: 32 }, (_, k) =>
          Math.sin((k + 1) * (String(txt).length + i + 1)) * 0.5),
      })),
    });
  }

  if (url.endsWith('/chat/completions')) {
    await wait();
    const system = String(body.messages?.[0]?.content || '');
    const isAnalysis = system.includes('语言风格分析专家') || system.includes('JSON');

    if (isAnalysis) {
      return json(res, 200, {
        choices: [{ message: { role: 'assistant', content: JSON.stringify(STYLE_PROFILE) } }],
        usage: { total_tokens: 800 },
        mock: true,
      });
    }

    if (!body.stream) {
      return json(res, 200, {
        choices: [{ message: { role: 'assistant', content: REPLY_PARTS.join('') + '\n\n（模拟回复）' } }],
        usage: { total_tokens: 42 },
        mock: true,
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...MOCK_HEADER });
    let i = 0;
    const timer = setInterval(() => {
      if (i < REPLY_PARTS.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY_PARTS[i] } }] })}\n\n`);
        i++;
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }
    }, 40);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // ---------------- BreezeTTS 托管版 ----------------
  if (url.startsWith('/v1/voices')) {
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
    return json(res, 200, { voices: [{ voice_id: 'mock_voice_01', name: 'Mock Voice' }] });
  }
  if (url.startsWith('/v1/voice-previews/clone')) {
    return json(res, 200, { generated_voice_id: 'mock_preview_01' });
  }
  if (url.includes('/voice-previews/') && url.endsWith('/save')) {
    return json(res, 200, { voice_id: 'mock_cloned_01' });
  }
  if (url.includes('/voice-previews/') && url.includes('/stream')) {
    res.writeHead(200, { 'content-type': 'audio/wav', ...MOCK_HEADER });
    return res.end(MOCK_AUDIO);
  }
  if (url.includes('/text-to-speech/')) {
    res.writeHead(200, { 'content-type': 'audio/wav', ...MOCK_HEADER });
    return res.end(MOCK_AUDIO);
  }

  // ---------------- BreezeTTS 自托管版 ----------------
  if (url === '/health') return json(res, 200, { ok: true, mock: true });
  if (url === '/v1/model') return json(res, 200, { model: 'breeze-tts-2-mock' });
  if (url === '/v1/audio/speech') {
    res.writeHead(200, { 'content-type': 'audio/wav', ...MOCK_HEADER });
    return res.end(MOCK_AUDIO);
  }

  json(res, 404, { error: 'mock upstream: 未实现的路径', path: url });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] 模拟上游已启动： http://127.0.0.1:${port}`);
  console.log('[mock] LLM 接口：  /v1/models, /v1/embeddings, /v1/chat/completions');
  console.log('[mock] TTS 接口：  /v1/voices, /v1/text-to-speech/:id, /v1/voice-previews/*, /v1/audio/speech');
  console.log('');
  console.log('注意：这是模拟数据，不是真实模型输出，仅用于验证流程。');
  console.log('本地联调请在 .env 中设置 SSRF_ALLOW_PRIVATE=1。');
});
