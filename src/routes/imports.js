import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, run, tx } from '../db/index.js';
import { audit } from '../lib/auth.js';
import { parseChatFile, hashMessage, cleanText } from '../lib/parsers.js';
import { extractZip, isSupportedFile, SUPPORTED_FORMATS } from '../lib/zip.js';
import { sampleTxt, sampleJson, sampleCsv, sampleMd } from '../lib/samples.js';

export default async function importRoutes(app) {
  const auth = { preHandler: app.requireAuth };
  const own = (req, id) => get('SELECT * FROM personas WHERE id = ? AND user_id = ?', [id, req.user.id]);

  const dto = (r) => ({
    id: r.id, originalName: r.original_name, bytes: r.bytes, status: r.status, parser: r.parser,
    error: r.error, total: r.message_total, added: r.message_new, duplicates: r.message_dup,
    createdAt: r.created_at,
  });

  app.get('/api/personas/:personaId/imports', auth, async (req, reply) => {
    const p = own(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const rows = all('SELECT * FROM import_files WHERE persona_id = ? ORDER BY created_at DESC', [p.id]);
    return {
      imports: rows.map(dto),
      senders: collectSenders(p.id),
      supportedFormats: SUPPORTED_FORMATS,
      maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    };
  });

  /* ---------------------------------------------- sample download */
  app.get('/api/samples/:kind', async (req, reply) => {
    const kind = String(req.params.kind || 'txt');
    const map = {
      txt: ['sample-chat.txt', 'text/plain; charset=utf-8', sampleTxt()],
      json: ['sample-chat.json', 'application/json; charset=utf-8', sampleJson()],
      csv: ['sample-chat.csv', 'text/csv; charset=utf-8', sampleCsv()],
      md: ['sample-chat.md', 'text/markdown; charset=utf-8', sampleMd()],
    };
    const item = map[kind];
    if (!item) return reply.code(404).send({ error: 'not found' });
    reply.header('content-disposition', `attachment; filename="${item[0]}"`);
    return reply.type(item[1]).send('\ufeff' === '' ? item[2] : item[2]);
  });

  /* -------------------------------------------- dry-run parse */
  // Parse without saving, so the user can map senders and preview first.
  app.post('/api/personas/:personaId/imports/preview', auth, async (req, reply) => {
    const p = own(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });

    const files = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer();
      if (buf.length > config.maxUploadBytes) {
        files.push({ name: part.filename, error: `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB 限制` });
        continue;
      }
      files.push({ name: part.filename || 'unnamed', buffer: buf, mime: part.mimetype });
    }
    if (!files.length) return reply.code(400).send({ error: '没有收到文件' });

    const results = [];
    for (const f of files) {
      results.push(await parseOne(f, p));
    }
    return { results, senders: mergeSenders(results), preview: previewOf(results) };
  });

  /* ------------------------------------------------- real import */
  app.post('/api/personas/:personaId/imports', auth, async (req, reply) => {
    const p = own(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });

    const files = [];
    const fields = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (buf.length > config.maxUploadBytes) {
          files.push({ name: part.filename, buffer: null, error: `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB 限制` });
          continue;
        }
        files.push({ name: part.filename || 'unnamed', buffer: buf, mime: part.mimetype });
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!files.length) return reply.code(400).send({ error: '没有收到文件' });

    let mapping = {};
    try { mapping = fields.senderMap ? JSON.parse(fields.senderMap) : {}; } catch { /* ignore */ }
    const personaLabel = String(fields.personaSender || '').trim();

    const imported = [];
    let totalNew = 0;
    let totalDup = 0;

    for (const f of files) {
      if (f.error) {
        imported.push({ name: f.name, error: f.error });
        continue;
      }
      const parsed = await parseOne(f, p);
      if (parsed.error) {
        imported.push({ name: f.name, error: parsed.error });
        continue;
      }

      const importId = `imp_${crypto.randomUUID()}`;
      const stored = path.join(config.uploadDir, `${importId}_${sanitizeName(f.name)}`);
      fs.mkdirSync(config.uploadDir, { recursive: true });
      fs.writeFileSync(stored, f.buffer);

      const res = persistMessages({
        userId: req.user.id, personaId: p.id, importId,
        messages: parsed.messages, mapping, personaLabel,
      });

      run(`INSERT INTO import_files (id,user_id,persona_id,original_name,stored_path,bytes,mime,status,parser,error,
             message_total,message_new,message_dup,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [importId, req.user.id, p.id, f.name, stored, f.buffer.length, f.mime || null,
          res.added > 0 || res.dup > 0 ? 'parsed' : 'failed',
          parsed.format, res.added > 0 ? null : '所有消息都已存在（重复）',
          parsed.messages.length, res.added, res.dup, Date.now()]);

      totalNew += res.added;
      totalDup += res.dup;
      imported.push({
        id: importId, name: f.name, format: parsed.format,
        total: parsed.messages.length, added: res.added, duplicates: res.dup,
        senders: parsed.senders,
      });
    }

    // auto-detect persona sender if user didn't specify: the one with most lines that isn't obviously "me"
    const senders = collectSenders(p.id);
    if (!personaLabel && senders.length) {
      const best = senders[0];
      if (best) {
        mapping = { ...mapping, [best.name]: 'persona' };
        applyMapping(p.id, req.user.id, mapping);
      }
    } else if (personaLabel) {
      applyMapping(p.id, req.user.id, { [personaLabel]: 'persona' });
    }

    run('UPDATE personas SET updated_at = ? WHERE id = ?', [Date.now(), p.id]);
    audit(req.user.id, 'import.create', { target: p.id, ip: req.ip, meta: { files: imported.length, added: totalNew } });

    // kick off chunk indexing in the background (keyword leg works without embeddings)
    indexInBackground(app, req, p.id);

    return {
      ok: true, imported, added: totalNew, duplicates: totalDup,
      senders: collectSenders(p.id),
      message: totalNew > 0
        ? `已导入 ${totalNew} 条消息${totalDup ? `，跳过 ${totalDup} 条重复` : ''}。`
        : '没有新增消息，可能全部为重复内容。',
    };
  });

  app.delete('/api/imports/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM import_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '导入记录不存在' });
    const del = req.query?.withMessages === '1';
    tx(() => {
      if (del) run('DELETE FROM messages WHERE import_id = ? AND user_id = ?', [row.import_id || row.id, req.user.id]);
      run('DELETE FROM import_files WHERE id = ?', [row.id]);
    });
    try { if (row.stored_path) fs.unlinkSync(row.stored_path); } catch { /* ignore */ }
    if (del) indexInBackground(app, req, row.persona_id);
    return { ok: true, deletedMessages: del };
  });

  /* ----------------------------------- sender mapping correction */
  app.post('/api/personas/:personaId/senders', auth, async (req, reply) => {
    const p = own(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const mapping = req.body?.mapping || {};
    if (typeof mapping !== 'object') return reply.code(400).send({ error: 'mapping 必须是对象' });
    applyMapping(p.id, req.user.id, mapping);
    indexInBackground(app, req, p.id);
    return { ok: true, senders: collectSenders(p.id) };
  });

  app.get('/api/personas/:personaId/senders', auth, async (req, reply) => {
    const p = own(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    return { senders: collectSenders(p.id) };
  });

  /* ------------------------------------ message browser (import) */
  app.get('/api/personas/:personaId/imported-messages', auth, async (req, reply) => {
    const p = own(req, req.params.personaId);
    if (!p) return reply.code(404).send({ error: '人格不存在' });
    const limit = Math.min(200, Number(req.query?.limit) || 50);
    const offset = Math.max(0, Number(req.query?.offset) || 0);
    const role = req.query?.role;
    const where = role ? `AND role = '${role === 'persona' ? 'persona' : 'user'}'` : '';
    const rows = all(
      `SELECT id,role,sender_raw,content,ts,msg_type FROM messages
       WHERE persona_id = ? AND is_imported = 1 ${where}
       ORDER BY COALESCE(ts,0) ASC, seq ASC LIMIT ? OFFSET ?`, [p.id, limit, offset]);
    const total = get(`SELECT COUNT(*) c FROM messages WHERE persona_id = ? AND is_imported = 1 ${where}`, [p.id]).c;
    return { messages: rows, total, limit, offset };
  });

  return app;
}

/* ------------------------------------------------------------------ */

function sanitizeName(n) {
  return String(n || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-80);
}

async function parseOne(f, persona) {
  const base = { name: f.name, format: null, messages: [], senders: [], warnings: [] };
  const lower = String(f.name || '').toLowerCase();

  if (lower.endsWith('.zip')) {
    let entries;
    try {
      entries = extractZip(f.buffer);
    } catch (e) {
      return { ...base, error: `ZIP 解压失败：${e.message}` };
    }
    const usable = entries.filter((e) => isSupportedFile(e.name));
    if (!usable.length) {
      return {
        ...base,
        error: '压缩包中没有可解析的文件。支持 TXT / JSON / CSV / Markdown。请先在原聊天软件中导出为其中之一再打包。',
      };
    }
    const allMsgs = [];
    const senderMap = new Map();
    for (const e of usable) {
      try {
        const r = parseChatFile({ filename: e.name, buffer: e.data });
        // shift seq so ordering is stable across files
        const off = allMsgs.length;
        for (const m of r.messages) allMsgs.push({ ...m, seq: off + m.seq, file: e.name });
        for (const s of r.senders) senderMap.set(s.name, (senderMap.get(s.name) || 0) + s.count);
        base.warnings.push(`${e.name}: ${r.messages.length} 条（${r.format}）`);
      } catch (err) {
        base.warnings.push(`${e.name}: 解析失败 - ${err.message}`);
      }
    }
    if (!allMsgs.length) return { ...base, error: '压缩包内文件都无法解析。' };
    base.messages = allMsgs;
    base.senders = [...senderMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    base.format = 'zip';
    return base;
  }

  if (!isSupportedFile(f.name)) {
    return {
      ...base,
      error: `不支持的文件格式（${path.extname(lower) || '未知'}）。目前支持：TXT、JSON、CSV、Markdown、ZIP。`
        + '微信/QQ 的 .db 或 .dat 加密数据库需要先在客户端用「导出聊天记录」功能导出为 TXT，再上传。',
    };
  }

  try {
    const r = parseChatFile({ filename: f.name, buffer: f.buffer });
    if (!r.messages.length) return { ...base, error: '文件解析后没有消息。请检查文件是否为导出的聊天记录。' };
    return { ...base, format: r.format, messages: r.messages, senders: r.senders };
  } catch (e) {
    return { ...base, error: `解析失败：${e.message}` };
  }
}

function mergeSenders(results) {
  const m = new Map();
  for (const r of results) for (const s of r.senders || []) m.set(s.name, (m.get(s.name) || 0) + s.count);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function previewOf(results) {
  const out = [];
  for (const r of results) {
    for (const m of (r.messages || []).slice(0, 6)) {
      out.push({ sender: m.sender, content: String(m.content).slice(0, 200), ts: m.ts, type: m.type, file: r.name });
    }
  }
  return out.slice(0, 24);
}

/** Decide the canonical role for a raw sender label. */
export function roleFor(sender, personaId) {
  const raw = String(sender || '').trim();
  if (!raw) return 'user';
  const mapped = get(
    `SELECT role FROM messages WHERE persona_id = ? AND sender_raw = ? AND meta_json IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`, [personaId, raw]);
  if (mapped?.role === 'persona') return 'persona';
  // fall back to the persona's configured display alias
  const alias = get('SELECT name FROM personas WHERE id = ?', [personaId])?.name;
  if (alias && raw === alias) return 'persona';
  return 'user';
}

/** Persist parsed messages with dedupe. Returns { added, dup }. */
export function persistMessages({ userId, personaId, importId, messages, mapping = {}, personaLabel = '' }) {
  const personaName = personaLabel || get('SELECT name FROM personas WHERE id = ?', [personaId])?.name || '';
  let added = 0; let dup = 0;
  const seen = new Set();

  tx(() => {
    const stmt = getDb().prepare(
      `INSERT INTO messages (id,user_id,persona_id,chat_id,import_id,role,sender_raw,content,msg_type,ts,seq,
         is_imported,is_persona_voice,dedupe_hash,meta_json,created_at)
       VALUES (?,?,?,NULL,?,?,?,?,?,?,?,1,0,?,?,?)`);

    // continue seq after existing imported messages
    const maxSeq = get('SELECT MAX(seq) s FROM messages WHERE persona_id = ? AND is_imported = 1', [personaId])?.s || 0;
    let seq = maxSeq;

    for (const m of messages) {
      const sender = String(m.sender || '').trim();
      const content = cleanText(m.content || '').slice(0, 20000);
      // 空文本丢；空内容的语音留着 —— 它记录「这个人爱发语音」，
      // 是后面决定输出形态（文字/语音/随机）的依据。
      if (!content && m.type !== 'audio') continue;

      let role;
      if (sender && mapping[sender]) role = mapping[sender] === 'persona' ? 'persona' : 'user';
      else if (personaName && sender && sender === personaName) role = 'persona';
      else role = roleFor(sender, personaId);

      const hash = hashMessage({ sender, ts: m.ts, content });
      if (seen.has(hash)) { dup++; continue; }
      seen.add(hash);

      const exists = get('SELECT id FROM messages WHERE persona_id = ? AND dedupe_hash = ?', [personaId, hash]);
      if (exists) { dup++; continue; }

      seq += 1;
      // meta 里记下「这条是语音、有没有转文字」。
      // 后续统计口语特征、以及判断这个人发语音的频率，都靠这两个标记，
      // 不必再去猜 content 里有没有 [语音] 字样。
      const meta = { file: m.file || null };
      if (m.type === 'audio') {
        meta.voice = true;
        meta.transcript = m.voiceTranscript === true;
      }
      stmt.run(`msg_${crypto.randomUUID()}`, userId, personaId, importId, role, sender || null,
        content, m.type || 'text', m.ts || null, seq, hash,
        JSON.stringify(meta), Date.now());
      added++;
    }
  });
  return { added, dup };
}

function applyMapping(personaId, userId, mapping) {
  tx(() => {
    for (const [raw, role] of Object.entries(mapping)) {
      if (!raw) continue;
      run(`UPDATE messages SET role = ? WHERE persona_id = ? AND user_id = ? AND sender_raw = ? AND is_imported = 1`,
        [role === 'persona' ? 'persona' : 'user', personaId, userId, raw]);
    }
  });
}

export function collectSenders(personaId) {
  const rows = all(
    `SELECT sender_raw AS name, role, COUNT(*) AS count FROM messages
     WHERE persona_id = ? AND is_imported = 1 AND sender_raw IS NOT NULL AND sender_raw != ''
     GROUP BY sender_raw, role ORDER BY count DESC`, [personaId]);
  return rows.map((r) => ({ name: r.name, role: r.role, count: r.count }));
}

function indexInBackground(app, req, personaId) {
  (async () => {
    try {
      const { rebuildChunkIndex, resolveEmbedder } = await import('../lib/memory.js');
      const { loadLlm } = await import('./configs.js');
      const llm = loadLlm(req, app);
      const embedder = llm ? resolveEmbedder(llm) : null;
      await rebuildChunkIndex({
        userId: req.user.id, personaId,
        embedder: embedder && llm.apiKey ? { ...embedder, apiKey: llm.apiKey } : null,
      });
    } catch (e) {
      app.log.warn({ err: e.message }, 'chunk indexing failed (keyword-only fallback in effect)');
    }
  })();
}

// late import to avoid cycles in test runner
import { getDb } from '../db/index.js';
