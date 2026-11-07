import { safeRequest, readBody, buildMultipart } from './net.js';

/**
 * Two real BreezeTTS protocols are supported. We never guess a path: the adapter
 * is chosen explicitly, or auto-detected by probing the configured base URL.
 *
 *  A) breezeblue  — hosted Breeze Developer API (docs.breezeblue.ai)
 *     POST {base}/v1/text-to-speech/{voice_id}?output_format=mp3
 *     header: xi-api-key
 *     body:   { text, model_id, language_code, instructions, voice_settings:{speed,volume} }
 *     clone:  POST {base}/v1/voice-previews/clone (multipart: name, files)
 *             GET  {base}/v1/voice-previews/{generated_voice_id}/stream
 *             POST {base}/v1/voice-previews/{generated_voice_id}/save {voice_name, language_code}
 *     voices: GET  {base}/v1/voices
 *
 *  B) breeze_local — self-hosted breeze-tts-2 (breeze_infer.api)
 *     POST {base}/v1/audio/speech  multipart: text, ref_audio(file), ref_text, instruction, cfg_scale, seed
 *     returns audio bytes (WAV/PCM depending on server), or JSON with base64/url
 *     health: GET {base}/health
 */
export const TTS_KINDS = ['breezeblue', 'breeze_local'];

function trimBase(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/**
 * 把用户填的 base URL 归一化成「可以安全拼接 /v1/... 的根地址」。
 *
 * 官方文档（docs.breezeblue.ai/api-reference/introduction）把 Base URL 写作
 * `https://api.breeze.blue/v1`，用户照着文档填就会带上 `/v1` 后缀；
 * 而本文件所有端点都写作 `${base}/v1/xxx`。两者直接相加会得到
 * `/v1/v1/voices` —— 实测返回 404，表现为「语音模型接入失败」。
 * 这里统一剥掉用户误填的 `/v1`（含 `/v1/`），实际请求始终是 `/v1/...`。
 */
function apiBase(u) {
  return trimBase(u).replace(/\/v1$/i, '');
}

/**
 * Breeze Blue 的官方默认接入点。
 * 用户只填 API Key、留空地址时用它兜底，避免让人去猜该填什么。
 */
export const BREEZE_BLUE_DEFAULT_BASE = 'https://api.breeze.blue';

/**
 * output_format 只接受文档列出的枚举值。早期实现写死 'mp3'（合法），
 * 但用户/配置里可能带 `mp3_44100_192` 这类音质后缀或 `wav`，
 * 这里统一归一化，非法值回落到 'mp3'，避免 422。
 */
export function normalizeOutputFormat(fmt) {
  const v = String(fmt || '').trim().toLowerCase();
  if (!v) return 'mp3';
  const allowed = /^(mp3|wav|flac|pcm|aac|opus)(_(\d{4,6})(_(\d{1,3}))?)?$/;
  return allowed.test(v) ? v : 'mp3';
}

function normalizeMime(ct, fallback = 'audio/mpeg') {
  const c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (c.startsWith('audio/')) return c;
  if (c === 'application/octet-stream') return fallback;
  return fallback;
}

function extForMime(m) {
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('aac')) return 'aac';
  if (m.includes('flac')) return 'flac';
  if (m.includes('mp4')) return 'm4a';
  return 'mp3';
}
export { extForMime };

async function errFrom(res, buf, label) {
  let detail = '';
  try {
    const j = JSON.parse(buf.toString('utf8'));
    detail = j?.error?.message || j?.detail || j?.error || j?.message || j?.code || '';
    if (typeof detail === 'object') detail = JSON.stringify(detail);
  } catch {
    detail = buf.toString('utf8').slice(0, 300);
  }
  const e = new Error(`${label} 返回 ${res.statusCode}${detail ? `：${String(detail).slice(0, 300)}` : ''}`);
  e.statusCode = 502;
  e.upstreamStatus = res.statusCode;
  return e;
}

/**
 * Probe a base URL to work out which protocol it speaks.
 * 判断依据必须足够具体：只看 /health 返回 2xx 会误判（很多普通 Web 服务都有 /health）。
 *  - 托管版 Breeze Blue： /v1/voices 返回带 voices 数组的 JSON，或 401/403（说明该端点存在且要鉴权）
 *  - 自托管 breeze-tts-2： /v1/models 与 /health 同时可用，且 /v1/models 不需要 xi-api-key
 *
 * 两个坑（都实测踩过）：
 *  1. 探测必须**串行**。曾经把两个探测写成并发 IIFE，对 api.breeze.blue 会直接
 *     触发 UND_ERR_CONNECT_TIMEOUT —— 同一 host 并发建连时抢不到连接，结果
 *     托管版明明可用却探测成 null，用户看到的就是「连接失败」。
 *  2. 官方托管版的 /health 也返回 200（网关健康检查），所以不能只看 /health。
 *     关键区分点是 /v1/models：托管版返回 401，自托管版返回 200 + 模型数组。
 */
export async function detectKind({ baseUrl, apiKey }) {
  const base = apiBase(baseUrl);

  // 1) 先问托管版的音色接口 —— 这是最具体的信号
  try {
    const { res } = await safeRequest(`${base}/v1/voices?page_size=1`, {
      method: 'GET', headers: apiKey ? { 'xi-api-key': apiKey } : {}, timeoutMs: 20000,
    });
    const buf = await readBody(res, 1024 * 1024);
    if ([401, 403].includes(res.statusCode)) return 'breezeblue'; // 端点存在且要求鉴权
    if (res.statusCode === 200) {
      try {
        const json = JSON.parse(buf.toString('utf8'));
        if (Array.isArray(json?.voices)) return 'breezeblue';
      } catch { /* 不是 JSON，继续往下判 */ }
    }
  } catch { /* 网络问题，继续探测自托管 */ }

  // 2) 再判自托管：/v1/models 必须免鉴权可用（200 + 数组）
  try {
    const { res } = await safeRequest(`${base}/v1/models`, { method: 'GET', timeoutMs: 12000 });
    const buf = await readBody(res, 1024 * 1024);
    if (res.statusCode !== 200) return null;
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { return null; }
    const isModelList = Array.isArray(json) || Array.isArray(json?.models) || Array.isArray(json?.data);
    if (!isModelList) return null;
    // 再用 /health 交叉确认，两者都过才算自托管
    const h = await safeRequest(`${base}/health`, { method: 'GET', timeoutMs: 10000 });
    await h.res.body.dump().catch(() => {});
    return h.res.statusCode >= 200 && h.res.statusCode < 400 ? 'breeze_local' : null;
  } catch { return null; }
}

export async function listVoices({ kind, baseUrl, apiKey }) {
  if (kind === 'breeze_local') {
    const { res } = await safeRequest(`${apiBase(baseUrl)}/v1/models`, { method: 'GET', timeoutMs: 15000 });
    const buf = await readBody(res, 1024 * 1024);
    if (res.statusCode >= 400) throw errFrom(res, buf, 'TTS 服务');
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* ignore */ }
    // local server has no voice catalog; it uses reference audio per request
    return { voices: [], note: '自托管 breeze-tts-2 通过每次请求上传参考音频，无预设音色列表', raw: json };
  }
  const { res } = await safeRequest(`${apiBase(baseUrl)}/v1/voices?page_size=100`, {
    method: 'GET', headers: { 'xi-api-key': apiKey || '' }, timeoutMs: 30000,
  });
  const buf = await readBody(res, 4 * 1024 * 1024);
  if (res.statusCode >= 400) throw errFrom(res, buf, 'TTS 服务');
  const json = JSON.parse(buf.toString('utf8'));
  return {
    voices: (json.voices || []).map((v) => ({
      voiceId: v.voice_id, name: v.name, language: v.language_code, gender: v.gender,
      origin: v.origin, previewUrl: v.preview_url, description: v.description,
    })),
    raw: json,
  };
}

/**
 * Synthesize speech. Returns { buffer, mime }.
 * kind: 'breezeblue' | 'breeze_local'
 */
export async function synthesize({
  kind, baseUrl, apiKey, text, model, voiceId, language = 'zh',
  speed = 1.0, volume = 1.0, guidanceScale = null, useSpeakerBoost = false,
  outputFormat = 'mp3', instructions = '', refAudio = null, refText = '', cfgScale = 4, seed = 42,
  timeoutMs = 120000, signal,
}) {
  const base = apiBase(baseUrl);
  const voiceSettings = clampVoiceSettings({ speed, volume, guidanceScale, useSpeakerBoost });

  if (kind === 'breeze_local') {
    if (!refAudio) {
      throw Object.assign(new Error('自托管 breeze-tts-2 需要参考音频（ref_audio）。请先上传参考音频并填写参考文本。'), { statusCode: 400 });
    }
    const fields = { text, cfg_scale: String(cfgScale) };
    if (refText) fields.ref_text = refText;
    if (instructions) fields.instruction = instructions;
    if (seed !== null && seed !== undefined) fields.seed = String(seed);
    const mp = buildMultipart(fields, [{
      name: 'ref_audio',
      filename: refAudio.filename || 'reference.wav',
      mime: refAudio.mime || 'audio/wav',
      buffer: refAudio.buffer,
    }]);

    const { res } = await safeRequest(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { accept: 'audio/*,application/json', 'content-type': mp.contentType },
      body: mp.body, timeoutMs, signal,
    });
    const buf = await readBody(res, 64 * 1024 * 1024);
    const ct = String(res.headers['content-type'] || '');
    if (res.statusCode >= 400) throw errFrom(res, buf, 'TTS 服务');
    if (ct.includes('application/json')) {
      let json; try { json = JSON.parse(buf.toString('utf8')); } catch { throw new Error('TTS 返回了无法解析的 JSON'); }
      if (json.audio_base64) {
        return { buffer: Buffer.from(json.audio_base64, 'base64'), mime: 'audio/wav' };
      }
      throw new Error('TTS 返回 JSON 但未包含 audio_base64，请检查服务端配置');
    }
    const mime = normalizeMime(ct, 'audio/wav');
    // raw s16le stream has no container -> wrap as wav for browser playback
    if (mime === 'audio/pcm' || ct.includes('pcm')) {
      return { buffer: pcmToWav(buf, 24000, 1, 16), mime: 'audio/wav' };
    }
    return { buffer: buf, mime };
  }

  // --- hosted Breeze Blue ---
  if (!voiceId) {
    throw Object.assign(new Error('请先选择或创建一个音色（voice_id）'), { statusCode: 400 });
  }
  // 实测（2026-11）总结出的真实契约，和文档有出入，以实测为准：
  //   • output_format 只能放 query string。放进 body 会被 422 拒绝
  //     （{"code":"VALIDATION_ERROR","detail":"Extra inputs are not permitted"}）。
  //   • body 只接受 text / model_id / language_code / instructions / voice_settings。
  //     language 会被拒（要 language_code），model 会被拒（要 model_id）。
  //   • model_id 必须是 /v1/models 里的值，ElevenLabs 那种
  //     eleven_multilingual_v2 会 400。
  //   • 服务端偶发直接断连（curl 表现为 000），重试一次基本就好了 ——
  //     用户看到的「连接失败」很大一部分其实是这个，不是配置错。
  const qs = new URLSearchParams({ output_format: normalizeOutputFormat(outputFormat) });
  const body = {
    text,
    ...(model ? { model_id: model } : {}),
    ...(language ? { language_code: String(language).slice(0, 2) } : {}),
    ...(instructions ? { instructions } : {}),
    // 文档：speed 0.5–2.0、volume 0.01–2.0、guidance_scale 1.0–10.0。
    // 超出范围会被 422 拒绝，这里夹紧而不是原样透传。
    ...(voiceSettings && Object.keys(voiceSettings).length
      ? { voice_settings: voiceSettings }
      : {}),
  };
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?${qs}`;
  const payload = JSON.stringify(body);
  const headers = { 'xi-api-key': apiKey || '', 'content-type': 'application/json', accept: 'audio/*' };

  // 上游偶发 socket 直接断掉（不是 HTTP 错误码）。合成是幂等的，
  // 重试不会产生副作用，所以这里做 2 次尝试。
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { res } = await safeRequest(url, {
        method: 'POST', headers, body: payload, timeoutMs, signal,
      });
      const buf = await readBody(res, 64 * 1024 * 1024);
      if (res.statusCode >= 400) throw errFrom(res, buf, 'TTS 服务');
      return { buffer: buf, mime: normalizeMime(res.headers['content-type'], 'audio/mpeg') };
    } catch (e) {
      lastErr = e;
      // 413/422/400 这类是参数问题，重试没意义，直接抛
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) throw e;
      if (attempt === 1) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

/** 按官方范围夹紧 voice_settings，避免越界参数导致 422。 */
export function clampVoiceSettings({ speed, volume, guidanceScale, useSpeakerBoost } = {}) {
  const out = {};
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const sp = num(speed);
  if (sp !== null && Number.isFinite(sp) && sp !== 1) out.speed = Math.min(2, Math.max(0.5, sp));
  const vol = num(volume);
  if (vol !== null && Number.isFinite(vol) && vol !== 1) out.volume = Math.min(2, Math.max(0.01, vol));
  const gs = num(guidanceScale);
  if (gs !== null && Number.isFinite(gs)) out.guidance_scale = Math.min(10, Math.max(1, gs));
  if (useSpeakerBoost) out.use_speaker_boost = true;
  return out;
}

/** Wrap raw 16-bit PCM into a RIFF/WAVE container. */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Clone a voice from reference audio (hosted Breeze Blue only).
 * Two-step: create preview -> save. Returns { voiceId, previewId }.
 */
export async function cloneVoice({
  baseUrl, apiKey, name, audioBuffer, mime, filename, language = 'zh', removeBackgroundNoise = false,
}) {
  const base = apiBase(baseUrl);
  const fields = { name: name || 'EchoPersona Clone', reference_language_code: String(language).slice(0, 2) };
  // 文档：样本有底噪时可开启降噪；降噪不可用时服务端会用原样本
  if (removeBackgroundNoise) fields.remove_background_noise = 'true';
  const mp = buildMultipart(fields, [{
    name: 'files',
    filename: filename || 'reference.wav',
    mime: mime || 'audio/wav',
    buffer: audioBuffer,
  }]);

  const { res } = await safeRequest(`${base}/v1/voice-previews/clone`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey || '', 'content-type': mp.contentType },
    body: mp.body, timeoutMs: 180000,
  });
  const buf = await readBody(res, 4 * 1024 * 1024);
  if (res.statusCode >= 400) throw errFrom(res, buf, '声音克隆');
  const json = JSON.parse(buf.toString('utf8'));
  const generatedVoiceId = json.generated_voice_id || json.generatedVoiceId;
  if (!generatedVoiceId) throw new Error('声音克隆返回缺少 generated_voice_id');

  const saveRes = await safeRequest(`${base}/v1/voice-previews/${encodeURIComponent(generatedVoiceId)}/save`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey || '', 'content-type': 'application/json' },
    body: JSON.stringify({ voice_name: (name || 'EchoPersona Clone').slice(0, 80), language_code: String(language).slice(0, 2) }),
    timeoutMs: 60000,
  });
  const saveBuf = await readBody(saveRes.res, 1024 * 1024);
  if (saveRes.res.statusCode >= 400) throw errFrom(saveRes.res, saveBuf, '声音克隆保存');
  const saved = JSON.parse(saveBuf.toString('utf8'));
  return { voiceId: saved.voice_id || saved.voiceId, previewId: generatedVoiceId, raw: saved };
}

export async function deleteVoice({ baseUrl, apiKey, voiceId }) {
  const base = apiBase(baseUrl);
  const { res } = await safeRequest(`${base}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE', headers: { 'xi-api-key': apiKey || '' }, timeoutMs: 30000,
  });
  await res.body.dump().catch(() => {});
  if (res.statusCode >= 400) {
    const e = new Error(`删除远端音色失败（${res.statusCode}）`);
    e.statusCode = 502;
    throw e;
  }
  return true;
}

export async function previewVoiceStream({ baseUrl, apiKey, generatedVoiceId }) {
  const base = apiBase(baseUrl);
  const { res } = await safeRequest(
    `${base}/v1/voice-previews/${encodeURIComponent(generatedVoiceId)}/stream?output_format=mp3`,
    { method: 'GET', headers: { 'xi-api-key': apiKey || '' }, timeoutMs: 60000 }
  );
  const buf = await readBody(res, 16 * 1024 * 1024);
  if (res.statusCode >= 400) throw errFrom(res, buf, '试听');
  return { buffer: buf, mime: normalizeMime(res.headers['content-type'], 'audio/mpeg') };
}
