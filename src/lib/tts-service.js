import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { audit } from './auth.js';
import { safeJson } from '../routes/configs.js';
import { synthesize, extForMime } from './tts.js';

/* 语音合成只有一个实现。
 *
 * 两个调用方需要同一件事：
 *   1. POST /api/tts —— 用户在气泡上点「转成语音」
 *   2. 聊天里的内联合成 —— 判定这条要发语音，生成完就地合成
 *
 * 如果各写一份，缓存键、参考音频回退、文件落盘规则迟早会漂。
 * 而漂了之后表现出来的是"同一条话，两个入口拿到两个不同音色的音频"，
 * 这种问题极难定位。所以逻辑只在这里。
 */

export const audioCacheKey = ({ text, voiceRefId, ttsId, speed, volume }) =>
  crypto.createHash('sha256')
    .update(`${text}\u0001${voiceRefId || ''}\u0001${ttsId || ''}\u0001${speed}\u0001${volume}`)
    .digest('hex')
    .slice(0, 40);

/** 合成相关的准备：解析 tts / voiceRef / 参数。调用方拿它做前置校验。 */
export function resolveVoiceTarget({ userId, language, tts, voiceRef }) {
  const s = safeJson(tts?.settings_json, {});
  let ref = voiceRef || null;
  if (!ref && tts?.kind === 'breezeblue') {
    ref = get('SELECT * FROM voice_refs WHERE user_id = ? AND is_default = 1', [userId]);
  }
  return {
    voiceRef: ref,
    speed: Number(s.speed ?? 1),
    volume: Number(s.volume ?? 1),
    instructions: String(s.instructions ?? ''),
    language: language || 'zh',
    remoteVoiceId: ref?.remote_voice_id || null,
  };
}

/**
 * 把一段文字合成为音频并落盘。
 *
 * 成功返回 { audioId, url, mime, bytes, cached }。
 * 失败**抛错**（错误信息是给用户看的中文），由调用方决定怎么呈现 ——
 * /api/tts 会转成 4xx/5xx，聊天流会发 tts_failed 事件并退回文字。
 *
 * @param {object} o
 * @param {string} o.userId
 * @param {string} [o.personaId]
 * @param {string} [o.messageId]  关联的消息，用于「这条消息的语音」
 * @param {string} o.text
 * @param {object} o.tts          已解密 apiKey 的 tts 配置行
 * @param {object} [o.voiceRef]   已选定的参考音色
 * @param {string} [o.ip]         写审计用
 */
export async function synthesizeToFile({
  userId, personaId = null, messageId = null, text, tts, voiceRef, language = 'zh', ip,
}) {
  if (!tts) {
    const err = new Error('还没有可用的 TTS 配置。请先到「语音设置」填写你自己的 TTS 服务地址与 API Key。');
    err.code = 'NO_TTS_CONFIG';
    throw err;
  }
  if (tts.kind === 'breezeblue' && !tts.apiKey) {
    const err = new Error('TTS 配置缺少 API Key');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const body = String(text || '').trim();
  if (!body) {
    const err = new Error('缺少要合成的文本');
    err.code = 'EMPTY_TEXT';
    throw err;
  }
  const clipped = body.length > 2000 ? body.slice(0, 2000) : body;

  const { voiceRef: ref, speed, volume, instructions, language: lang, remoteVoiceId } =
    resolveVoiceTarget({ userId, language, tts, voiceRef });

  if (tts.kind === 'breezeblue' && !remoteVoiceId) {
    const err = new Error('Breeze Blue 托管版需要一个 voice_id。请先在「语音设置」上传参考音频并点击「克隆到 Breeze」，或直接填写一个已有音色 ID。');
    err.code = 'NO_VOICE';
    throw err;
  }

  // 同一段文字 + 同一音色 + 同一参数 = 同一份音频，不重复烧 token
  const hash = audioCacheKey({ text: clipped, voiceRefId: ref?.id || remoteVoiceId, ttsId: tts.id, speed, volume });
  const cached = get(
    `SELECT * FROM tts_audio WHERE user_id = ? AND text_hash = ? AND status = 'ready'
     ORDER BY created_at DESC LIMIT 1`, [userId, hash]);
  if (cached?.file_path && fs.existsSync(cached.file_path)) {
    return {
      audioId: cached.id, url: `/api/audio/${cached.id}`,
      mime: cached.mime, bytes: cached.bytes, cached: true,
    };
  }

  const audioId = `aud_${crypto.randomUUID()}`;
  run(`INSERT INTO tts_audio (id,user_id,persona_id,message_id,tts_config_id,voice_ref_id,text_hash,text,
         status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [audioId, userId, personaId, messageId, tts.id, ref?.id || null, hash, clipped,
      'pending', Date.now()]);

  const fail = (msg) => {
    run('UPDATE tts_audio SET status=?, error=? WHERE id=?', ['failed', String(msg).slice(0, 500), audioId]);
    const err = new Error(msg);
    err.audioId = audioId;
    return err;
  };

  // 自托管版必须现取参考音频：它的音色是"从这段录音里学"的，不是 id
  let refAudio = null;
  let refText = '';
  if (tts.kind === 'breeze_local') {
    if (!ref?.file_path || !fs.existsSync(ref.file_path)) {
      const err = fail('自托管 breeze-tts-2 需要参考音频。请先在「语音设置」上传参考音频并填写参考文本。');
      err.code = 'NEED_REF_AUDIO';
      throw err;
    }
    refAudio = {
      buffer: fs.readFileSync(ref.file_path),
      mime: ref.mime || 'audio/wav',
      filename: path.basename(ref.file_path),
    };
    refText = ref.ref_text || '';
    if (!refText) {
      const err = fail('自托管 breeze-tts-2 需要「参考音频对应的文字」，否则无法对齐音色。请到「语音设置」补填。');
      err.code = 'NEED_REF_TEXT';
      throw err;
    }
  }

  let out;
  try {
    out = await synthesize({
      kind: tts.kind, baseUrl: tts.base_url, apiKey: tts.apiKey, text: clipped,
      model: tts.model, voiceId: remoteVoiceId, language: lang, speed, volume, instructions,
      refAudio, refText, cfgScale: safeJson(tts.settings_json, {}).cfgScale ?? 4,
      seed: safeJson(tts.settings_json, {}).seed ?? 42, timeoutMs: 120000,
    });
  } catch (e) {
    throw fail(e.message);
  }

  const ext = extForMime(out.mime);
  const dir = path.join(config.audioDir, userId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${audioId}.${ext}`);
  fs.writeFileSync(file, out.buffer);
  run('UPDATE tts_audio SET status=?, file_path=?, mime=?, bytes=? WHERE id=?',
    ['ready', file, out.mime, out.buffer.length, audioId]);
  audit(userId, 'tts.generate', { target: audioId, ip, meta: { chars: clipped.length, kind: tts.kind } });

  return { audioId, url: `/api/audio/${audioId}`, mime: out.mime, bytes: out.buffer.length, cached: false };
}
