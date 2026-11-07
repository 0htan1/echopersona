import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, run, tx, hasFts } from '../db/index.js';
import { audit } from '../lib/auth.js';
import { buildExport } from '../lib/export.js';
import { loadLlm } from './configs.js';
import { rebuildChunkIndex, indexMemory, resolveEmbedder, MEMORY_KINDS } from '../lib/memory.js';
import { runAnalysis, samplePersonaLines, computeStyleStats, describeStats } from '../lib/persona.js';
import { normalizeVoiceMode } from '../lib/voice-mode.js';

export default async function personaRoutes(app) {
  const auth = { preHandler: app.requireAuth };

  const own = (req, id) => get('SELECT * FROM personas WHERE id = ? AND user_id = ?', [id, req.user.id]);

  const toDto = (p, extra = {}) => ({
    id: p.id, name: p.name, avatarPath: p.avatar_path,
    avatarUrl: p.avatar_path ? `/api/personas/${p.id}/avatar` : null,
    bio: p.bio, relationship: p.relationship, description: p.description,
    language: p.language, similarityMode: p.similarity_mode,
    llmConfigId: p.llm_config_id, ttsConfigId: p.tts_config_id, voiceRefId: p.voice_ref_id,
    autoSpeak: !!p.auto_speak, voiceMode: p.voice_mode || 'text', status: p.status,
    analysisStatus: p.analysis_status, analysisError: p.analysis_error, analyzedAt: p.analyzed_at,
    createdAt: p.created_at, updatedAt: p.updated_at,
    ...extra,
  });

  /* ------------------------------------------------------- list */
  app.get('/api/personas', auth, async (req) => {
    const rows = all('SELECT * FROM personas WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    const out = rows.map((p) => {
      const stats = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN role='persona' THEN 1 ELSE 0 END) AS persona_lines
         FROM messages WHERE persona_id = ? AND is_imported = 1`, [p.id]);
      const memCount = get('SELECT COUNT(*) c FROM memories WHERE persona_id = ? AND is_deleted = 0', [p.id]).c;
      const chatCount = get('SELECT COUNT(*) c FROM chats WHERE persona_id = ?', [p.id]).c;
      const last = get('SELECT content, created_at FROM messages WHERE chat_id IS NOT NULL AND persona_id = ? ORDER BY created_at DESC LIMIT 1', [p.id]);
      return toDto(p, {
        importedMessages: stats?.total || 0,
        personaLines: stats?.persona_lines || 0,
        memoryCount: memCount, chatCount,
        lastMessage: last ? { content: String(last.content).slice(0, 80), at: last.created_at } : null,
      });
    });
    return { personas: out };
  });

  /* ----------------------------------------------------- create */
  app.post('/api/personas', auth, async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: '请填写人物昵称' });
    const id = `per_${crypto.randomUUID()}`;
    const now = Date.now();
    const llm = b.llmConfigId && get('SELECT id FROM llm_configs WHERE id=? AND user_id=?', [b.llmConfigId, req.user.id])
      ? b.llmConfigId : null;
    run(`INSERT INTO personas (id,user_id,name,bio,relationship,description,language,similarity_mode,
          llm_config_id,tts_config_id,voice_ref_id,auto_speak,voice_mode,status,analysis_status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, name, String(b.bio || '').slice(0, 300),
        String(b.relationship || '').slice(0, 100), String(b.description || '').slice(0, 4000),
        ['zh', 'en', 'ja'].includes(b.language) ? b.language : 'zh',
        ['free', 'natural', 'high'].includes(b.similarityMode) ? b.similarityMode : 'natural',
        llm, b.ttsConfigId || null, b.voiceRefId || null, b.autoSpeak ? 1 : 0,
        normalizeVoiceMode(b.voiceMode), 'active', 'none', now, now]);
    audit(req.user.id, 'persona.create', { target: id, ip: req.ip });
    return { ok: true, persona: toDto(get('SELECT * FROM personas WHERE id = ?', [id])) };
  });

  app.get('/api/personas/:id', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const stats = get(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN role='persona' THEN 1 ELSE 0 END) AS persona_lines,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM messages WHERE persona_id = ? AND is_imported = 1`, [p.id]);
    const memCount = get('SELECT COUNT(*) c FROM memories WHERE persona_id = ? AND is_deleted = 0', [p.id]).c;
    // 导入记录必须与前端字段名一致（originalName / total / added / duplicates / createdAt）。
    // 早期这里直接把 SQL 查出来的 snake_case 行塞进响应，前端读 imp.originalName 全是
    // undefined，导入列表因此只显示空白和 "null" —— 导入其实成功了，是展示层对不上。
    const imports = all(
      'SELECT id,original_name,status,message_total,message_new,message_dup,error,created_at FROM import_files WHERE persona_id = ? ORDER BY created_at DESC',
      [p.id]
    ).map((r) => ({
      id: r.id,
      originalName: r.original_name,
      status: r.status,
      total: r.message_total,
      added: r.message_new,
      duplicates: r.message_dup,
      error: r.error,
      createdAt: r.created_at,
    }));
    const profileRow = get('SELECT * FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
    let profile = null;
    if (profileRow) {
      profile = JSON.parse(profileRow.data_json);
      profile._version = profileRow.version;
      profile._createdAt = profileRow.created_at;
    }
    return {
      persona: toDto(p, {
        importedMessages: stats?.total || 0,
        personaLines: stats?.persona_lines || 0,
        firstTs: stats?.first_ts || null, lastTs: stats?.last_ts || null,
        memoryCount: memCount,
      }),
      imports, profile,
      chunkCount: get('SELECT COUNT(*) c FROM memory_chunks WHERE persona_id = ?', [p.id]).c,
    };
  });

  app.patch('/api/personas/:id', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const b = req.body || {};
    const sets = []; const vals = [];
    const map = {
      name: ['name', (v) => String(v).trim().slice(0, 60)],
      bio: ['bio', (v) => String(v).slice(0, 300)],
      relationship: ['relationship', (v) => String(v).slice(0, 100)],
      description: ['description', (v) => String(v).slice(0, 4000)],
      language: ['language', (v) => (['zh', 'en', 'ja'].includes(v) ? v : 'zh')],
      similarityMode: ['similarity_mode', (v) => (['free', 'natural', 'high'].includes(v) ? v : 'natural')],
      llmConfigId: ['llm_config_id', (v) => v || null],
      ttsConfigId: ['tts_config_id', (v) => v || null],
      voiceRefId: ['voice_ref_id', (v) => v || null],
      autoSpeak: ['auto_speak', (v) => (v ? 1 : 0)],
      voiceMode: ['voice_mode', (v) => normalizeVoiceMode(v)],
    };
    for (const [k, [col, fn]] of Object.entries(map)) {
      if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(fn(b[k])); }
    }
    if (!sets.length) return reply.code(400).send({ error: '没有需要更新的字段' });
    sets.push('updated_at = ?'); vals.push(Date.now(), p.id);
    run(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`, vals);
    return { ok: true, persona: toDto(get('SELECT * FROM personas WHERE id = ?', [p.id])) };
  });

  app.delete('/api/personas/:id', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const files = [];
    for (const r of all('SELECT stored_path FROM import_files WHERE persona_id = ?', [p.id])) if (r.stored_path) files.push(r.stored_path);
    for (const r of all('SELECT file_path FROM tts_audio WHERE persona_id = ?', [p.id])) if (r.file_path) files.push(r.file_path);
    if (p.avatar_path) files.push(path.join(config.avatarDir, p.avatar_path));

    tx(() => {
      if (hasFts()) {
        run('DELETE FROM memories_fts WHERE persona_id = ?', [p.id]);
        run('DELETE FROM chunks_fts WHERE persona_id = ?', [p.id]);
      }
      run('DELETE FROM messages WHERE persona_id = ?', [p.id]);
      run('DELETE FROM memory_chunks WHERE persona_id = ?', [p.id]);
      run('DELETE FROM memories WHERE persona_id = ?', [p.id]);
      run('DELETE FROM profiles WHERE persona_id = ?', [p.id]);
      run('DELETE FROM tts_audio WHERE persona_id = ?', [p.id]);
      run('DELETE FROM import_files WHERE persona_id = ?', [p.id]);
      run('DELETE FROM chats WHERE persona_id = ?', [p.id]);
      run('DELETE FROM personas WHERE id = ?', [p.id]);
    });
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    audit(req.user.id, 'persona.delete', { target: p.id, ip: req.ip });
    return { ok: true };
  });

  // duplicate persona incl. imported messages, memories, profile
  app.post('/api/personas/:id/duplicate', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const newId = `per_${crypto.randomUUID()}`;
    const now = Date.now();
    tx(() => {
      run(`INSERT INTO personas (id,user_id,name,avatar_path,bio,relationship,description,language,similarity_mode,
            llm_config_id,tts_config_id,voice_ref_id,auto_speak,voice_mode,status,analysis_status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [newId, req.user.id, `${p.name} 副本`, p.avatar_path, p.bio, p.relationship, p.description,
          p.language, p.similarity_mode, p.llm_config_id, p.tts_config_id, p.voice_ref_id,
          p.auto_speak, p.voice_mode || 'text', 'active', 'none', now, now]);

      const msgs = all('SELECT * FROM messages WHERE persona_id = ? AND is_imported = 1', [p.id]);
      const stmt = app.db.prepare(
        `INSERT INTO messages (id,user_id,persona_id,chat_id,import_id,role,sender_raw,content,msg_type,ts,seq,
           is_imported,is_persona_voice,dedupe_hash,meta_json,created_at)
         VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,1,?,?,?,?)`);
      for (const m of msgs) {
        stmt.run(`msg_${crypto.randomUUID()}`, req.user.id, newId, m.role, m.sender_raw, m.content,
          m.msg_type, m.ts, m.seq, m.is_persona_voice, `d${crypto.randomUUID()}`, m.meta_json, now);
      }
      const mems = all('SELECT * FROM memories WHERE persona_id = ? AND is_deleted = 0', [p.id]);
      for (const m of mems) {
        const mid = `mem_${crypto.randomUUID()}`;
        run(`INSERT INTO memories (id,user_id,persona_id,kind,content,salience,confidence,source_type,source_ref,
              happened_at,embedding,embed_model,dedupe_hash,is_deleted,edited,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`,
          [mid, req.user.id, newId, m.kind, m.content, m.salience, m.confidence, m.source_type, m.source_ref,
            m.happened_at, m.embedding, m.embed_model, m.dedupe_hash, now, now]);
        run('INSERT INTO memories_fts (content_tok, memory_id, persona_id) VALUES (?,?,?)',
          [require_tokenize(m.content), mid, newId]);
      }
      const prof = get('SELECT * FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
      if (prof) {
        run(`INSERT INTO profiles (id,user_id,persona_id,version,data_json,model,sample_count,message_count,is_active,created_at)
             VALUES (?,?,?,1,?,?,?,?,1,?)`,
          [`prf_${crypto.randomUUID()}`, req.user.id, newId, prof.data_json, prof.model, prof.sample_count, prof.message_count, now]);
        run('UPDATE personas SET analysis_status = ?, analyzed_at = ? WHERE id = ?', ['ready', now, newId]);
      }
    });
    audit(req.user.id, 'persona.duplicate', { target: newId, ip: req.ip });
    return { ok: true, id: newId };
  });

  /* --------------------------------------------------- avatar */
  app.post('/api/personas/:id/avatar', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const file = await req.file({ limits: { fileSize: config.maxAvatarBytes, files: 1 } });
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    const allowed = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = allowed[file.mimetype];
    if (!ext) return reply.code(400).send({ error: '仅支持 PNG / JPG / WEBP / GIF' });
    const buf = await file.toBuffer();
    const name = `p_${p.id}_${Date.now()}${ext}`;
    fs.mkdirSync(config.avatarDir, { recursive: true });
    fs.writeFileSync(path.join(config.avatarDir, name), buf);
    run('UPDATE personas SET avatar_path = ?, updated_at = ? WHERE id = ?', [name, Date.now(), p.id]);
    if (p.avatar_path) { try { fs.unlinkSync(path.join(config.avatarDir, p.avatar_path)); } catch { /* ignore */ } }
    return { ok: true, avatarUrl: `/api/personas/${p.id}/avatar` };
  });

  app.get('/api/personas/:id/avatar', async (req, reply) => {
    const p = get('SELECT avatar_path FROM personas WHERE id = ?', [req.params.id]);
    if (!p?.avatar_path) return reply.code(404).send({ error: 'not found' });
    const fp = path.join(config.avatarDir, p.avatar_path);
    if (!fs.existsSync(fp)) return reply.code(404).send({ error: 'not found' });
    const ext = path.extname(fp).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
    reply.type(mime).header('cache-control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(fp));
  });

  /* -------------------------------------------- style stats api */
  app.get('/api/personas/:id/style-stats', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const lines = all(
      `SELECT content, ts FROM messages WHERE persona_id = ? AND is_imported = 1 AND role='persona' AND length(content)>0`,
      [p.id]);
    const stats = computeStyleStats(lines);
    return { stats, description: describeStats(stats), sampleCount: lines.length };
  });

  /* ------------------------------------------------ analysis */
  app.post('/api/personas/:id/analyze', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });

    // 云通道已移除，只剩「服务端转发 + 自备 Key」这一条路。
    const llm = loadLlm(req, app);
    if (!llm) {
      return reply.code(400).send({
        error: '还没有可用的大模型。请到「设置 → API 配置」填入你自己的 API Key（支持 OpenAI、DeepSeek、Moonshot、通义等兼容接口）。',
        code: 'NO_LLM',
      });
    }
    if (!llm.apiKey) {
      return reply.code(400).send({ error: '默认大模型配置缺少可用 API Key', code: 'NO_API_KEY' });
    }

    const lines = samplePersonaLines(p.id, { max: 5 });
    if (!lines.length) {
      return reply.code(400).send({
        error: '没有可分析的内容。请先在「聊天记录」中导入包含目标人物发言的记录，并把正确的一方标记为「复刻对象」。',
      });
    }

    run('UPDATE personas SET analysis_status = ?, analysis_error = NULL, updated_at = ? WHERE id = ?',
      ['running', Date.now(), p.id]);
    const jobId = `job_${crypto.randomUUID()}`;
    run(`INSERT INTO jobs (id,user_id,persona_id,type,status,progress,stage,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [jobId, req.user.id, p.id, 'analyze', 'running', 0.05, '准备中', Date.now(), Date.now()]);

    reply.code(202).send({ ok: true, jobId });

    // run detached so the client can poll progress
    (async () => {
      const t0 = Date.now();
      try {
        const result = await runAnalysis({
          userId: req.user.id, persona: p, llmCfg: llm, apiKey: llm.apiKey,
          onProgress: (prog, stage) => {
            run('UPDATE jobs SET progress = ?, stage = ?, updated_at = ? WHERE id = ?', [prog, stage, Date.now(), jobId]);
          },
        });
        const profile = result.profile;

        // seed memories from the analysis
        const embedder = resolveEmbedder(llm);
        let added = 0;
        for (const m of profile.memories || []) {
          let vec = null;
          if (embedder) {
            try {
              const { embedTexts } = await import('../lib/memory.js');
              const [v] = await embedTexts({ ...embedder, apiKey: llm.apiKey }, [m.content]);
              vec = v;
            } catch { vec = null; }
          }
          const r = indexMemory({
            userId: req.user.id, personaId: p.id, kind: m.kind, content: m.content,
            salience: m.salience, confidence: m.confidence, sourceType: 'analysis',
            sourceRef: `profile:${result.profileId}`, embedding: vec, embedModel: embedder?.model || null,
          });
          if (!r.merged) added++;
        }

        // rebuild dialogue chunk index
        run('UPDATE jobs SET stage = ?, progress = 0.95, updated_at = ? WHERE id = ?', ['建立记忆索引', Date.now(), jobId]);
        const idx = await rebuildChunkIndex({ userId: req.user.id, personaId: p.id, embedder: embedder ? { ...embedder, apiKey: llm.apiKey } : null });

        run('UPDATE personas SET analysis_status = ?, analyzed_at = ?, updated_at = ? WHERE id = ?',
          ['ready', Date.now(), Date.now(), p.id]);
        run(`UPDATE jobs SET status='done', progress=1, stage=?, result_json=?, updated_at=? WHERE id=?`,
          ['完成', JSON.stringify({ profileId: result.profileId, version: result.version, memoriesAdded: added, chunks: idx.chunks, embedded: idx.embedded, ms: Date.now() - t0 }), Date.now(), jobId]);
        audit(req.user.id, 'persona.analyze', { target: p.id, ip: req.ip, meta: { version: result.version } });
      } catch (e) {
        run('UPDATE personas SET analysis_status = ?, analysis_error = ?, updated_at = ? WHERE id = ?',
          ['failed', String(e.message).slice(0, 500), Date.now(), p.id]);
        run('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?',
          ['failed', String(e.message).slice(0, 1000), Date.now(), jobId]);
        app.log.error({ err: e.message, personaId: p.id }, 'analysis failed');
      }
    })();
  });

  app.get('/api/jobs/:id', auth, async (req, reply) => {
    const j = get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!j) return reply.code(404).send({ error: '任务不存在' });
    return {
      job: {
        id: j.id, type: j.type, status: j.status, progress: j.progress, stage: j.stage,
        result: j.result_json ? JSON.parse(j.result_json) : null, error: j.error,
        createdAt: j.created_at, updatedAt: j.updated_at,
      },
    };
  });

  app.get('/api/jobs', auth, async (req) => {
    const rows = all('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [req.user.id]);
    return { jobs: rows.map((j) => ({ id: j.id, type: j.type, status: j.status, progress: j.progress, stage: j.stage, error: j.error, createdAt: j.created_at })) };
  });

  /* ------------------------------------------- memories CRUD */
  app.get('/api/personas/:id/memories', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const q = String(req.query?.q || '').trim();
    const kind = req.query?.kind;
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 100));
    let rows;
    if (q) {
      const { toFtsQuery } = await import('../lib/memory.js');
      const fq = toFtsQuery(q);
      if (fq) {
        try {
          rows = all(
            `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id
             WHERE memories_fts MATCH ? AND m.persona_id = ? AND m.is_deleted = 0
             ORDER BY bm25(memories_fts) LIMIT ?`, [fq, p.id, limit]);
        } catch { rows = []; }
      } else rows = [];
      if (!rows.length) {
        rows = all(`SELECT * FROM memories WHERE persona_id=? AND is_deleted=0 AND content LIKE ? ORDER BY salience DESC LIMIT ?`,
          [p.id, `%${q}%`, limit]);
      }
    } else if (kind && MEMORY_KINDS.includes(kind)) {
      rows = all(`SELECT * FROM memories WHERE persona_id=? AND is_deleted=0 AND kind=? ORDER BY salience DESC, updated_at DESC LIMIT ?`,
        [p.id, kind, limit]);
    } else {
      rows = all(`SELECT * FROM memories WHERE persona_id=? AND is_deleted=0 ORDER BY salience DESC, updated_at DESC LIMIT ?`,
        [p.id, limit]);
    }
    return {
      memories: rows.map((m) => ({
        id: m.id, kind: m.kind, content: m.content, salience: m.salience, confidence: m.confidence,
        sourceType: m.source_type, sourceRef: m.source_ref, happenedAt: m.happened_at,
        hasEmbedding: !!m.embedding, edited: !!m.edited, createdAt: m.created_at, updatedAt: m.updated_at,
      })),
      total: get('SELECT COUNT(*) c FROM memories WHERE persona_id=? AND is_deleted=0', [p.id]).c,
    };
  });

  app.post('/api/personas/:id/memories', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const { content, kind = 'fact', salience = 3, confidence = 0.9 } = req.body || {};
    const text = String(content || '').trim();
    if (!text) return reply.code(400).send({ error: '请填写记忆内容' });
    const llm = loadLlm(req, app);
    let vec = null; let model = null;
    const embedder = resolveEmbedder(llm);
    if (embedder && llm.apiKey) {
      try {
        const { embedTexts } = await import('../lib/memory.js');
        const [v] = await embedTexts({ ...embedder, apiKey: llm.apiKey }, [text]);
        vec = v; model = embedder.model;
      } catch { /* keyword-only */ }
    }
    const r = indexMemory({
      userId: req.user.id, personaId: p.id, kind: MEMORY_KINDS.includes(kind) ? kind : 'fact',
      content: text, salience: Math.max(1, Math.min(5, Number(salience) || 3)),
      confidence: Math.max(0, Math.min(1, Number(confidence) ?? 0.9)),
      sourceType: 'manual', embedding: vec, embedModel: model,
    });
    return { ok: true, id: r.id, merged: r.merged };
  });

  app.patch('/api/memories/:id', auth, async (req, reply) => {
    const m = get('SELECT * FROM memories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!m) return reply.code(404).send({ error: '记忆不存在' });
    const b = req.body || {};
    const sets = []; const vals = [];
    if (b.content !== undefined) { sets.push('content = ?'); vals.push(String(b.content).trim().slice(0, 2000)); }
    if (b.kind !== undefined && MEMORY_KINDS.includes(b.kind)) { sets.push('kind = ?'); vals.push(b.kind); }
    if (b.salience !== undefined) { sets.push('salience = ?'); vals.push(Math.max(1, Math.min(5, Number(b.salience) || 3))); }
    if (b.confidence !== undefined) { sets.push('confidence = ?'); vals.push(Math.max(0, Math.min(1, Number(b.confidence)))); }
    if (!sets.length) return reply.code(400).send({ error: '没有需要更新的字段' });
    sets.push('edited = 1', 'updated_at = ?'); vals.push(Date.now(), m.id);
    run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (b.content !== undefined) {
      const { updateMemorySearch } = await import('../lib/memory.js');
      updateMemorySearch(m.id, m.persona_id, String(b.content).trim());
    }
    return { ok: true };
  });

  app.delete('/api/memories/:id', auth, async (req, reply) => {
    const m = get('SELECT * FROM memories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!m) return reply.code(404).send({ error: '记忆不存在' });
    run('UPDATE memories SET is_deleted = 1, updated_at = ? WHERE id = ?', [Date.now(), m.id]);
    run('DELETE FROM memories_fts WHERE memory_id = ?', [m.id]);
    return { ok: true };
  });

  /* -------------------------------- memory recall preview (debug) */
  app.get('/api/personas/:id/recall', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const q = String(req.query?.q || '').trim();
    if (!q) return reply.code(400).send({ error: '请提供查询内容 q' });
    const llm = loadLlm(req, app);
    const { recallMemories, formatRecallForPrompt } = await import('../lib/memory.js');
    const embedder = resolveEmbedder(llm);
    const r = await recallMemories({
      userId: req.user.id, personaId: p.id, query: q,
      embedder: embedder && llm?.apiKey ? { ...embedder, apiKey: llm.apiKey } : null,
      limit: 8, chunkLimit: 4,
    });
    return {
      memories: r.memories.map((m) => ({ content: m.content, kind: m.kind, score: Math.round(m.score * 100) / 100, confidence: m.confidence, salience: m.salience })),
      chunks: r.chunks.map((c) => ({ content: c.content, score: Math.round(c.score * 100) / 100, at: c.start_ts })),
      usedEmbedding: r.usedEmbedding,
      promptBlock: formatRecallForPrompt(r),
    };
  });

  /* ------------------------------------------ profile editing */
  app.get('/api/personas/:id/profile', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const row = get('SELECT * FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
    if (!row) return { profile: null };
    const data = JSON.parse(row.data_json);
    data._version = row.version;
    data._createdAt = row.created_at;
    return { profile: data, versions: all('SELECT id,version,created_at,is_active FROM profiles WHERE persona_id=? ORDER BY version DESC', [p.id]) };
  });

  app.patch('/api/personas/:id/profile', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const row = get('SELECT * FROM profiles WHERE persona_id = ? AND is_active = 1', [p.id]);
    if (!row) return reply.code(404).send({ error: '该人格还没有分析结果' });
    const { normalizeProfile } = await import('../lib/persona.js');
    const merged = normalizeProfile({ ...JSON.parse(row.data_json), ...(req.body?.profile || {}) });
    merged._meta = JSON.parse(row.data_json)._meta;
    merged._userEdited = Date.now();
    run('UPDATE profiles SET data_json = ? WHERE id = ?', [JSON.stringify(merged), row.id]);
    audit(req.user.id, 'profile.edit', { target: p.id, ip: req.ip });
    return { ok: true, profile: merged };
  });

  /* -------------------------------------------- data export */
  app.get('/api/personas/:id/export', auth, async (req, reply) => {
    const p = own(req, req.params.id);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const full = buildExport(req.user.id);
    const one = { ...full, personas: full.personas.filter((x) => x.id === p.id) };
    reply.header('content-disposition', `attachment; filename="persona-${p.id}.json"`);
    reply.type('application/json');
    return reply.send(JSON.stringify(one, null, 2));
  });
}

function require_tokenize(s) {
  // local import avoids a circular dependency at module load
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
  const out = [];
  for (const w of String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (CJK.test(w)) {
      for (let i = 0; i < w.length; i++) { out.push(w[i]); if (i + 1 < w.length) out.push(w[i] + w[i + 1]); }
    } else if (w.length >= 2) out.push(w.toLowerCase());
  }
  return out.join(' ');
}
