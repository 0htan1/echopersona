import crypto from 'node:crypto';

/** Canonical message: { sender, content, ts (ms|null), type, seq } */

const DATE_RE = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/;
const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const AM_PM_RE = /(上午|下午|凌晨|晚上|中午|AM|PM|am|pm)/;

export function parseTimestamp(str) {
  if (!str) return null;
  const s = String(str).trim();
  const dm = s.match(DATE_RE);
  const tm = s.match(TIME_RE);
  if (!dm && !tm) return null;
  let y, mo, d, h = 0, mi = 0, se = 0;
  if (dm) { y = +dm[1]; mo = +dm[2]; d = +dm[3]; }
  if (tm) { h = +tm[1]; mi = +tm[2]; se = tm[3] ? +tm[3] : 0; }
  const ap = s.match(AM_PM_RE);
  if (ap) {
    const t = ap[1];
    if ((t === '下午' || t === '晚上' || t === 'PM' || t === 'pm') && h < 12) h += 12;
    if ((t === '中午') && h < 11) h += 12;
    if ((t === '凌晨') && h === 12) h = 0;
    if ((t === '上午' || t === 'AM' || t === 'am') && h === 12) h = 0;
  }
  if (!dm) {
    // time only -> anchor to today
    const now = new Date();
    y = now.getFullYear(); mo = now.getMonth() + 1; d = now.getDate();
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

const INVISIBLE = /[\u200b-\u200f\ufeff\u202a-\u202e]/g;
export function cleanText(t) {
  return String(t ?? '').replace(INVISIBLE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function hashMessage({ sender, ts, content }) {
  return crypto.createHash('sha256')
    .update(`${sender || ''}\u0001${ts || ''}\u0001${String(content).trim()}`)
    .digest('hex')
    .slice(0, 40);
}

// ---------------------------------------------------------------- TXT
/**
 * Heuristic multi-format TXT parser for exported chat logs.
 * Handles:
 *   "2023-01-01 12:00:00 张三"  (WeChat PC export, speaker on its own line)
 *   "[2023-01-01 12:00] 张三: 你好"
 *   "2023-01-01 12:00 - 张三: 你好"
 *   "张三 2023-01-01 12:00:00"  (QQ style)
 */
export function parseTxt(raw) {
  const text = cleanText(raw);
  const lines = text.split('\n');
  const msgs = [];
  const senders = new Map();

  // speaker-on-own-line pattern: date time, then rest is speaker
  const HEADER_ONLY = /^\s*[\[\(]?\s*(\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:上午|下午|凌晨|晚上|中午)?)\s*[\]\)]?\s*(.*)$/;
  // inline pattern: header + speaker + separator
  const INLINE = /^\s*[\[\(]?\s*(\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:上午|下午|凌晨|晚上|中午)?)\s*[\]\)]?\s*[-–—]?\s*([^:：]{1,40}?)\s*[:：]\s*(.*)$/;
  const QQ = /^\s*([^\s:：]{1,30})\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  /* 没有时间戳的「说话人：内容」。
   *
   * 这是用户最常见的输入形式 —— 从微信里手动复制几段、或导出的纯文本
   * 聊天记录，基本都长这样。之前只认带时间戳的格式，结果整段话被当成
   * 一条无发送者的消息：既不报错，也一条样本都提不出来，表现出来就是
   * 「导进去了但一点都不像」。所以这种形式必须支持。
   *
   * 约束：说话人不超过 12 字、不含空白和句读，避免把
   * "他说：我不去" 这种正文句子误判成新的说话人。 */
  const PLAIN = /^\s*([^\s:：，。！？、；""''（）()\[\]【】]{1,12})\s*[:：]\s*(.*)$/;

  /* 「谁是说话人」必须先在全文上判定一次，不能边扫边认。
   *
   * 原实现遇到 `XXX：内容` 就直接开一条新消息，于是正文里任何
   * 带冒号的行都会被当成一个新的人：
   *     「注意：明天带伞」「问题：这个怎么弄」「时间：晚上八点」
   * 一次导入就能凭空多出十几个"人物"，发送者映射变成一堆噪声，
   * 自动判定复刻对象也判到错的人头上 —— 用户看到的就是
   * 「分析出来的多了很多人物」。
   *
   * 判据：真人的昵称在同一份记录里会**反复出现**，正文里的
   * 「词：」通常只出现一次。所以先统计一遍候选名字出现次数，
   * 出现 ≥2 次的才承认为说话人；只有一份记录里候选名字
   * 全都不重复时（极短的片段），才退回取前两个。
   */
  const PLAIN_SKIP = new Set([
    '注意', '提示', '说明', '备注', '补充', '例如', '比如', '问题', '答案', '原因',
    '结果', '时间', '地点', '日期', '总结', '结论', '重点', '建议', '参考', '注',
    'ps', 'PS', 'P.S.', '提示词', '标题', '链接', '地址', '电话', '价格', '人数',
  ]);

  /* ── 判定「谁是真说话人」 ─────────────────────────────────────────
   * 真人的昵称在同一份记录里必然反复出现，而且会和别人**交替**；
   * 正文里的「词：」通常只出现一次，且周围没有别的「词：」。
   * 所以先收集候选，再用「高频」+「与已确认说话人相邻」两条规则扩散：
   *   · 出现 ≥2 次 → 直接认定（张三说两句话就是人，不是正文）
   *   · 紧挨着已认定的说话人 → 认定（三人小群里只说过一句的也得算）
   *   · 其余 → 判为正文，并回当前消息
   * 这样「时间：晚上八点」「地点：三楼」这类不会变成人，
   * 而「李四：开」这种只出现一次的真说话人也能留下来。 */
  /* 带时间戳的格式里，说话人位置是确定的 —— 那里读出来的名字无条件可信。
   * 先把它们收齐，后面判断「这行是正文还是新消息」时以这份名单为准。 */
  const knownSpeakers = new Set();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let m = t.match(INLINE);
    if (m && m[2] && m[2].trim()) { knownSpeakers.add(m[2].trim()); continue; }
    m = t.match(HEADER_ONLY);
    if (m) {
      const rest = (m[2] || '').trim().replace(/[:：]$/, '').trim();
      // 群聊里 "[日期] 内容" 也走这条分支，用长度和句读把纯内容排除
      if (rest && rest.length <= 20 && !/[，。！？；]/.test(rest)) knownSpeakers.add(rest);
      continue;
    }
    m = t.match(QQ);
    if (m) knownSpeakers.add(m[1].trim());
  }

  const plainCounts = new Map();
  const candSeq = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (INLINE.test(t) || HEADER_ONLY.test(t) || QQ.test(t)) continue;
    if (/^\[(图片|视频|语音|文件|动画表情|链接|音乐|位置|名片|转账|红包)\]/.test(t)) continue;
    if (/^\[语音转文字\]/.test(t)) continue;
    const m = t.match(PLAIN);
    if (!m) continue;
    const who = m[1].trim();
    if (!who || PLAIN_SKIP.has(who)) continue;
    candSeq.push(who);
    plainCounts.set(who, (plainCounts.get(who) || 0) + 1);
  }

  /* 这几个词在手敲记录里就是「我方/对方」的代称，出现一次也算人。
   * 它们几乎不会出现在正文的「词：」位置（没人写「我：其实……」当句子），
   * 少了它们会让两人对话里只说过一句的那一方整个消失。 */
  const ALWAYS_SPEAKER = new Set(['我', '你', '他', '她', 'TA', 'ta', '对方', '自己']);

  const speakerSet = new Set(knownSpeakers);
  for (const [name, n] of plainCounts) {
    if (n >= 2 || ALWAYS_SPEAKER.has(name) || knownSpeakers.has(name)) speakerSet.add(name);
  }
  // 与已确认说话人相邻的候选（允许隔着一条已被跳过的正文行）
  for (let pass = 0; pass < 3; pass += 1) {
    let grew = false;
    for (let i = 0; i < candSeq.length; i += 1) {
      const name = candSeq[i];
      if (speakerSet.has(name)) continue;
      const prev = candSeq[i - 1];
      const next = candSeq[i + 1];
      if ((prev && speakerSet.has(prev)) || (next && speakerSet.has(next))) {
        speakerSet.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  if (!speakerSet.size && plainCounts.size) {
    // 一份很短、每个人只说一句的记录：按出现顺序取前两个当说话人
    for (const [name] of [...plainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
      speakerSet.add(name);
    }
  }

  let cur = null;
  const push = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    // 语音消息即使没有转文字也要留下 —— 它记录「这个人爱发语音」这个事实，
    // 是后面决定输出形态的依据；纯空文本才丢。
    if (body || cur.type !== 'text') {
      const msg = { sender: cur.sender, content: body, ts: cur.ts, type: cur.type, seq: msgs.length };
      if (cur.type === 'audio') msg.voiceTranscript = !!cur.hasTranscript;
      msgs.push(msg);
      if (cur.sender) senders.set(cur.sender, (senders.get(cur.sender) || 0) + 1);
    }
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (cur) cur.lines.push('');
      continue;
    }

    let m = line.match(INLINE);
    if (m && m[2] && m[2].trim()) {
      push();
      cur = { sender: m[2].trim(), ts: parseTimestamp(m[1]), lines: [m[3] ?? ''], type: 'text' };
      continue;
    }

    m = line.match(HEADER_ONLY);
    if (m) {
      const rest = (m[2] || '').trim();
      if (rest) {
        // "2023-01-01 12:00:00 张三" -> speaker only, content follows on next lines
        push();
        cur = { sender: rest.replace(/[:：]$/, '').trim(), ts: parseTimestamp(m[1]), lines: [], type: 'text' };
        continue;
      }
      // header with no speaker: could be "[date] content"? treat as continuation
      if (cur) { cur.lines.push(line); continue; }
      push();
      cur = { sender: null, ts: parseTimestamp(m[1]), lines: [], type: 'text' };
      continue;
    }

    m = line.match(QQ);
    if (m) {
      push();
      cur = { sender: m[1].trim(), ts: parseTimestamp(m[2]), lines: [], type: 'text' };
      continue;
    }

    // media placeholders
    // 语音消息在微信导出里常长这样：
    //   [语音] 12"
    //   [语音转文字] 你在干嘛呀
    // 也可能一行里连着写。转出来的文字是**说**出来的话，
    // 和打字风格不同（口头禅、语气词、句子短、没标点），
    // 所以单独标成 audio 并在后面单独统计。
    const media = line.match(/^\[(图片|视频|语音|文件|动画表情|链接|音乐|位置|名片|转账|红包)\]\s*(.*)$/);
    if (media && cur) {
      const kind = mapMediaType(media[1]);
      const rest = (media[2] || '').trim();

      if (kind === 'audio') {
        cur.type = 'audio';
        // 同一行里就可能带转文字：`[语音] [语音转文字] 内容`
        const inline = rest.match(/\[语音转文字\]\s*(.*)$/);
        if (inline) {
          if (inline[1].trim()) cur.lines.push(inline[1].trim());
          cur.hasTranscript = true;
        } else if (rest && !/^\d+\s*["'′s]?$/.test(rest)) {
          // 不是时长（12"），就当成内容
          cur.lines.push(rest);
        }
        continue;
      }

      cur.type = kind;
      if (rest) cur.lines.push(rest);
      continue;
    }

    // 独立成行的 [语音转文字]（紧跟在 [语音] 之后，最常见的形式）
    // 只在 cur 本来就是 audio 时才算转写；否则它只是一段普通内容
    const transcript = line.match(/^\[语音转文字\]\s*(.*)$/);
    if (transcript && cur && cur.type === 'audio') {
      if (transcript[1].trim()) cur.lines.push(transcript[1].trim());
      cur.hasTranscript = true;
      continue;
    }
    // cur 是 audio 但这一行带说话人前缀且换了人 —— 下面 PLAIN 会处理，
    // 这里只兜住「无说话人前缀的孤立转写」，避免把别人的话记错人

    // 无时间戳的「说话人：内容」。放在所有带时间戳的规则之后，
    // 免得把 "2023-01-01 12:00 张三：xxx" 里的时间戳当成说话人。
    const plain = line.match(PLAIN);
    if (plain && plain[2] !== undefined) {
      const who = plain[1].trim();
      const rest = (plain[2] || '').trim();

      /* 不在说话人名单里 —— 这行是正文，不是新消息。
       * 「注意：明天带伞」里的"注意"不是一个人。并进当前消息，
       * 整行保留（冒号是原文的一部分，不能丢）。
       * 没有 cur 时（文件开头就是正文）当无发送者消息收下。 */
      if (!speakerSet.has(who)) {
        /* 正文里的「词：」，不是新消息。
         *
         * 但有一种情况必须断开：上一条是语音。语音的 content 只该装
         * 转写出来的话 —— 把「我：在加班」塞进去，听起来就是她一个人
         * 说完了两个人的台词，转文字时也会串到别人头上。
         * 这时宁可丢掉那个不可信的名字，也要把内容单独成条。 */
        if (cur && cur.type !== 'text') {
          push();
          cur = { sender: null, ts: null, lines: [line], type: 'text' };
          continue;
        }
        if (cur) cur.lines.push(line);
        else cur = { sender: null, ts: null, lines: [line], type: 'text' };
        continue;
      }
      /* 「林小满：[语音转文字] xxx」—— 上一行是她的 [语音]，这一行是转写。
       * 这种情况必须并回上一条 audio，否则会多出一条打字消息，
       * 把"这是语音说的话"这个关键信息丢掉。
       * 注意这里必须在 push() **之前**判断 —— push 会把 cur 清空。
       * 而且必须**同一个人**：A 发语音、B 的转写接在下面，那是两条消息，
       * 合并会把 B 的话记到 A 头上（说话人错位比丢信息更糟）。 */
      const tInline = rest.match(/^\[语音转文字\]\s*(.*)$/);
      if (tInline && cur && cur.type === 'audio' && cur.sender === who) {
        if (tInline[1].trim()) cur.lines.push(tInline[1].trim());
        cur.hasTranscript = true;
        continue;
      }
      /* 只有 [语音转文字] 而上一行不是她的 [语音]（导出时丢了媒体标记）。
       * 这仍然是一条语音 —— 内容就是转写文字。不能当普通文本收下，
       * 否则这段口语会混进"打字"样本池，模仿语音时反而用不上。 */
      if (tInline) {
        push();
        cur = {
          sender: who, ts: null,
          lines: tInline[1].trim() ? [tInline[1].trim()] : [],
          type: 'audio',
        };
        cur.hasTranscript = true;
        continue;
      }
      push();
      /* 「林小满：[语音] 5"」这种一行里既带说话人又带媒体标记。
       * 如果只按普通文本收下，语音消息就会被当成一段打字，
       * 语音样本池里一条都没有 —— 发语音时就学不到"她说话的样子"。
       * 所以这里把媒体前缀再拆一次。 */
      const mediaInline = rest.match(/^\[(语音|图片|视频|文件|动画表情)\]\s*(.*)$/);
      if (mediaInline) {
        const kind = mapMediaType(mediaInline[1]);
        const tail = (mediaInline[2] || '').trim();
        cur = { sender: who, ts: null, lines: [], type: kind };
        if (kind === 'audio') {
          /* 转写可能跟时长写在同一行：「[语音] 12" [语音转文字] 内容」。
           * 所以要先把开头的时长剥掉再认转写，否则「12" [语音转文字] 内容」
           * 认不出转写标记，整串（含时长）都会被当成消息正文。 */
          const bare = tail.replace(/^\d+\s*["'′s]?\s*/, '').trim();
          const inlineT = bare.match(/^\[语音转文字\]\s*(.*)$/);
          if (inlineT) {
            if (inlineT[1].trim()) cur.lines.push(inlineT[1].trim());
            cur.hasTranscript = true;
          } else if (tail && !/^\d+\s*["'′s]?$/.test(tail)) {
            cur.lines.push(tail);
          }
        } else if (tail) {
          cur.lines.push(tail);
        }
        continue;
      }
      cur = { sender: who, ts: null, lines: [rest], type: 'text' };
      continue;
    }

    if (cur) cur.lines.push(line);
    else {
      // preamble text before first header: buffer as unknown sender
      cur = { sender: null, ts: null, lines: [line], type: 'text' };
    }
  }
  push();

  return { messages: msgs.filter((m) => m.content || m.type !== 'text'), senders: topSenders(senders) };
}

function mapMediaType(label) {
  if (label === '图片' || label === '动画表情') return 'image';
  if (label === '语音') return 'audio';
  if (label === '视频') return 'video';
  if (label === '文件') return 'file';
  return 'other';
}

function topSenders(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

// ---------------------------------------------------------------- JSON
const SENDER_KEYS = ['sender', 'from', 'speaker', 'author', 'name', 'nickname', 'user', 'username', 'sendername', 'sender_name', 'displayname', '发送者', '发件人', '昵称', '说话人', '用户'];
const CONTENT_KEYS = ['content', 'text', 'message', 'body', 'msg', 'msgcontent', 'messagecontent', '内容', '消息', '正文'];
const TS_KEYS = ['timestamp', 'time', 'date', 'datetime', 'createdat', 'created_at', 'ts', 'sendtime', 'send_time', 'mtime', '时间', '发送时间'];
const TYPE_KEYS = ['type', 'msgtype', 'message_type', 'kind', 'msg_type'];

function pick(obj, keys) {
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase().replace(/[_\s-]/g, ''), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase().replace(/[_\s-]/g, ''));
    if (real !== undefined && obj[real] !== undefined && obj[real] !== null) return obj[real];
  }
  return undefined;
}

function coerceTs(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    if (v > 1e12) return Math.round(v);           // ms
    if (v > 1e9) return Math.round(v * 1000);     // seconds
    return null;
  }
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return +s * 1000;
  if (/^\d{13}$/.test(s)) return +s;
  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) return iso;
  return parseTimestamp(s);
}

export function parseJson(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}`);
  }

  let arr = null;
  let outerSenders = null;

  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object') {
    for (const k of ['messages', 'data', 'chat', 'records', 'list', 'items', 'history', 'msgs']) {
      if (Array.isArray(data[k])) { arr = data[k]; break; }
    }
    // nested: { data: { messages: [...] } }
    if (!arr && data.data && typeof data.data === 'object') {
      for (const k of ['messages', 'records', 'list', 'items']) {
        if (Array.isArray(data.data[k])) { arr = data.data[k]; break; }
      }
    }
    if (!arr) {
      // single-conversation object with a messages map? try any array of objects with content
      const candidate = Object.values(data).find(
        (v) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object')
      );
      if (candidate) arr = candidate;
    }
    if (data.participants || data.members || data.users) {
      const list = data.participants || data.members || data.users;
      if (Array.isArray(list)) outerSenders = list.map((p) => (typeof p === 'string' ? p : p?.name || p?.nickname)).filter(Boolean);
    }
  }
  if (!Array.isArray(arr)) throw new Error('JSON 中未找到消息数组。支持的键名：messages / data / chat / records / list / items');

  const msgs = [];
  const senders = new Map();
  let skipped = 0;

  for (const item of arr) {
    if (!item || typeof item !== 'object') { skipped++; continue; }
    let sender = pick(item, SENDER_KEYS);
    if (sender && typeof sender === 'object') sender = sender.name || sender.nickname || sender.id || null;
    const contentRaw = pick(item, CONTENT_KEYS);
    let content = contentRaw;
    if (content && typeof content === 'object') content = content.text ?? content.content ?? JSON.stringify(content);
    if (content === undefined || content === null) { skipped++; continue; }
    content = cleanText(content);
    if (!content.trim() && !pick(item, TYPE_KEYS)) { skipped++; continue; }

    const ts = coerceTs(pick(item, TS_KEYS));
    const typeRaw = String(pick(item, TYPE_KEYS) || 'text').toLowerCase();
    const type = /image|img|pic|图片/.test(typeRaw) ? 'image'
      : /audio|voice|语音/.test(typeRaw) ? 'audio'
      : /video|视频/.test(typeRaw) ? 'video'
      : /file|文件/.test(typeRaw) ? 'file'
      : 'text';

    const s = sender ? String(sender).trim() : null;
    msgs.push({ sender: s, content, ts, type, seq: msgs.length });
    if (s) senders.set(s, (senders.get(s) || 0) + 1);
  }

  if (!msgs.length) throw new Error(`JSON 中未解析出任何消息（跳过 ${skipped} 条）。请确认每条消息包含发送者与内容字段。`);

  return { messages: msgs, senders: topSenders(senders), outerSenders, skipped };
}

// ---------------------------------------------------------------- CSV
export function parseCsvDelimited(raw, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = cleanText(raw);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

export function parseCsv(raw) {
  const text = cleanText(raw).replace(/^\ufeff/, '');
  const firstLine = text.split('\n')[0] || '';
  const counts = [[',', (firstLine.match(/,/g) || []).length], ['\t', (firstLine.match(/\t/g) || []).length], [';', (firstLine.match(/;/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ',';

  const rows = parseCsvDelimited(text, delim);
  if (rows.length < 1) throw new Error('CSV 内容为空');

  const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[_\s-]/g, ''));
  const findCol = (keys) => header.findIndex((h) => keys.includes(h));
  let senderIdx = findCol(SENDER_KEYS.map((k) => k.toLowerCase().replace(/[_\s-]/g, '')));
  let contentIdx = findCol(CONTENT_KEYS.map((k) => k.toLowerCase().replace(/[_\s-]/g, '')));
  let tsIdx = findCol(TS_KEYS.map((k) => k.toLowerCase().replace(/[_\s-]/g, '')));
  let typeIdx = findCol(TYPE_KEYS.map((k) => k.toLowerCase().replace(/[_\s-]/g, '')));

  let startRow = 1;
  if (contentIdx < 0) {
    // no recognizable header: assume [sender, content, time] or [time, sender, content]
    startRow = 0;
    senderIdx = 0; contentIdx = 1; tsIdx = header.length > 2 ? 2 : -1;
    const looksLikeHeader = /sender|from|内容|发送者|message|时间|time/.test(header.join(''));
    if (looksLikeHeader) throw new Error('CSV 表头中未找到「内容」列。请将消息内容列命名为 content / text / message / 内容 之一。');
  }

  const msgs = [];
  const senders = new Map();
  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    const content = cleanText(row[contentIdx] ?? '');
    if (!content.trim()) continue;
    const s = senderIdx >= 0 ? String(row[senderIdx] ?? '').trim() || null : null;
    const ts = tsIdx >= 0 ? coerceTs(row[tsIdx]) : null;
    const typeRaw = typeIdx >= 0 ? String(row[typeIdx] || 'text').toLowerCase() : 'text';
    const type = /image|图片/.test(typeRaw) ? 'image' : /audio|语音/.test(typeRaw) ? 'audio' : /video|视频/.test(typeRaw) ? 'video' : /file|文件/.test(typeRaw) ? 'file' : 'text';
    msgs.push({ sender: s, content, ts, type, seq: msgs.length });
    if (s) senders.set(s, (senders.get(s) || 0) + 1);
  }
  if (!msgs.length) throw new Error('CSV 中没有可用的消息行');
  return { messages: msgs, senders: topSenders(senders), delimiter: delim };
}

// ---------------------------------------------------------------- Markdown
export function parseMarkdown(raw) {
  const text = cleanText(raw);
  const msgs = [];
  const senders = new Map();

  // Pattern A: "**张三**: 内容" or "> **张三**: 内容"
  // Pattern B: "## 张三" heading then paragraphs
  const lines = text.split('\n');
  let cur = null;
  const flush = () => {
    if (cur && cur.lines.join('\n').trim()) {
      const content = cur.lines.join('\n').trim();
      msgs.push({ sender: cur.sender, content, ts: cur.ts, type: 'text', seq: msgs.length });
      if (cur.sender) senders.set(cur.sender, (senders.get(cur.sender) || 0) + 1);
    }
    cur = null;
  };

  // try bold-label style first
  const boldLabel = /^\s*[>*-]?\s*\*\*(.{1,40}?)\*\*\s*[:：]?\s*(.*)$/;
  const tsPrefix = /^\s*[\[\(]?(\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?)[\]\)]?\s*[—–-]?\s*/;
  const heading = /^\s*#{1,4}\s+(.{1,40}?)\s*$/;

  let boldHits = 0;
  for (const l of lines) if (boldLabel.test(l)) boldHits++;

  if (boldHits >= 2) {
    for (const line of lines) {
      const m = line.match(boldLabel);
      if (m) {
        flush();
        cur = { sender: m[1].trim(), ts: null, lines: [] };
        const rest = m[2] || '';
        const tm = rest.match(tsPrefix);
        if (tm) { cur.ts = parseTimestamp(tm[1]); cur.lines.push(rest.slice(tm[0].length)); }
        else cur.lines.push(rest);
      } else if (cur) cur.lines.push(line);
    }
    flush();
    if (msgs.length) return { messages: msgs.filter((m) => m.content), senders: topSenders(senders) };
  }

  // heading style
  cur = null;
  const out = [];
  for (const line of lines) {
    const h = line.match(heading);
    if (h && h[1].length <= 40) {
      if (cur && cur.lines.join('\n').trim()) {
        const content = cur.lines.join('\n').trim();
        out.push({ sender: cur.sender, content, ts: null, type: 'text', seq: out.length });
      }
      cur = { sender: h[1].trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur && cur.lines.join('\n').trim()) {
    out.push({ sender: cur.sender, content: cur.lines.join('\n').trim(), ts: null, type: 'text', seq: out.length });
  }
  if (!out.length) {
    // last resort: fall back to TXT heuristics
    return parseTxt(raw);
  }
  const s2 = new Map();
  for (const m of out) if (m.sender) s2.set(m.sender, (s2.get(m.sender) || 0) + 1);
  return { messages: out, senders: topSenders(s2) };
}

export function detectFormat(filename, head) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'json') return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt' || ext === 'log') return 'txt';
  // sniff
  const h = String(head || '').trim();
  if (h.startsWith('{') || h.startsWith('[')) return 'json';
  if (h.includes(',') && h.split('\n')[0].split(',').length >= 3) return 'csv';
  return 'txt';
}

export function parseChatFile({ filename, buffer }) {
  const text = buffer.toString('utf8');
  const fmt = detectFormat(filename, text.slice(0, 2000));
  let result;
  if (fmt === 'json') result = parseJson(text);
  else if (fmt === 'csv') result = parseCsv(text);
  else if (fmt === 'markdown') result = parseMarkdown(text);
  else result = parseTxt(text);
  return { ...result, format: fmt };
}
