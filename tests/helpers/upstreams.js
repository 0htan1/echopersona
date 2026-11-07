/**
 * 测试专用假上游：一个 OpenAI 兼容 LLM + 一个 BreezeTTS 兼容服务。
 *
 * 只用于测试 —— 它们绑定 127.0.0.1 的随机端口，因此调用方必须设置
 * SSRF_ALLOW_PRIVATE=1，否则我们自己的 SSRF 防护会正确地拦掉它们。
 *
 * 之所以单独抽成模块：api.test.js（后端契约）与 frontend.test.js（前端契约）
 * 都需要同一份假上游。两份拷贝迟早会漂移，导致「后端测试过了、前端测试挂了」
 * 这种最难查的假象。
 */
import http from 'node:http';

/** 分析任务用的完整风格档案；字段与 src/lib/analyze.js 的期望一一对应。 */
export const FAKE_PROFILE = {
  summary: '说话短，爱用「害」开头，语气里带着疲惫但很在意对方的回应。',
  language_style: {
    tone: '平静中带点自嘲',
    sentence_pattern: '短句，常拆成两条发',
    punctuation_habit: '少用句号，喜欢省略号和哈哈哈',
    favorite_words: ['害', '反正', '记得'],
    catchphrases: ['害，习惯了', '你别老是不当真嘛'],
    reply_rhythm: '回得快，但一条很短',
    initiative: '常主动追问对方吃饭了没',
  },
  personality: {
    traits: [{ trait: '体贴', evidence: '反复提醒对方吃饭', confidence: 0.85 }],
    humor: '自嘲式',
    emotion_expression: '难过时先说不出口，再慢慢讲',
    communication_style: '直接但会留余地',
    topic_reactions: [{ topic: '加班', reaction: '用「害」带过' }],
    with_familiar: '话多，愿意示弱',
    with_stranger: '客气简短',
  },
  relationship_memory: {
    shared_experiences: [{ content: '一起去过巷子里的面馆', when: '2024年春', confidence: 0.7 }],
    important_events: [],
    common_topics: ['加班', '吃饭'],
    interests: ['晒被子'],
    preferences: [{ content: '不喜欢别人说随便', confidence: 0.6 }],
    agreements: [{ content: '要带对方去吃那家面馆', confidence: 0.75 }],
    nicknames: [{ term: '你', context: '日常' }],
    key_quotes: ['害，习惯了，反正回去也是一个人待着。'],
  },
  memories: [
    { kind: 'event', content: '答应带对方去巷子里的面馆', salience: 4, confidence: 0.8 },
    { kind: 'preference', content: '觉得楼下那家面馆汤太咸', salience: 3, confidence: 0.7 },
    { kind: 'fact', content: '经常加班到十点半', salience: 3, confidence: 0.9 },
  ],
  // 说话的样子：只能从 [语音转文字] 的语料里看出来，和打字风格不是一回事。
  // 档案里必须有这段，否则发语音时模型会把书面语念出来。
  speaking_style: {
    has_voice_evidence: true,
    voice_tone: '懒懒的，拖着尾音，带点撒娇',
    sentence_length: '很短，一句五六个字就停',
    fillers: ['嗯', '那个', '就是'],
    opening: ['那个…'],
    ending: ['呀', '嘛'],
    pronunciation_notes: '语速偏慢，句尾会拖长',
    difference_from_text: '打字会用句号，说话不用标点，语气词明显更多',
  },
  caution_notes: '样本量有限，性格结论仅供参考。',
};

/** 分片流式回复的内容，拼起来是「害，还行吧。你呢」。 */
export const FAKE_STREAM_PARTS = ['害，', '还行吧', '。你呢'];

export function startLlm() {
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
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          const data = inputs.map((txt, i) => ({
            embedding: Array.from({ length: 16 }, (_, k) => Math.sin((k + 1) * (String(txt).length + i + 1))),
          }));
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data }));
        }
        if (req.url.includes('/chat/completions')) {
          const isAnalysis = String(body.messages?.[0]?.content || '').includes('语言风格分析专家');

          if (isAnalysis) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({
              choices: [{ message: { content: JSON.stringify(FAKE_PROFILE) } }],
              usage: { total_tokens: 1234 },
            }));
          }

          // 非流式：/api/settings/llm/test 之类的探测会走这条
          if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({
              choices: [{ message: { role: 'assistant', content: '你好，我是测试模型。' } }],
              usage: { total_tokens: 12 },
            }));
          }

          // 流式聊天
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let i = 0;
          const iv = setInterval(() => {
            if (i < FAKE_STREAM_PARTS.length) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FAKE_STREAM_PARTS[i] } }] })}\n\n`);
              i++;
            } else {
              res.write('data: [DONE]\n\n');
              clearInterval(iv);
              res.end();
            }
          }, 12);
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/**
 * 假 BreezeTTS 服务。
 *
 * 刻意按官方文档的真实行为来模拟，而不是「什么都返回 200」：
 *  - 路径必须是 /v1/xxx。收到 /v1/v1/xxx 会 404 —— 这正是用户把文档里的
 *    Base URL（https://api.breeze.blue/v1）原样填进来时的真实表现。
 *  - 缺 xi-api-key 返回 401 + {code:'AUTH_REQUIRED'}，与线上一致。
 *  - output_format 只接受文档枚举，非法值 422。
 * 「什么都能过」的假上游会掩盖接入 bug，这个教训在本项目已经出现过一次。
 */
const VALID_FORMATS = /^(mp3|wav|flac|pcm|aac|opus)(_(\d{4,6})(_(\d{1,3}))?)?$/;

export function startTts() {
  return new Promise((resolve) => {
    const seen = [];   // 记录收到的请求，供测试断言「实际打到了哪个路径」
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const url = req.url.split('?')[0];
        seen.push({ method: req.method, url, headers: req.headers, query: req.url.split('?')[1] || '' });

        const json = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };

        // 重复的 /v1/v1 前缀：真实网关会 404，这里也 404
        if (url.startsWith('/v1/v1/')) return json(404, { detail: 'Not Found' });

        if (url.startsWith('/v1/voices')) {
          if (!req.headers['xi-api-key']) return json(401, { ok: false, code: 'AUTH_REQUIRED', detail: 'Authentication required.' });
          return json(200, {
            voices: [{
              voice_id: 'voc_fake', name: 'Fake Voice', language_code: 'zh',
              gender: 'female', origin: 'default', voice_type: 'default', tone: ['calm'],
              preview_url: null, description: null,
            }],
            has_more: false, next_page_token: null, total: 1, page: 1, page_size: 50,
          });
        }
        if (url.startsWith('/v1/voice-previews/clone')) {
          if (!req.headers['xi-api-key']) return json(401, { ok: false, code: 'AUTH_REQUIRED' });
          return json(200, { generated_voice_id: 'gvi_fake' });
        }
        if (url.includes('/voice-previews/') && url.endsWith('/save')) {
          if (!req.headers['xi-api-key']) return json(401, { ok: false, code: 'AUTH_REQUIRED' });
          return json(200, { voice_id: 'voc_cloned', name: 'cloned' });
        }
        if (url.includes('/voice-previews/') && url.endsWith('/stream')) {
          res.writeHead(200, { 'content-type': 'audio/mpeg' });
          return res.end(Buffer.alloc(64));
        }
        if (url.includes('/text-to-speech/')) {
          if (!req.headers['xi-api-key']) return json(401, { ok: false, code: 'AUTH_REQUIRED' });
          // 校验 output_format 枚举，非法值按文档返回 422
          const fmt = new URLSearchParams(req.url.split('?')[1] || '').get('output_format') || 'mp3';
          if (!VALID_FORMATS.test(fmt)) {
            return json(422, { ok: false, code: 'VALIDATION_ERROR', detail: `Invalid output_format: ${fmt}` });
          }
          const body = raw.length ? JSON.parse(raw.toString()) : {};
          if (!body.text) return json(422, { ok: false, code: 'VALIDATION_ERROR', detail: 'text is required' });
          // 文档：speed 0.5–2.0，volume 0.01–2.0，guidance_scale 1.0–10.0
          const vs = body.voice_settings || {};
          if (vs.speed !== undefined && (vs.speed < 0.5 || vs.speed > 2)) {
            return json(422, { ok: false, code: 'VALIDATION_ERROR', detail: 'speed out of range' });
          }
          if (vs.volume !== undefined && (vs.volume < 0.01 || vs.volume > 2)) {
            return json(422, { ok: false, code: 'VALIDATION_ERROR', detail: 'volume out of range' });
          }
          if (vs.guidance_scale !== undefined && (vs.guidance_scale < 1 || vs.guidance_scale > 10)) {
            return json(422, { ok: false, code: 'VALIDATION_ERROR', detail: 'guidance_scale out of range' });
          }
          // 最小合法 WAV：44 字节头 + 静音
          const buf = Buffer.alloc(44 + 800);
          buf.write('RIFF', 0); buf.writeUInt32LE(36 + 800, 4); buf.write('WAVE', 8);
          buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
          buf.writeUInt16LE(1, 22); buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28);
          buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
          buf.writeUInt32LE(800, 40);
          res.writeHead(200, { 'content-type': 'audio/wav' });
          return res.end(buf);
        }
        json(404, { detail: 'Not Found' });
      });
    });
    s.seen = seen;
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
