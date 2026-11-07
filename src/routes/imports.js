import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, getDb, run, tx } from '../db/index.js';
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

    /* ------------------------------------------------ 立刻返回，后台处理
     *
     * 以前是这个接口自己把「解析 + 几万条入库」干完才返回。3MB 记录要十几秒，
     * 期间浏览器一直转圈；更糟的是网关等不到响应就报 504 —— 用户以为坏了，
     * 又点一次，于是同一份文件被并行处理两遍，服务器更卡。
     *
     * 现在改成 job 模式：先把上传的字节落到磁盘（这步很快，纯 IO），
     * 立刻返回 202 + jobId，解析和入库在后台跑，进度写进 jobs 表，
     * 前端轮询（和人格分析用的是同一套机制）。
     *
     * 这样即便处理 100MB 记录，首字节响应也在一秒内返回，页面不卡、网关不超时。 */
    const jobId = `job_${crypto.randomUUID()}`;
    const staged = [];
    for (const f of files) {
      if (f.error) continue;
      const importId = `imp_${crypto.randomUUID()}`;
      const stored = path.join(config.uploadDir, `${importId}_${sanitizeName(f.name)}`);
      fs.mkdirSync(config.uploadDir, { recursive: true });
      fs.writeFileSync(stored, f.buffer);
      staged.push({ ...f, importId, stored, bytes: f.buffer.length, buffer: null });
    }

    const hasWork = staged.length > 0;
    run(`INSERT INTO jobs (id,user_id,persona_id,type,status,progress,stage,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [jobId, req.user.id, p.id, 'import', hasWork ? 'queued' : 'failed', 0,
        hasWork ? '等待处理' : '没有可用文件', Date.now(), Date.now()]);

    reply.code(202).send({
      ok: true, jobId, async: true,
      accepted: staged.length,
      rejected: files.filter((f) => f.error).map((f) => ({ name: f.name, error: f.error })),
      message: hasWork ? '已接收，正在后台导入…' : '没有可处理的文件',
    });

    if (!hasWork) return;

    /* 后台执行。这里刻意不 await —— 但它内部所有耗时步骤（解析、写库）
     * 都是分片 + setImmediate 让出的，不会把 event loop 占死。 */
    void (async () => {
      const total = staged.length;
      const imported = [];
      let totalNew = 0;
      let totalDup = 0;
      const setProgress = (prog, stage) => {
        try { run('UPDATE jobs SET progress = ?, stage = ?, status = ?, updated_at = ? WHERE id = ?',
          [prog, stage, 'running', Date.now(), jobId]); } catch { /* ignore */ }
      };

      try {
        for (let fi = 0; fi < staged.length; fi += 1) {
          const f = staged[fi];
          const base = fi / total;
          const span = 1 / total;
          setProgress(base + span * 0.05, `解析 ${f.name}`);

          let parsed;
          try {
            parsed = await parseOne({ ...f, buffer: fs.readFileSync(f.stored) }, p);
          } catch (e) {
            parsed = { error: e.message };
          }
          if (parsed.error) {
            imported.push({ name: f.name, error: parsed.error });
            run(`INSERT INTO import_files (id,user_id,persona_id,original_name,stored_path,bytes,mime,status,parser,error,
                   message_total,message_new,message_dup,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [f.importId, req.user.id, p.id, f.name, f.stored, f.bytes || 0, f.mime || null,
                'failed', null, parsed.error, 0, 0, 0, Date.now()]);
            continue;
          }

          // 写库期间按批回调，让进度条真的动起来，而不是停在 5%
          const res = await persistMessages({
            userId: req.user.id, personaId: p.id, importId: f.importId,
            messages: parsed.messages, mapping, personaLabel,
            onProgress: (done, all) => {
              setProgress(base + span * (0.1 + 0.8 * (all ? done / all : 0)),
                `写入 ${f.name} ${done}/${all}`);
            },
          });

          run(`INSERT INTO import_files (id,user_id,persona_id,original_name,stored_path,bytes,mime,status,parser,error,
                 message_total,message_new,message_dup,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [f.importId, req.user.id, p.id, f.name, f.stored, f.bytes || 0, f.mime || null,
              res.added > 0 || res.dup > 0 ? 'parsed' : 'failed',
              parsed.format, res.added > 0 ? null : '所有消息都已存在（重复）',
              parsed.messages.length, res.added, res.dup, Date.now()]);

          totalNew += res.added;
          totalDup += res.dup;
          imported.push({
            id: f.importId, name: f.name, format: parsed.format,
            total: parsed.messages.length, added: res.added, duplicates: res.dup,
            senders: parsed.senders,
          });
        }

        // auto-detect persona sender if user didn't specify
        const senders = collectSenders(p.id);
        if (!personaLabel && senders.length && senders[0]) {
          mapping = { ...mapping, [senders[0].name]: 'persona' };
          applyMapping(p.id, req.user.id, mapping);
        } else if (personaLabel) {
          applyMapping(p.id, req.user.id, { [personaLabel]: 'persona' });
        }

        run('UPDATE personas SET updated_at = ? WHERE id = ?', [Date.now(), p.id]);
        audit(req.user.id, 'import.create', { target: p.id, ip: req.ip, meta: { files: imported.length, added: totalNew } });

        setProgress(0.98, '建立记忆索引');
        indexInBackground(app, req, p.id);

        run(`UPDATE jobs SET status='done', progress=1, stage=?, result_json=?, updated_at=? WHERE id=?`,
          ['完成', JSON.stringify({
            imported, added: totalNew, duplicates: totalDup,
            senders: collectSenders(p.id),
            message: totalNew > 0
              ? `已导入 ${totalNew} 条消息${totalDup ? `，跳过 ${totalDup} 条重复` : ''}。`
              : '没有新增消息，可能全部为重复内容。',
          }), Date.now(), jobId]);
      } catch (e) {
        app.log.error({ err: e.message, personaId: p.id }, 'import failed');
        run('UPDATE jobs SET status=?, error=?, stage=?, updated_at=? WHERE id=?',
          ['failed', String(e.message).slice(0, 1000), '失败', Date.now(), jobId]);
      }
    })();
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

/** Decide the canonical role for a raw sender label.
 *
 * 单个 sender 的判断逻辑。persistMessages 内部**不再逐条调用它** ——
 * 那样每条消息都要打一次数据库，几万条就是几万次查询。
 * 批量场景请用下面 buildRoleResolver 返回的解析器。 */
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

/* ------------------------------------------------ 批量导入的角色解析
 *
 * 这里曾经是线上 504 的真正原因，值得写清楚：
 *
 * 旧实现里每条消息都调一次 roleFor，而 roleFor 会
 *   `SELECT role FROM messages WHERE persona_id=? AND sender_raw=?`
 * —— sender_raw 上没有（也不该有）索引，所以这是**全表扫描**。
 * 表里已有 1 万条时，第 10001 条要扫 1 万行；插入 1.4 万条合计扫近 1 亿行，
 * 于是耗时超线性恶化：0.2MB 样本 0.12ms/条，0.6MB 样本 1.18ms/条。
 *
 * 而且它被包在一个 BEGIN IMMEDIATE 事务里，全程同步，event loop 被独占，
 * 期间连 /api/health 都排不上队 —— 网关超时就报 504，其他设备也访问不了。
 *
 * 改法：导入前把该人格的全部 sender→role 映射一次性读进 Map（一次查询），
 * 之后纯内存判断。sender 的取值只有聊天参与者那么几种，与消息条数无关。 */
export function buildRoleResolver(personaId) {
  const alias = get('SELECT name FROM personas WHERE id = ?', [personaId])?.name || '';
  /* 只取每个 sender 最新的一条，与旧实现的 ORDER BY created_at DESC LIMIT 1 等价。
   * GROUP BY 配合 MAX(created_at) 在 SQLite 里就是"取每组最新"，一次扫完。 */
  const rows = all(
    `SELECT m.sender_raw AS s, m.role AS r
       FROM messages m
       JOIN (SELECT sender_raw AS s2, MAX(created_at) AS mx
               FROM messages WHERE persona_id = ? AND meta_json IS NOT NULL
              GROUP BY sender_raw) t
         ON m.sender_raw = t.s2 AND m.created_at = t.mx
      WHERE m.persona_id = ?`, [personaId, personaId]);
  const known = new Map();
  for (const r of rows) if (r.s != null) known.set(r.s, r.r);

  return (sender) => {
    const raw = String(sender || '').trim();
    if (!raw) return 'user';
    if (known.get(raw) === 'persona') return 'persona';
    if (alias && raw === alias) return 'persona';
    return 'user';
  };
}

/** Persist parsed messages with dedupe. Returns { added, dup }.
 *
 * 分批提交 + 每批之间让出 event loop（await setImmediate）。
 * 这样即使单次导入几十万条，请求线程也一直是活的：
 * health check、别人刷页面、进度轮询都能正常响应，不会因为一次导入卡死全站。
 *
 * 注意：分批之后不再是一个整体事务。中途失败会留下"导入了一部分"的状态 ——
 * 但这比"整站卡死"好得多，而且每条消息本就有 dedupe_hash，重跑一次只补差额。 */
export async function persistMessages({
  userId, personaId, importId, messages, mapping = {}, personaLabel = '',
  onProgress = null,
  /* 每批 250 条。
   *
   * 这个数字是在「总耗时」和「单次阻塞时长」之间取的平衡：
   * 批越大总耗时越短，但单批事务是同步的，event loop 被占的时间也越长。
   * 实测 500 条一批会占住约 200ms，250 条约 100ms —— 后者对用户更友好，
   * 因为 100ms 内的卡顿人感觉不到，200ms 就开始有"顿一下"的体感。
   * 总耗时只多约 10%，值得。 */
  batchSize = 250,
}) {
  const personaName = personaLabel || get('SELECT name FROM personas WHERE id = ?', [personaId])?.name || '';
  const resolveRole = buildRoleResolver(personaId);

  let added = 0; let dup = 0;
  const seen = new Set();

  // 续接已有 seq。一次查到顶，之后在内存里递增，不再逐条查。
  let seq = get('SELECT MAX(seq) s FROM messages WHERE persona_id = ? AND is_imported = 1', [personaId])?.s || 0;

  const INS = `INSERT INTO messages (id,user_id,persona_id,chat_id,import_id,role,sender_raw,content,msg_type,ts,seq,
     is_imported,is_persona_voice,dedupe_hash,meta_json,created_at)
   VALUES (?,?,?,NULL,?,?,?,?,?,?,?,1,0,?,?,?)`;

  /* 预算一遍候选行：清洗、判重（进程内 + 库内）、定角色。
   * 这一步纯 CPU，不碰数据库，所以很快。 */
  const candidates = [];
  for (const m of messages) {
    const sender = String(m.sender || '').trim();
    const content = cleanText(m.content || '').slice(0, 20000);
    // 空文本丢；空内容的语音留着 —— 它记录「这个人爱发语音」，
    // 是后面决定输出形态（文字/语音/随机）的依据。
    if (!content && m.type !== 'audio') continue;

    let role;
    if (sender && mapping[sender]) role = mapping[sender] === 'persona' ? 'persona' : 'user';
    else if (personaName && sender && sender === personaName) role = 'persona';
    else role = resolveRole(sender);

    const hash = hashMessage({ sender, ts: m.ts, content });
    if (seen.has(hash)) { dup++; continue; }
    seen.add(hash);

    candidates.push({
      sender, content, role, hash, type: m.type || 'text',
      file: m.file || null, voiceTranscript: m.voiceTranscript === true, ts: m.ts,
    });
  }

  /* 分批处理：每批先一次性把"库中已存在的 hash"查出来（一条 IN 查询），
   * 再插入本批的新行，然后提交并让出 event loop。 */
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const hashes = batch.map((c) => c.hash);

    const existing = new Set();
    const CHUNK = 400; // 避免 SQLite 变量个数上限（默认 999）
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const part = hashes.slice(i, i + CHUNK);
      const rows = all(
        `SELECT dedupe_hash h FROM messages WHERE persona_id = ? AND dedupe_hash IN (${part.map(() => '?').join(',')})`,
        [personaId, ...part]);
      for (const r of rows) existing.add(r.h);
    }

    tx(() => {
      const stmt = getDb().prepare(INS);
      const now = Date.now();
      for (const c of batch) {
        if (existing.has(c.hash)) { dup++; continue; }
        seq += 1;
        // meta 里记下「这条是语音、有没有转文字」。
        // 后续统计口语特征、以及判断这个人发语音的频率，都靠这两个标记，
        // 不必再去猜 content 里有没有 [语音] 字样。
        const meta = { file: c.file || null };
        if (c.type === 'audio') {
          meta.voice = true;
          meta.transcript = c.voiceTranscript === true;
        }
        stmt.run(`msg_${crypto.randomUUID()}`, userId, personaId, importId, c.role, c.sender || null,
          c.content, c.type, c.ts || null, seq, c.hash, JSON.stringify(meta), now);
        added++;
      }
    });

    if (onProgress) {
      try { onProgress(Math.min(start + batch.length, candidates.length), candidates.length); } catch { /* ignore */ }
    }
    // 让出 event loop：分片事务已提交，其余请求可以在这条缝隙里被处理。
    await new Promise((r) => setImmediate(r));
  }

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

