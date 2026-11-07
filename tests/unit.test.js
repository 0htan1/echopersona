import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTxt, parseJson, parseCsv, parseMarkdown, parseTimestamp, hashMessage,
  detectFormat, parseChatFile,
} from '../src/lib/parsers.js';
import { extractZip, isSupportedFile } from '../src/lib/zip.js';
import { buildZip } from '../src/lib/samples.js';
import { chunkMessages, tokenizeForIndex, toFtsQuery } from '../src/lib/memory.js';
import {
  computeStyleStats, parseProfileJson, normalizeProfile,
  computeVoiceStats, describeVoiceStats, normalizeSpeakingStyle,
  buildChatMessages, compactHistory, CONTEXT_BUDGET,
} from '../src/lib/persona.js';
import { encryptSecret, decryptSecret, hashPassword, verifyPassword, maskSecret } from '../src/lib/crypto.js';
import { isPrivateIp, validateUpstreamUrl } from '../src/lib/net.js';
import { decideSpeak, decideSpeakUpfront, ttsReady, normalizeVoiceMode, sanitizeSpokenText } from '../src/lib/voice-mode.js';
import { splitIntoMessages, MAX_BUBBLES } from '../src/lib/split-messages.js';

/* ---------------------------------------------------------- parsers */
test('TXT: WeChat "date time speaker" on its own line', () => {
  const raw = `2024-03-12 21:04:33 林小满
今天下班又是十点半。

2024-03-12 21:05:02 我
又加班？

2024-03-12 21:05:41 林小满
害，习惯了。`;
  const r = parseTxt(raw);
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].sender, '林小满');
  assert.equal(r.messages[0].content, '今天下班又是十点半。');
  assert.equal(r.messages[1].sender, '我');
  assert.ok(r.messages[0].ts > 0);
  assert.equal(r.senders[0].name, '林小满');
  assert.equal(r.senders[0].count, 2);
});

test('TXT: inline "[date] speaker: content"', () => {
  const raw = `[2024-03-12 21:04] 张三: 你好啊
[2024-03-12 21:05] 李四: 嗯，你呢`;
  const r = parseTxt(raw);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].sender, '张三');
  assert.equal(r.messages[0].content, '你好啊');
});

test('TXT: multi-line message body is joined', () => {
  const raw = `2024-03-12 21:04:33 甲
第一行
第二行
第三行`;
  const r = parseTxt(raw);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].content, '第一行\n第二行\n第三行');
});

test('TXT: media placeholders become typed messages', () => {
  const raw = `2024-03-12 21:04:33 甲
[图片]
2024-03-12 21:05:33 乙
收到`;
  const r = parseTxt(raw);
  assert.equal(r.messages[0].type, 'image');
  assert.equal(r.messages[1].content, '收到');
});

test('JSON: array with common key names', () => {
  const raw = JSON.stringify([
    { from: 'A', text: 'hello', timestamp: 1710000000000 },
    { from: 'B', text: 'hi', timestamp: 1710000060000 },
  ]);
  const r = parseJson(raw);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].sender, 'A');
  assert.equal(r.messages[0].content, 'hello');
});

test('JSON: nested messages key + unix seconds', () => {
  const raw = JSON.stringify({ data: { messages: [{ sender: 'X', content: 'yo', time: 1710000000 }] } });
  const r = parseJson(raw);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].ts, 1710000000000);
});

test('JSON: Chinese keys', () => {
  const raw = JSON.stringify([{ 发送者: '小明', 内容: '在吗', 时间: '2024-01-01 10:00:00' }]);
  const r = parseJson(raw);
  assert.equal(r.messages[0].sender, '小明');
  assert.equal(r.messages[0].content, '在吗');
});

test('JSON: throws a helpful error for unusable structure', () => {
  assert.throws(() => parseJson('{"foo": 1}'), /未找到消息数组/);
  assert.throws(() => parseJson('not json'), /JSON 解析失败/);
});

test('CSV: header detection with sender/content', () => {
  const raw = `sender,timestamp,content
甲,2024-03-12 21:04:09,你好
乙,2024-03-12 21:05:09,嗯`;
  const r = parseCsv(raw);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].sender, '甲');
  assert.equal(r.messages[0].content, '你好');
});

test('CSV: quoted fields with commas and newlines', () => {
  const raw = `sender,content\n甲,"你好，世界"\n乙,"多行\n内容"`;
  const r = parseCsv(raw);
  assert.equal(r.messages[0].content, '你好，世界');
  assert.equal(r.messages[1].content, '多行\n内容');
});

test('CSV: tab delimiter auto-detected', () => {
  const raw = `sender\tcontent\n甲\thi`;
  const r = parseCsv(raw);
  assert.equal(r.messages.length, 1);
  assert.equal(r.delimiter, '\t');
});

test('Markdown: bold label style', () => {
  const raw = `**甲**: 你好\n**乙**: 嗯嗯\n**甲**: 在吗`;
  const r = parseMarkdown(raw);
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].sender, '甲');
  assert.equal(r.messages[0].content, '你好');
});

test('Markdown: heading sections', () => {
  const raw = `## 甲\n今天不错\n\n## 乙\n是啊`;
  const r = parseMarkdown(raw);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].sender, '甲');
  assert.equal(r.messages[0].content, '今天不错');
});

test('timestamp parsing: several formats', () => {
  assert.ok(parseTimestamp('2024-03-12 21:04:33') > 0);
  assert.ok(parseTimestamp('2024/3/12 下午 9:04') > 0);
  const pm = parseTimestamp('2024-03-12 下午9:04');
  assert.equal(new Date(pm).getUTCHours(), 21);
  assert.equal(parseTimestamp('not a date'), null);
  assert.equal(parseTimestamp('2024-13-45 99:99'), null);
});

test('format detection by extension and content sniffing', () => {
  assert.equal(detectFormat('a.json', ''), 'json');
  assert.equal(detectFormat('a.csv', ''), 'csv');
  assert.equal(detectFormat('a.md', ''), 'markdown');
  assert.equal(detectFormat('a.txt', ''), 'txt');
  assert.equal(detectFormat('unknown', '[{"a":1}]'), 'json');
});

test('parseChatFile routes correctly', () => {
  const r = parseChatFile({
    filename: 'x.txt',
    buffer: Buffer.from('2024-01-01 10:00 甲\n你好'),
  });
  assert.equal(r.format, 'txt');
  assert.equal(r.messages.length, 1);
});

test('hashMessage is stable and content-sensitive', () => {
  const a = hashMessage({ sender: 'x', ts: 1, content: 'hi' });
  const b = hashMessage({ sender: 'x', ts: 1, content: 'hi' });
  const c = hashMessage({ sender: 'x', ts: 1, content: 'hi!' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

/* -------------------------------------------------------------- zip */
test('ZIP: extract stored entries', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'sub/b.txt', data: Buffer.from('world') },
  ]);
  const out = extractZip(zip);
  assert.equal(out.length, 2);
  assert.equal(out[0].data.toString(), 'hello');
  assert.equal(out[1].data.toString(), 'world');
  assert.ok(out[0].crcOk);
});

test('ZIP: rejects garbage', () => {
  assert.throws(() => extractZip(Buffer.from('not a zip at all')), /不是有效的 ZIP/);
});

test('ZIP: entry count limit enforced', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }));
  const zip = buildZip(files);
  assert.throws(() => extractZip(zip, { maxEntries: 2 }), /文件过多/);
});

test('isSupportedFile', () => {
  assert.ok(isSupportedFile('a.txt'));
  assert.ok(isSupportedFile('a.JSON'));
  assert.ok(!isSupportedFile('a.db'));
});

/* ----------------------------------------------------------- memory */
test('chunking respects char budget and time gaps', () => {
  // two short messages with a small gap -> one chunk
  const tight = chunkMessages([
    { role: 'user', content: 'a'.repeat(100), ts: 1000, seq: 1 },
    { role: 'persona', content: 'b'.repeat(100), ts: 2000, seq: 2 },
  ], { maxChars: 600, maxGapMin: 60, minChars: 50 });
  assert.equal(tight.length, 1);
  assert.ok(tight[0].content.includes('我: aaa'));
  assert.ok(tight[0].content.includes('TA: bbb'));

  // same messages, huge time gap -> split
  const gapped = chunkMessages([
    { role: 'user', content: 'a'.repeat(100), ts: 1000, seq: 1 },
    { role: 'persona', content: 'b'.repeat(100), ts: 900000000, seq: 2 },
  ], { maxChars: 600, maxGapMin: 60, minChars: 50 });
  assert.equal(gapped.length, 2);

  // over-budget -> split even without a gap
  const big = chunkMessages([
    { role: 'user', content: 'a'.repeat(400), ts: 1000, seq: 1 },
    { role: 'persona', content: 'b'.repeat(400), ts: 2000, seq: 2 },
  ], { maxChars: 600, maxGapMin: 9999, minChars: 50 });
  assert.equal(big.length, 2);
  assert.ok(big[0].content.includes('我: aaa'));
  assert.ok(big[1].content.includes('TA: bbb'));
});

test('tokenizer produces CJK bigrams and latin words', () => {
  const t = tokenizeForIndex('今天天气不错 hello');
  assert.ok(t.includes('今天'));
  assert.ok(t.includes('天天') || t.includes('气不'));
  assert.ok(t.includes('hello'));
});

test('fts query builder escapes and ORs tokens', () => {
  const q = toFtsQuery('她说"随便"');
  assert.ok(q.includes(' OR '));
  assert.ok(q.includes('""') === false || q.length > 0);
  assert.equal(toFtsQuery(''), null);
});

test('TXT: voice messages keep transcript and voice marker', () => {
  // 微信导出的两种写法：转文字独立成行、和 [语音] 挤在同一行。
  const raw = `2024-03-12 21:04:33 林小满
[语音] 12"
[语音转文字] 你在干嘛呀

2024-03-12 21:05:02 我
在加班

2024-03-12 21:05:41 林小满
[语音] 8" [语音转文字] 又加班啊你

2024-03-12 21:06:10 林小满
[语音] 5"`;
  const r = parseTxt(raw);
  const voices = r.messages.filter((m) => m.type === 'audio');
  assert.equal(voices.length, 3);
  // 转写文本就是 content，时长（12"）不能混进去
  assert.equal(voices[0].content, '你在干嘛呀');
  assert.equal(voices[0].voiceTranscript, true);
  assert.ok(!voices[0].content.includes('12'));
  assert.equal(voices[1].content, '又加班啊你');
  assert.equal(voices[1].voiceTranscript, true);
  // 纯语音也要留下：没有转写的空内容语音是「爱发语音」的证据
  assert.equal(voices[2].content, '');
  assert.equal(voices[2].voiceTranscript, false);
});

test('voice stats describe spoken language, not typed language', () => {
  const lines = [
    { content: '你在干嘛呀' },
    { content: '嗯嗯好' },
    { content: '我跟你说 那个 就是有点烦' },
    { content: '好好好' },
  ];
  const s = computeVoiceStats(lines);
  assert.equal(s.sampleCount, 4);
  assert.ok(s.avgLength > 0);
  // 口语样本句末基本没有标点，这个比例必须接近 100
  assert.equal(s.noPunctRatio, 100);
  assert.ok(s.shortRatio > 0);
  assert.ok(s.fillers.some((f) => f.word === '嗯' || f.word === '就是'));
  assert.ok(s.repeatRatio > 0);

  const text = describeVoiceStats(s, { audioCount: 4, total: 10, share: 0.4 });
  assert.ok(text.includes('语音样本 4 条'));
  assert.ok(text.includes('40%'));
});

test('computeVoiceStats returns null for no samples', () => {
  assert.equal(computeVoiceStats([]), null);
  assert.equal(computeVoiceStats([{ content: '  ' }]), null);
  assert.equal(describeVoiceStats(null), '');
});

test('normalizeSpeakingStyle keeps evidence and defaults the rest', () => {
  const s = normalizeSpeakingStyle({
    has_voice_evidence: true,
    voice_tone: '懒洋洋的',
    fillers: ['嗯', '就是'],
    opening: ['那个'],
    ending: [],
    sentence_length: '很短',
  });
  assert.equal(s.hasVoiceEvidence, true);
  assert.equal(s.voiceTone, '懒洋洋的');
  assert.deepEqual(s.fillers, ['嗯', '就是']);
  assert.deepEqual(s.ending, []);
  assert.equal(s.sentenceLength, '很短');

  // 档案里没有这个字段时的兜底（旧档案、模型漏输出）
  const empty = normalizeSpeakingStyle(undefined);
  assert.equal(empty.hasVoiceEvidence, false);
  assert.deepEqual(empty.fillers, []);
  assert.equal(empty.voiceTone, '');
});

/* ---------------------------------------------------------- persona */
test('style stats compute plausible numbers', () => {
  const lines = [
    { content: '害，习惯了哈哈哈' },
    { content: '你呢？今天吃得还行吗' },
    { content: '好啊' },
    { content: '真的假的！！' },
  ];
  const s = computeStyleStats(lines);
  assert.equal(s.sampleCount, 4);
  assert.ok(s.avgLength > 0);
  assert.ok(s.questionRatio > 0);
  assert.ok(s.fillers.length > 0);
  assert.equal(s.emojiRatio, 0);
});

test('profile JSON parsing tolerates markdown fences', () => {
  const raw = '```json\n{"summary":"test","memory":[]}\n```';
  const p = parseProfileJson(raw);
  assert.ok(p);
  assert.equal(p.summary, 'test');
});

test('normalizeProfile clamps confidence and fills arrays', () => {
  const p = normalizeProfile({
    summary: 'x',
    personality: { traits: [{ trait: 'nice', confidence: 5 }, { trait: '', confidence: 0.5 }] },
    memories: [{ kind: 'bogus', content: 'm1', salience: 99, confidence: -1 }],
  });
  assert.equal(p.personality.traits.length, 1);
  assert.equal(p.personality.traits[0].confidence, 1);
  assert.equal(p.memories[0].kind, 'fact');
  assert.equal(p.memories[0].salience, 5);
  assert.equal(p.memories[0].confidence, 0);
  assert.deepEqual(p.language_style.favorite_words, []);
});

/* ------------------------------------------------------- voice mode */
test('decideSpeak: text mode never speaks', () => {
  assert.equal(decideSpeak({ mode: 'text', share: 0.9 }).speak, false);
  assert.equal(decideSpeak({ mode: 'text', voiceReady: true, content: 'hi' }).reason, 'text-mode');
});

test('decideSpeak: voice mode speaks short content', () => {
  const r = decideSpeak({ mode: 'voice', voiceReady: true, content: '你在干嘛呀' });
  assert.equal(r.speak, true);
  assert.equal(r.reason, 'voice-mode');
});

test('decideSpeak: refuses to speak when TTS is not ready', () => {
  // 没配好音色却发语音，用户只会撞一个 400，所以这里必须退回文字
  const r = decideSpeak({ mode: 'voice', voiceReady: false, content: '你在干嘛呀' });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'voice-not-ready');
});

test('decideSpeak: long content falls back to text', () => {
  const r = decideSpeak({ mode: 'voice', voiceReady: true, content: '啊'.repeat(121) });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'too-long');
});

test('decideSpeak: mixed mode was removed, so it can never speak', () => {
  // 曾经的「随机」档按历史语音占比掷骰子，实测几乎总是落回文字，
  // 用户体感就是开关坏了。它被彻底删掉：任何残留的 'mixed' 都归一化成
  // text，绝不能凭一个用户无法预测的随机去决定发不发语音。
  const r = decideSpeak({
    mode: 'mixed', share: 0.9, sampleCount: 50, voiceReady: true, content: '嗯', rand: () => 0,
  });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'text-mode');
});

test('decideSpeakUpfront: never speaks in text or when TTS is missing', () => {
  // 这两条以前藏在 mixed 分支里，删掉 mixed 之后必须仍然成立：
  // 文字模式不发语音；TTS 没配好也不发语音（否则用户只会撞一个 400）。
  assert.deepEqual(decideSpeakUpfront({ mode: 'text', voiceReady: true }), {
    speak: false, reason: 'text-mode',
  });
  assert.deepEqual(decideSpeakUpfront({ mode: 'voice', voiceReady: false }), {
    speak: false, reason: 'voice-not-ready',
  });
  assert.deepEqual(decideSpeakUpfront({ mode: 'voice', voiceReady: true }), {
    speak: true, reason: 'voice-mode',
  });
});

test('ttsReady checks the pieces each TTS kind needs', () => {
  assert.equal(ttsReady({ tts: null }).reason, 'NO_TTS_CONFIG');
  // Breeze Blue 托管版要 voice_id 和 apiKey
  assert.equal(ttsReady({ tts: { kind: 'breezeblue', apiKey: 'k' }, voiceRef: null }).reason, 'NO_VOICE');
  assert.equal(ttsReady({ tts: { kind: 'breezeblue' }, voiceRef: { remote_voice_id: 'v1' } }).reason, 'NO_API_KEY');
  assert.equal(ttsReady({
    tts: { kind: 'breezeblue', apiKey: 'k' }, voiceRef: { remote_voice_id: 'v1' },
  }).ready, true);
  // 自托管要参考音频 + 参考文本
  assert.equal(ttsReady({
    tts: { kind: 'breeze_local' }, voiceRef: { remote_voice_id: null },
  }).reason, 'NEED_REF_AUDIO');
  assert.equal(ttsReady({
    tts: { kind: 'breeze_local' }, voiceRef: { file_path: '/tmp/a.wav' },
  }).reason, 'NEED_REF_TEXT');
  assert.equal(ttsReady({
    tts: { kind: 'breeze_local' }, voiceRef: { file_path: '/tmp/a.wav', ref_text: '你好' },
  }).ready, true);
});

test('normalizeVoiceMode rejects unknown values and retires mixed', () => {
  assert.equal(normalizeVoiceMode('voice'), 'voice');
  assert.equal(normalizeVoiceMode('text'), 'text');
  // 老数据里可能存过 mixed，必须落回 text，否则前端两个按钮都不高亮
  assert.equal(normalizeVoiceMode('mixed'), 'text');
  assert.equal(normalizeVoiceMode('nonsense'), 'text');
  assert.equal(normalizeVoiceMode(undefined), 'text');
  assert.equal(normalizeVoiceMode(null), 'text');
});

/* ------------------------------------------------- contextual budget */
test('compactHistory: keeps recent turns and drops the oldest under budget', () => {
  // 这组数据的用意：单看条数只有 20 条，看起来"不多"，
  // 但每条 500 字 → 总共 1 万字，远超预算。旧的实现会整包塞进去。
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? 'persona' : 'user',
    content: `第${i}条`.padEnd(500, '啊'),
  }));
  const r = compactHistory(history);

  assert.ok(r.dropped > 0, '超预算时必须真的丢掉一些历史');
  assert.equal(r.dropped + r.kept.length, 20, '丢掉的 + 保留的必须等于总数');
  // 预算内的总量不能超过上限（除非只剩最小保留条数）
  assert.ok(r.chars <= CONTEXT_BUDGET.maxHistoryChars + CONTEXT_BUDGET.maxMessageChars);

  // 保留的必须是"最近的那些"：最后一条一定在，最早的一条一定不在
  assert.equal(r.kept[r.kept.length - 1].content.slice(0, 4), '第19条');
  assert.ok(!r.kept.some((m) => m.content.startsWith('第0条')), '最老的一条应被丢弃');
});

test('compactHistory: always keeps a minimum of recent messages', () => {
  // 极端情况：光最近一条就超预算。这时候不能把历史清空 ——
  // 模型不知道刚才在聊什么，回复会完全答非所问。
  const history = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'persona' : 'user',
    content: `${i}`.padEnd(CONTEXT_BUDGET.maxHistoryChars, 'x'),
  }));
  const r = compactHistory(history);
  assert.ok(r.kept.length >= CONTEXT_BUDGET.minRecentMessages,
    `至少要留 ${CONTEXT_BUDGET.minRecentMessages} 条，实际留了 ${r.kept.length}`);
});

test('compactHistory: a single huge message is clipped, not carried whole', () => {
  // 一条 8000 字的长文会一个人吃掉全部预算，把它截断比丢掉整段上下文划算
  const history = [{ role: 'user', content: 'a'.repeat(8000) }];
  const r = compactHistory(history);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].content.length, CONTEXT_BUDGET.maxMessageChars);
  assert.ok(r.kept[0].content.endsWith('…'), '截断后要有省略号，用户/模型才知道还有下文');
  assert.equal(r.clipped, 1);
});

test('compactHistory: role is mapped to the OpenAI roles', () => {
  // 库里存的是 'user' / 'persona'，发给模型时必须是 user / assistant。
  // 弄错这一层，模型会把自己的历史回复当成用户说的话，模仿直接崩。
  const r = compactHistory([
    { role: 'user', content: '在吗' },
    { role: 'persona', content: '在' },
  ]);
  assert.deepEqual(r.kept.map((m) => m.role), ['user', 'assistant']);
});

test('buildChatMessages: system prompt comes first and the user turn comes last', () => {
  const msgs = buildChatMessages({
    systemPrompt: 'SYS', history: [{ role: 'user', content: 'hi' }], userMessage: 'hello',
  });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[msgs.length - 1].role, 'user');
  assert.equal(msgs[msgs.length - 1].content, 'hello');
});

test('buildChatMessages: tells the model when earlier context was dropped', () => {
  // 不告诉它的话，模型会把被保留的第一条当成对话的起点，
  // 于是把「你之前说的那个事」当成凭空冒出来的新话题，甚至反问用户。
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'persona' : 'user',
    content: `${i}`.padEnd(600, '啊'),
  }));
  const msgs = buildChatMessages({ systemPrompt: 'SYS', history, userMessage: '然后呢' });
  assert.match(msgs[0].content, /上下文说明/);
  assert.match(msgs[0].content, /不要追问之前说过什么/);
});

test('buildChatMessages: no context note when nothing was dropped', () => {
  // 短对话不该背这个说明 —— 白占 token，还会让模型莫名觉得"丢过东西"
  const msgs = buildChatMessages({
    systemPrompt: 'SYS', history: [{ role: 'user', content: 'hi' }], userMessage: 'hello',
  });
  assert.ok(!msgs[0].content.includes('上下文说明'));
});

test('buildChatMessages: recallNote is appended to the user turn, never a separate message', () => {
  // 单独一条 system/user 会被模型当成"另一个人在说话"。
  const msgs = buildChatMessages({
    systemPrompt: 'SYS', history: [], userMessage: '在吗', recallNote: '记忆：她怕黑',
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, '在吗\n\n记忆：她怕黑');
});

test('encrypt/decrypt roundtrip', () => {
  const plain = 'sk-test-1234567890abcdef';
  const enc = encryptSecret(plain);
  assert.ok(enc.includes('.'));
  assert.notEqual(enc, plain);
  assert.equal(decryptSecret(enc), plain);
});

test('ciphertext is randomized (IV)', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test('tampered ciphertext fails', () => {
  const enc = encryptSecret('secret');
  const parts = enc.split('.');
  const bad = `${parts[0]}.${parts[1]}.${Buffer.from('tampered').toString('base64')}`;
  assert.throws(() => decryptSecret(bad));
});

test('maskSecret hides the middle', () => {
  const m = maskSecret('sk-abcdefghijklmnop');
  assert.ok(m.endsWith('mnop'));
  assert.ok(!m.includes('abcdefgh'));
});

test('password hashing verifies and rejects', async () => {
  const h = await hashPassword('correct horse 1');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse 1', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

/* -------------------------------------------------------------- SSRF */
test('isPrivateIp detects all reserved ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::3']) {
    assert.ok(isPrivateIp(ip), `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.18.0.1', '2606:4700::1111']) {
    assert.ok(!isPrivateIp(ip), `${ip} should be public`);
  }
});

test('validateUpstreamUrl rejects dangerous targets', async () => {
  await assert.rejects(() => validateUpstreamUrl('http://localhost:8080'), /本机|内部/);
  await assert.rejects(() => validateUpstreamUrl('http://127.0.0.1'), /内网|保留/);
  await assert.rejects(() => validateUpstreamUrl('http://169.254.169.254/latest/meta-data'), /内网|保留/);
  await assert.rejects(() => validateUpstreamUrl('file:///etc/passwd'), /http/);
  await assert.rejects(() => validateUpstreamUrl('ftp://x.com'), /http/);
  await assert.rejects(() => validateUpstreamUrl('not a url'), /不合法/);
  await assert.rejects(() => validateUpstreamUrl('http://foo.internal'), /内部域名/);
  await assert.rejects(() => validateUpstreamUrl('http://user:pass@example.com'), /用户名或密码/);
});

test('validateUpstreamUrl accepts public hosts', async () => {
  const r = await validateUpstreamUrl('https://api.openai.com/v1');
  assert.ok(r.url.href.startsWith('https://'));
  assert.ok(r.addresses.length > 0);
});

/* ------------------------------------------------ 发送者识别（去噪） */
test('TXT: 正文里带冒号的句子不能变成新人物', () => {
  // 曾经任何「词：内容」都会被 PLAIN 当成说话人 —— 一次导入就能
  // 凭空多出十几个"人物"，用户看到的就是「分析出来的多了很多人物」。
  const raw = `2024-03-12 21:04:33 林小满
今天下班又是十点半。
注意：明天要带伞

2024-03-12 21:05:02 我
又加班？
怎么说呢：其实也还好

2024-03-12 21:05:41 林小满
害，习惯了。`;
  const r = parseTxt(raw);
  assert.deepEqual(r.senders.map((s) => s.name).sort(), ['我', '林小满'].sort());
  // 内容不能丢，而且要归到说出它的人名下
  assert.ok(r.messages[0].content.includes('注意：明天要带伞'));
  assert.equal(r.messages[0].sender, '林小满');
});

test('TXT: 纯「昵称：内容」里只喊过一次的真人也要留下', () => {
  const raw = `林小满：你在干嘛呀
我：在加班
林小满：害 那你早点回来
说明：以下为系统提示
我：好
阿杰：我也在加班啊
林小满：每次都这样`;
  const r = parseTxt(raw);
  const names = r.senders.map((s) => s.name);
  assert.ok(names.includes('阿杰'), '只说过一句的第三人是真人，不能丢');
  assert.ok(!names.includes('说明'), '「说明：」是正文，不能算人');
});

test('TXT: 语音转写与时长写在同一行时仍认得出转写', () => {
  const raw = `林小满：[语音] 12" [语音转文字] 你在干嘛呀
我：在加班
林小满：[语音] 8" [语音转文字] 又加班啊你`;
  const r = parseTxt(raw);
  const voices = r.messages.filter((m) => m.type === 'audio');
  assert.equal(voices.length, 2);
  assert.equal(voices[0].content, '你在干嘛呀');
  assert.equal(voices[0].voiceTranscript, true);
  // 时长不能被当成内容，也不能把别人的话并进她的语音
  assert.ok(!voices[0].content.includes('12'));
  assert.ok(!voices[0].content.includes('在加班'));
});

/* ------------------------------------------- 多条消息拆分 / TTS 优化 */

test('拆分：用 ||| 分隔的多条回复拆成独立消息', () => {
  const out = splitIntoMessages('刚到家|||累死了|||你吃了吗');
  assert.deepEqual(out, ['刚到家', '累死了', '你吃了吗']);
});

test('拆分：没有分隔符就只返回一条', () => {
  assert.deepEqual(splitIntoMessages('在的'), ['在的']);
  assert.deepEqual(splitIntoMessages('今天有点忙，晚点聊'), ['今天有点忙，晚点聊']);
});

test('拆分：分隔符写坏了也能认（|||、|| 、| | |）', () => {
  assert.deepEqual(splitIntoMessages('嗯||好'), ['嗯', '好']);
  assert.deepEqual(splitIntoMessages('嗯 | | | 好'), ['嗯', '好']);
});

test('拆分：空输入返回空数组', () => {
  assert.deepEqual(splitIntoMessages(''), []);
  assert.deepEqual(splitIntoMessages('   '), []);
});

test('拆分：短行多行（无分隔符）按行拆，但长段落不拆', () => {
  assert.deepEqual(splitIntoMessages('在吗\n嗯\n怎么了'), ['在吗', '嗯', '怎么了']);
  // 长行是正常排版，不能当成多条
  const long = '这个事我想了一下，' + '其实也不算什么大问题，'.repeat(6);
  assert.equal(splitIntoMessages(long).length, 1);
});

test('拆分：超过 5 条会被截断，不会刷屏', () => {
  const out = splitIntoMessages('1|||2|||3|||4|||5|||6|||7');
  assert.equal(out.length, MAX_BUBBLES);
});

test('拆分：单条超长会按语义边界再切，且不丢内容', () => {
  const long = '这句话我要说很长很长。'.repeat(30);
  const out = splitIntoMessages(long);
  assert.ok(out.length > 1);
  // 切完拼回去（去掉分隔）内容不丢
  assert.equal(out.join('').replace(/\s/g, ''), long.replace(/\s/g, ''));
});

test('TTS：标点要保留（引擎靠它判断停顿），不能全删', () => {
  const out = sanitizeSpokenText('我本来想，算了。那就这样吧');
  assert.ok(out.includes('，'), '逗号必须保留，否则会一口气连读');
  assert.ok(out.includes('。'), '句号必须保留');
});

test('TTS：念不出来的符号要去掉', () => {
  const out = sanitizeSpokenText('他说“你好”然后《走了》～');
  assert.ok(!out.includes('“'));
  assert.ok(!out.includes('《'));
  assert.ok(!out.includes('～'));
});

test('TTS：连续标点收敛成一个，避免拖长音', () => {
  assert.equal(sanitizeSpokenText('真的吗！！！'), '真的吗！');
});

test('TTS：省略号和破折号归一成句号（引擎只认标准标点）', () => {
  assert.equal(sanitizeSpokenText('我想想……算了'), '我想想。算了');
});

test('TTS：分号冒号归一成逗号', () => {
  assert.equal(sanitizeSpokenText('两件事：吃饭；睡觉'), '两件事，吃饭，睡觉');
});
