import fs from 'node:fs';
import { get, all, run } from '../db/index.js';
import { loadTts } from './configs.js';
import { extForMime } from '../lib/tts.js';
import { synthesizeToFile } from '../lib/tts-service.js';

export default async function voiceRoutes(app) {
  const auth = { preHandler: app.requireAuth };

  /* ------------------------------------------- synthesize */
  const synthesizeHandler = async (req, reply) => {
    const b = req.body || {};
    const personaId = b.personaId || null;
    const messageId = b.messageId || null;

    let persona = null;
    if (personaId) {
      persona = get('SELECT * FROM personas WHERE id = ? AND user_id = ?', [personaId, req.user.id]);
      if (!persona) return reply.code(404).send({ error: '人格不存在' });
    }

    let text = String(b.text || '').trim();
    if (!text && messageId) {
      const m = get('SELECT content FROM messages WHERE id = ? AND user_id = ?', [messageId, req.user.id]);
      if (!m) return reply.code(404).send({ error: '消息不存在' });
      text = m.content;
    }
    if (!text) return reply.code(400).send({ error: '缺少要合成的文本' });

    const tts = loadTts(req, app, persona?.tts_config_id || b.ttsConfigId || null);
    const voiceRefId = persona?.voice_ref_id || b.voiceRefId || null;
    const voiceRef = voiceRefId
      ? get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [voiceRefId, req.user.id])
      : null;

    try {
      const out = await synthesizeToFile({
        userId: req.user.id, personaId, messageId, text, tts, voiceRef,
        language: b.language || persona?.language || 'zh', ip: req.ip,
      });
      return { ok: true, ...out };
    } catch (e) {
      const code = e.code === 'NO_TTS_CONFIG' || e.code === 'NEED_REF_AUDIO'
        || e.code === 'NEED_REF_TEXT' || e.code === 'NO_VOICE' || e.code === 'EMPTY_TEXT' ? 400 : 502;
      return reply.code(code).send({
        error: e.message, code: e.code || null, retryable: code === 502, audioId: e.audioId || null,
      });
    }
  };

  app.post('/api/tts', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, synthesizeHandler);

  /* ---------------------------------------------- serve audio */
  app.get('/api/audio/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM tts_audio WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音频不存在' });
    if (row.status !== 'ready' || !row.file_path || !fs.existsSync(row.file_path)) {
      return reply.code(404).send({ error: '音频尚未生成完成', status: row.status, error: row.error });
    }
    const stat = fs.statSync(row.file_path);
    const range = req.headers.range;
    reply.type(row.mime || 'audio/mpeg').header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=86400');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start >= stat.size) {
          reply.code(416).header('content-range', `bytes */${stat.size}`);
          return reply.send();
        }
        const realEnd = Math.min(end, stat.size - 1);
        reply.code(206)
          .header('content-range', `bytes ${start}-${realEnd}/${stat.size}`)
          .header('content-length', realEnd - start + 1);
        return reply.send(fs.createReadStream(row.file_path, { start, end: realEnd }));
      }
    }
    reply.header('content-length', stat.size);
    return reply.send(fs.createReadStream(row.file_path));
  });

  app.get('/api/audio/:id/download', auth, async (req, reply) => {
    const row = get('SELECT * FROM tts_audio WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row || row.status !== 'ready' || !fs.existsSync(row.file_path || '')) {
      return reply.code(404).send({ error: '音频不可用' });
    }
    const ext = extForMime(row.mime);
    reply.header('content-disposition', `attachment; filename="echopersona-${row.id.slice(-8)}.${ext}"`);
    reply.type(row.mime || 'audio/mpeg');
    return reply.send(fs.createReadStream(row.file_path));
  });

  // audio for a specific message (if generated)
  app.get('/api/messages/:id/audio', auth, async (req, reply) => {
    const row = get(
      `SELECT * FROM tts_audio WHERE message_id = ? AND user_id = ? AND status = 'ready'
       ORDER BY created_at DESC LIMIT 1`, [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '该消息还没有语音' });
    return reply.redirect(`/api/audio/${row.id}`);
  });

  app.get('/api/tts-history', auth, async (req) => {
    const rows = all(
      `SELECT a.id,a.text,a.status,a.mime,a.bytes,a.created_at,a.persona_id,a.error,p.name AS persona_name
       FROM tts_audio a LEFT JOIN personas p ON p.id = a.persona_id
       WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 60`, [req.user.id]);
    return {
      items: rows.map((r) => ({
        id: r.id, text: String(r.text).slice(0, 140), status: r.status, mime: r.mime, bytes: r.bytes,
        createdAt: r.created_at, personaId: r.persona_id, personaName: r.persona_name, error: r.error,
        url: r.status === 'ready' ? `/api/audio/${r.id}` : null,
      })),
    };
  });

  app.delete('/api/audio/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM tts_audio WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音频不存在' });
    if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch { /* ignore */ } }
    run('DELETE FROM tts_audio WHERE id = ?', [row.id]);
    return { ok: true };
  });

  // retry: reuse the stored text
  app.post('/api/audio/:id/retry', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const row = get('SELECT * FROM tts_audio WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音频不存在' });
    run('DELETE FROM tts_audio WHERE id = ?', [row.id]);
    req.body = { text: row.text, messageId: row.message_id, personaId: row.persona_id, voiceRefId: row.voice_ref_id };
    return synthesizeHandler(req, reply);
  });
}
