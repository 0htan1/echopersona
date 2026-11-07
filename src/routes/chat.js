import crypto from 'node:crypto';
import { get, all, run } from '../db/index.js';
import { audit } from '../lib/auth.js';
import { loadLlm } from './configs.js';
import { chatStream } from '../lib/llm.js';
import { recallMemories, formatRecallForPrompt, resolveEmbedder } from '../lib/memory.js';
import { buildSystemPrompt, buildChatMessages, pickStyleSamples, renderStyleSamples } from '../lib/persona.js';
import { safeJson, loadTts } from './configs.js';
import { normalizeVoiceMode, decideSpeakUpfront, ttsReady, sanitizeSpokenText } from '../lib/voice-mode.js';
import { synthesizeToFile } from '../lib/tts-service.js';

/* 从库里取历史消息的条数天花板。
 *
 * 注意这**不是**上下文预算 —— 条数和 token 数不是一回事：28 条超短消息
 * 可能只有几百字，28 条长消息能到两万字。真正的裁剪在
 * buildChatMessages() 里按字符预算做（compactHistory）。
 * 这里放宽到 40 只是因为 SQL 总要有个 LIMIT；预算才是那个会先触发的约束。 */
const CONTEXT_ROW_CEILING = 40;

export default async function chatRoutes(app) {
  const auth = { preHandler: app.requireAuth };
  const ownPersona = (req, id) => get('SELECT * FROM personas WHERE id = ? AND user_id = ?', [id, req.user.id]);

  /* ------------------------------------------------- chats */
  app.get('/api/personas/:personaId/chats', auth, async (req, reply) => {
    const p = ownPersona(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const rows = all(
      `SELECT c.*, (SELECT content FROM messages WHERE chat_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_text,
              (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND deleted_at IS NULL) AS msg_count
       FROM chats c WHERE c.persona_id = ? AND c.archived = 0 ORDER BY c.updated_at DESC`, [p.id]);
    return {
      chats: rows.map((c) => ({
        id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at,
        msgCount: c.msg_count, lastText: c.last_text ? String(c.last_text).slice(0, 60) : null,
      })),
    };
  });

  app.post('/api/personas/:personaId/chats', auth, async (req, reply) => {
    const p = ownPersona(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const id = `cht_${crypto.randomUUID()}`;
    const now = Date.now();
    run('INSERT INTO chats (id,user_id,persona_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, p.id, String(req.body?.title || '新的对话').slice(0, 80), now, now]);
    return { ok: true, chat: { id, title: '新的对话', createdAt: now, updatedAt: now } };
  });

  app.patch('/api/chats/:id', auth, async (req, reply) => {
    const c = get('SELECT * FROM chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!c) return reply.code(404).send({ error: '会话不存在' });
    if (req.body?.title !== undefined) {
      run('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?', [String(req.body.title).slice(0, 80), Date.now(), c.id]);
    }
    if (req.body?.archived !== undefined) {
      run('UPDATE chats SET archived = ?, updated_at = ? WHERE id = ?', [req.body.archived ? 1 : 0, Date.now(), c.id]);
    }
    return { ok: true };
  });

  app.delete('/api/chats/:id', auth, async (req, reply) => {
    const c = get('SELECT * FROM chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!c) return reply.code(404).send({ error: '会话不存在' });
    run('DELETE FROM messages WHERE chat_id = ?', [c.id]);
    run('DELETE FROM chats WHERE id = ?', [c.id]);
    return { ok: true };
  });

  app.get('/api/chats/:id/messages', auth, async (req, reply) => {
    const c = get('SELECT * FROM chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!c) return reply.code(404).send({ error: '会话不存在' });
    const rows = all(
      `SELECT m.id,m.role,m.content,m.created_at,m.msg_type,
              (SELECT id FROM tts_audio t WHERE t.message_id = m.id AND t.status='ready' LIMIT 1) AS audio_id,
              (SELECT mime FROM tts_audio t WHERE t.message_id = m.id AND t.status='ready' LIMIT 1) AS audio_mime
       FROM messages m WHERE m.chat_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC, m.seq ASC`, [c.id]);
    return {
      chat: { id: c.id, title: c.title, personaId: c.persona_id },
      messages: rows.map((m) => ({
        id: m.id, role: m.role, content: m.content, createdAt: m.created_at,
        type: m.msg_type, hasAudio: !!m.audio_id,
        // 有音频时前端要把它画成微信那种语音气泡（而不是文字气泡 + 播放条）
        audioUrl: m.audio_id ? `/api/audio/${m.audio_id}` : null,
        audioMime: m.audio_mime || null,
      })),
    };
  });

  app.delete('/api/messages/:id', auth, async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!m) return reply.code(404).send({ error: '消息不存在' });
    run('UPDATE messages SET deleted_at = ? WHERE id = ?', [Date.now(), m.id]);
    return { ok: true };
  });

  app.patch('/api/messages/:id', auth, async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!m) return reply.code(404).send({ error: '消息不存在' });
    if (m.role !== 'user') return reply.code(400).send({ error: '只能编辑自己发送的消息' });
    const content = String(req.body?.content || '').trim();
    if (!content) return reply.code(400).send({ error: '内容不能为空' });
    run('UPDATE messages SET content = ? WHERE id = ?', [content.slice(0, 8000), m.id]);
    return { ok: true };
  });

  /* ----------------------------------------------- streaming */
  app.post('/api/personas/:personaId/chat', {
    config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const p = ownPersona(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });

    const userText = String(req.body?.message || '').trim();
    if (!userText) return reply.code(400).send({ error: '消息不能为空' });
    if (userText.length > 8000) return reply.code(400).send({ error: '消息过长（上限 8000 字）' });

    const llm = loadLlm(req, app);
    if (!llm) {
      return reply.code(400).send({
        error: '还没有可用的大模型配置。请先到「API 配置」填写你自己的 API Key 并测试连接。',
        code: 'NO_LLM_CONFIG',
      });
    }
    if (!llm.apiKey) {
      return reply.code(400).send({ error: '大模型配置缺少可用 API Key', code: 'NO_API_KEY' });
    }

    // chat resolution
    let chatId = req.body?.chatId || null;
    let chat = chatId ? get('SELECT * FROM chats WHERE id = ? AND user_id = ? AND persona_id = ?', [chatId, req.user.id, p.id]) : null;
    if (!chat) {
      chatId = `cht_${crypto.randomUUID()}`;
      const now = Date.now();
      const title = userText.slice(0, 30).replace(/\s+/g, ' ') || '新的对话';
      run('INSERT INTO chats (id,user_id,persona_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        [chatId, req.user.id, p.id, title, now, now]);
      chat = { id: chatId, title };
    }

    const profileRow = get('SELECT data_json FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
    const profile = profileRow ? JSON.parse(profileRow.data_json) : null;
    const mode = ['free', 'natural', 'high'].includes(req.body?.mode) ? req.body.mode
      : (p.similarity_mode || 'natural');

    // 输出形态：这条回复是打字还是发语音。语音模式下要让模型知道
    // 「你现在是在说话」，否则生成出来的东西是书面语，念出来就是稿子。
    const voiceMode = normalizeVoiceMode(req.body?.voiceMode || p.voice_mode);
    const tts = loadTts(req, app, p.tts_config_id || null);
    const voiceRef = p.voice_ref_id
      ? get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [p.voice_ref_id, req.user.id])
      : (tts ? get('SELECT * FROM voice_refs WHERE user_id = ? AND is_default = 1', [req.user.id]) : null);
    const voiceState = ttsReady({ tts, voiceRef });
    const canVoice = voiceMode !== 'text' && voiceState.ready;

    /* 先说还是先打 —— 必须在生成之前定下来。
     * 等文字生成完再决定发语音，那段内容就是按打字写出来的书面语，
     * 念出来必然是念稿；而且前端已经把文字流式显示成气泡了，
     * 用户会看到"文字跳一下变成语音"。所以提前判定。 */
    const speakDecision = decideSpeakUpfront({ mode: voiceMode, voiceReady: canVoice });
    const speaking = speakDecision.speak;

    // remember the user's turn immediately
    const userMsgId = `msg_${crypto.randomUUID()}`;
    const maxSeq = get('SELECT MAX(seq) s FROM messages WHERE chat_id = ?', [chat.id])?.s || 0;
    run(`INSERT INTO messages (id,user_id,persona_id,chat_id,role,sender_raw,content,msg_type,ts,seq,is_imported,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
      [userMsgId, req.user.id, p.id, chat.id, 'user', null, userText, 'text', Date.now(), maxSeq + 1, Date.now()]);

    /* 最近对话上下文。
     *
     * 取多少条不再由 CONTEXT_TURNS 说了算 —— 条数和 token 数不是一回事，
     * 28 条长消息能把上下文顶到两万字。现在取一个较宽的天花板（40 条），
     * 真正的裁剪交给 buildChatMessages() 里的字符预算（见 compactHistory），
     * 它按「6000 字 + 至少最近 4 条」从最新往前装。
     *
     * 这里放宽条数是有意的：预算才是硬约束，条数只是防止「几百条超短消息
     * 也被全装进去」的保险。真正的浪费由预算拦住，不必在 SQL 里提前砍。 */
    const historyRows = all(
      `SELECT role,content FROM messages WHERE chat_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, seq DESC LIMIT ?`, [chat.id, CONTEXT_ROW_CEILING]);
    const history = historyRows.reverse();

    // memory recall
    const embedder = resolveEmbedder(llm);
    let recall = { memories: [], chunks: [] };
    try {
      recall = await recallMemories({
        userId: req.user.id, personaId: p.id, query: userText,
        embedder: embedder && llm.apiKey ? { ...embedder, apiKey: llm.apiKey } : null,
        limit: 8, chunkLimit: 4,
      });
    } catch (e) {
      app.log.warn({ err: e.message }, 'recall failed; continuing without memory');
    }
    const recallBlock = profile ? formatRecallForPrompt(recall) : '';

    /* 每条消息都重新取一次真实语料样本，并按「用户刚说的这句」做相关度排序。
     *
     * 为什么不能放进 profile 里缓存：profile 是一份摘要，而这里要的是原文。
     * 而且相关度是相对当前这句话算的 —— 聊到做饭时该摆出她聊做饭的样子，
     * 聊到吵架时该摆出她生气的样子。固定一批样本永远只能对上一半。
     * 这条查询走 (persona_id, ts, seq) 索引，几千条记录也是毫秒级。 */
    let styleSamples = '';
    let sampleStats = { pairs: 0, lines: 0, voice: 0 };
    let pickedForVoice = { pairs: [], voice: [] };
    try {
      const picked = pickStyleSamples(p.id, userText, {
        // 发语音时多给口语样本、少给打字样本：她"说"的样子才是这条的依据
        pairs: 8, lines: speaking ? 4 : 14, voiceLines: speaking ? 10 : 6,
      });
      styleSamples = renderStyleSamples(picked);
      pickedForVoice = picked;
      sampleStats = {
        pairs: picked.pairs?.length || 0,
        lines: picked.lines?.length || 0,
        voice: picked.voice?.length || 0,
      };
    } catch (e) {
      app.log.warn({ err: e.message }, 'style samples failed; continuing without them');
    }

    const systemPrompt = buildSystemPrompt({
      persona: {
        name: p.name, relationship: p.relationship, description: p.description, language: p.language,
      },
      profile,
      recallBlock,
      mode,
      userName: '我',
      voiceEnabled: canVoice,
      speaking,
      styleSamples: speaking
        // 发语音时，语料样本要以「她说的话」为主 —— 打字样本只作参考
        ? renderStyleSamples({
          pairs: pickedForVoice.pairs || [],
          lines: [],
          voice: pickedForVoice.voice || [],
        })
        : styleSamples,
    });
    const messages = buildChatMessages({ systemPrompt, history: history.slice(0, -1), userMessage: userText });

    // prepare SSE
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => {
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };

    const ac = new AbortController();
    const onClose = () => ac.abort();
    reply.raw.on('close', onClose);

    const assistantId = `msg_${crypto.randomUUID()}`;
    const started = Date.now();
    let acc = '';
    let errored = null;
    let isMock = false;

    send({
      type: 'start', chatId: chat.id, userMessageId: userMsgId, assistantId, mode,
      recalled: { memories: recall.memories.length, chunks: recall.chunks.length, usedEmbedding: recall.usedEmbedding },
      // 让前端能显示"这次用了几条真实语料" —— 用户能直观看到"学到了东西"
      samples: sampleStats,
    });

    try {
      const stream = chatStream({
        baseUrl: llm.base_url, apiKey: llm.apiKey, model: p.llm_config_id
          ? (get('SELECT model FROM llm_configs WHERE id = ?', [p.llm_config_id])?.model || llm.model)
          : llm.model,
        messages, params: llm.params, timeoutMs: 180000, signal: ac.signal,
      });

      for await (const ev of stream) {
        if (ac.signal.aborted) break;
        if (ev.type === 'delta') {
          acc += ev.text;
          /* 语音模式下**不把文字流给前端**。
           * 用户要的是"直接收到一条语音"，不是"看着字一个个跳出来，
           * 然后它变成语音"。文字只在服务端攒着，拿去合成语音；
           * 前端只收到"正在输入"的心跳。 */
          if (!speaking) send({ type: 'delta', text: ev.text });
        } else if (ev.type === 'error') {
          errored = ev.message;
          send({ type: 'error', message: ev.message });
        } else if (ev.type === 'done') {
          if (ev.mock) isMock = true;
          if (ev.usage) send({ type: 'usage', usage: ev.usage });
        }
      }
    } catch (e) {
      errored = e.message;
      send({ type: 'error', message: e.message });
    } finally {
      reply.raw.off('close', onClose);
    }

    const aborted = ac.signal.aborted;
    if (acc.trim()) {
      const seq = (get('SELECT MAX(seq) s FROM messages WHERE chat_id = ?', [chat.id])?.s || 0) + 1;

      /* 语音模式：把模型输出洗成"能被念出来"的样子。
       * 即使提示词已经把要求写死了，模型偶尔还是会带括号动作或 emoji，
       * 所以这里兜一道。清洗只去噪声，不改意思 —— 转文字时用户看到的
       * 仍然是他听到的内容。 */
      const finalText = speaking ? sanitizeSpokenText(acc) : acc;
      const decision = { speak: speaking, reason: speakDecision.reason };

      run(`INSERT INTO messages (id,user_id,persona_id,chat_id,role,sender_raw,content,msg_type,ts,seq,is_imported,
             meta_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        [assistantId, req.user.id, p.id, chat.id, 'persona', p.name, finalText,
          speaking ? 'text' : 'text',   // 先记 text，合成成功后再改 audio
          Date.now(), seq,
          JSON.stringify({
            mode, model: llm.model, ms: Date.now() - started, aborted,
            recalled: recall.memories.length, voiceMode, speak: decision.speak,
            samples: sampleStats,
          }), Date.now()]);
      run('UPDATE chats SET updated_at = ? WHERE id = ?', [Date.now(), chat.id]);
      audit(req.user.id, 'chat.send', { target: p.id, ip: req.ip, meta: { chars: finalText.length, spoke: speaking } });

      /* 语音模式下立刻合成，并把结果放进 done 事件里。
       * 不交给前端再发一次 /api/tts：那样用户会先看到一个"语音条正在生成"
       * 的中间态，而真实微信里你收到语音就是收到了，没有加载过程。 */
      let audio = null;
      if (speaking && finalText.trim()) {
        send({ type: 'speaking', chars: finalText.length });
        try {
          audio = await synthesizeToFile({
            userId: req.user.id, personaId: p.id, messageId: assistantId, text: finalText,
            tts, voiceRef, language: p.language || 'zh', ip: req.ip,
          });
          if (audio) {
            run("UPDATE messages SET msg_type = 'audio' WHERE id = ?", [assistantId]);
          }
        } catch (e) {
          app.log.warn({ err: e.message }, 'inline tts failed');
          // 合成失败不能说"发了语音"—— 前端会退回显示文字，并在气泡上标出原因
          send({ type: 'tts_failed', message: e.message, code: e.code || null });
        }
      }

      send({
        type: 'done', messageId: assistantId, aborted, chars: finalText.length,
        ms: Date.now() - started, mock: !!isMock,
        speak: decision.speak, speakReason: decision.reason, voiceMode,
        // 语音模式下 content 仍要回传（用于「转文字」按钮），但前端不把它画成文字气泡
        content: speaking ? finalText : undefined,
        audioUrl: audio?.url || null,
        audioMime: audio?.mime || null,
        samples: sampleStats,
      });
    } else {
      send({ type: 'failed', aborted, error: errored || '模型没有返回任何内容' });
    }
    reply.raw.end();
  });

  /* -------------------------------------------- regenerate */
  // Delete the last assistant message and re-run with the same user prompt.
  app.post('/api/chats/:id/regenerate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = get('SELECT * FROM chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!c) return reply.code(404).send({ error: '会话不存在' });
    const last = get(
      `SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, seq DESC LIMIT 1`, [c.id]);
    if (!last) return reply.code(400).send({ error: '会话为空' });

    let userMsg;
    if (last.role === 'persona') {
      run('DELETE FROM messages WHERE id = ?', [last.id]);
      userMsg = get(`SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL AND role='user'
                     ORDER BY created_at DESC, seq DESC LIMIT 1`, [c.id]);
    } else {
      userMsg = last;
    }
    if (!userMsg) return reply.code(400).send({ error: '找不到对应的用户消息' });

    // remove the user message so the chat endpoint re-inserts it fresh
    run('DELETE FROM messages WHERE id = ?', [userMsg.id]);
    return { ok: true, personaId: c.persona_id, chatId: c.id, message: userMsg.content };
  });

  /* ------------------------------------------ openers */
  app.get('/api/personas/:personaId/openers', auth, async (req, reply) => {
    const p = ownPersona(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const prof = get('SELECT data_json FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
    const topics = prof ? (JSON.parse(prof.data_json).relationship_memory?.common_topics || []) : [];
    const base = ['最近怎么样？', '在忙吗', '今天有点想你', '跟你说个事'];
    const t = topics.slice(0, 3).map((x) => `聊聊${x}吧`);
    return { openers: [...t, ...base].slice(0, 6) };
  });
}
