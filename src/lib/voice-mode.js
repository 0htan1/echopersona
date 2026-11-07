/**
 * 输出形态决策：这条回复该发文字还是发语音。
 *
 * 用户要的不是「文字转语音」，而是「像真人那样，有时候打字、有时候发语音」。
 * 所以这里要做的不是把文本塞进 TTS，而是先决定「这一次到底是说还是打」。
 *
 * 两档：
 *   text  —— 只发文字
 *   voice —— 只发语音
 *
 * 曾经还有第三档 mixed（按这个人真实的语音比例随机掷骰子）。它被删掉了：
 * 实测下来掷骰子的结果几乎总是落在文字那一侧（因为大多数人导入的聊天记录
 * 里语音占比很低），用户选了「随机」却始终收到文字，体感就是「这个开关坏了」。
 * 与其用一个用户无法预测、也无法验证的随机，不如把这个选择权直接交回用户。
 * 历史数据里残留的 'mixed' 由 normalizeVoiceMode() 统一落回 'text'。
 */

/**
 * 这条回复要不要「一开口就是语音」—— 必须在生成**之前**决定。
 *
 * 为什么必须提前：如果等文字生成完再决定发语音，那这条内容就是按
 * 「打字」的方式写出来的（有标点、成句、书面语），再拿去念就是念稿。
 * 同时前端已经把那些文字流式显示成气泡了，用户看到"文字跳了一下变成语音"，
 * 这恰恰是用户不想要的观感。所以判定提前到拼提示词之前，
 * 让模型一开始就知道"我这条是开口说的"。
 *
 * @returns {{ speak: boolean, reason: string }}
 */
export function decideSpeakUpfront({ mode, voiceReady = true }) {
  const m = normalizeVoiceMode(mode);
  if (m === 'text') return { speak: false, reason: 'text-mode' };
  if (!voiceReady) return { speak: false, reason: 'voice-not-ready' };
  return { speak: true, reason: 'voice-mode' };
}

/**
 * 把模型写出来的东西洗成「能被念出来的一段话」。
 *
 * 提示词里已经把要求写死了（不要 emoji、不要括号动作、不要标点），
 * 但模型偶尔还是会犯 —— 尤其是被上下文里的聊天记录带跑的时候。
 * 所以代码层还要兜一道，否则用户会在语音里听到一个字正腔圆的女声念
 * "（笑）" 或者 "捂脸"，瞬间出戏。
 *
 * 清洗的分寸：**只去念不出来的东西，不改意思**。
 * 洗完的文本同时用作 TTS 输入和「转文字」的显示内容 ——
 * 两者必须是同一段话，否则用户听到的和看到的不一致。
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeSpokenText(raw) {
  let t = String(raw || '');

  // 先拆掉 Markdown —— 语音里没有加粗、没有代码块、没有列表
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');
  t = t.replace(/^\s{0,3}\d+[.、)]\s+/gm, '');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/_{2,}/g, '');

  /* 括号 / 星号里的东西分两种，必须区别对待：
   *
   *   "（笑）" "[捂脸]" "*叹气*" "（沉默了两秒）"  —— 舞台提示，念不出来，整段丢掉
   *   "（昨天难受了一整天）"                      —— 是真话，只是用括号说的，脱括号保留
   *
   * 判据不是单纯按字数：8 个字能装下"昨天难受了一整天"这种完整意思，
   * 一条字数阈值会把真话一起删掉。组合判断更准 ——
   * 短于 6 字一律当提示；6 字以上只有命中"表演类"词表才当提示。 */
  const STAGE_WORDS = /^(笑|哭|沉默|叹气|皱眉|捂脸|害羞|尴尬|无语|点头|摇头|思考|停顿|翻白眼|撇嘴|耸肩|哈哈|hhh|233|lol|doge|微笑|流汗|汗|晕|怒|委屈|撒娇|小声|大声|笑死|捏脸|抱抱|亲亲|比心)/i;
  const dropOrKeep = (_m, inner) => {
    const clean = stripEmoji(inner).replace(/^[\s*~-]+|[\s*~-]+$/g, '');
    if (!clean) return ' ';
    // 只按"是不是表演提示"判断，不按字数 —— 字数会把"（很难受）"这种真话误删
    if (STAGE_WORDS.test(clean) && clean.length < 14) return ' ';
    return clean;
  };

  /* 加粗先于斜体处理。
   * 反过来的话 `**重点**` 会先被 `*...*` 规则吃掉中间那段，
   * 变成"两个星号 + 重点 + 两个星号是斜体"，内容就被当成动作标注删掉。 */
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  t = t.replace(/（([^（）]*)）/g, dropOrKeep);
  t = t.replace(/\(([^()]*)\)/g, dropOrKeep);
  t = t.replace(/【([^【】]*)】/g, dropOrKeep);
  t = t.replace(/\[([^[\]]*)\]/g, dropOrKeep);
  t = t.replace(/\*([^*\n]+)\*/g, dropOrKeep);

  t = stripEmoji(t);

  /* 标点 → 停顿。
   * 真人发语音转成文字之后，句末基本不见标点，只有停顿。
   * 句末类标点换成换行（TTS 会读成句间停顿），句中类换成空格。 */
  t = t.replace(/[。！？!?…]+["'"']?/g, '\n');
  t = t.replace(/[～~]+/g, ' ');
  t = t.replace(/[，,、；;：:]/g, ' ');
  t = t.replace(/[""'']/g, '');
  t = t.replace(/[—–]+/g, ' ');

  // 收尾：多余空白、空行、行首尾空格
  t = t.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  return t.trim();
}

/* emoji / 颜文字 / 变体选择符 / 零宽连接符 / 肤色修饰 / 组合键帽
 * 这些字符念不出来，但会在 TTS 里变成奇怪的停顿或者直接被跳读。 */
function stripEmoji(s) {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u2190-\u21FF\u2B00-\u2BFF]/gu, '')
    .replace(/[^\S\n]{2,}/g, ' ');
}

export const VOICE_MODES = ['text', 'voice'];

/**
 * 归一化输出形态。
 *
 * 注意 'mixed' 会被落回 'text'：老数据里存过这个值，如果不归一化，
 * 前端的两个按钮都不高亮，用户会以为"设置丢了"。
 * 保留这个分支的注释，是因为后来的人看到库里有 'mixed' 时
 * 需要知道它是被有意废弃的，而不是忘了处理。
 */
export function normalizeVoiceMode(v) {
  if (v === 'mixed') return 'text';
  return VOICE_MODES.includes(v) ? v : 'text';
}

/**
 * 决定这一条要不要用语音发。
 *
 * @param {object} o
 * @param {'text'|'voice'} o.mode   用户选的输出模式
 * @param {boolean} [o.voiceReady]  当前是否真的配好了可用的 TTS/音色
 * @param {string} [o.content]      要发出的文本（太长的内容不适合语音）
 * @returns {{speak: boolean, reason: string}}
 */
export function decideSpeak({ mode, voiceReady = true, content = '' }) {
  const m = normalizeVoiceMode(mode);

  if (m === 'text') return { speak: false, reason: 'text-mode' };
  // 没配好音色/服务时，硬发语音只会得到一个 400，不如老实发文字
  if (!voiceReady) return { speak: false, reason: 'voice-not-ready' };

  const text = String(content || '').trim();
  // 语音是「说」出来的东西，太长的内容在真实聊天里没人会一整段念出来。
  // 超过 120 字就退回文字，避免生成一段 40 秒的语音把人听跑。
  if (text.length > 120) return { speak: false, reason: 'too-long' };

  return { speak: true, reason: 'voice-mode' };
}

/**
 * 一条消息最终以什么形态展示给用户。
 * 用于前端渲染历史消息：有音频就以语音气泡呈现（微信那样），没有就是文字气泡。
 */
export function messageShape({ msgType, audioId }) {
  if (audioId) return 'voice';
  return msgType === 'audio' ? 'voice-missing' : 'text';
}

/**
 * 这个用户现在真的能合成语音吗？
 *
 * 只看「有没有 tts_configs 行」是不够的：Breeze Blue 托管版还需要一个
 * voice_id，自托管版需要参考音频。缺任何一样，发语音请求都会 400，
 * 与其让用户在聊天里撞一个错误，不如提前判断并退回文字。
 */
export function ttsReady({ tts, voiceRef }) {
  if (!tts) return { ready: false, reason: 'NO_TTS_CONFIG' };
  const kind = tts.kind || 'auto';
  if (kind === 'breezeblue') {
    const remoteId = voiceRef?.remote_voice_id;
    if (!remoteId) return { ready: false, reason: 'NO_VOICE' };
    if (!tts.apiKey) return { ready: false, reason: 'NO_API_KEY' };
    return { ready: true };
  }
  if (kind === 'breeze_local') {
    if (!voiceRef?.file_path) return { ready: false, reason: 'NEED_REF_AUDIO' };
    if (!voiceRef?.ref_text) return { ready: false, reason: 'NEED_REF_TEXT' };
    return { ready: true };
  }
  // auto：交给 synthesize 探测，这里只要地址存在
  return tts.base_url ? { ready: true } : { ready: false, reason: 'NO_TTS_CONFIG' };
}
