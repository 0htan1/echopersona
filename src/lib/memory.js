import crypto from 'node:crypto';
import {
  all, get, run, toBlob, fromBlob, cosine, l2normalize, tx, hasFts,
} from '../db/index.js';
import { embed as llmEmbed } from './llm.js';
import { hashMessage } from './parsers.js';

/* ------------------------------------------------------------------ *
 * Tokenizer: CJK needs bigrams because FTS5's default tokenizer
 * treats a whole CJK run as one token. We generate bigrams for CJK
 * and keep latin words as-is, then index that synthetic string.
 * ------------------------------------------------------------------ */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

export function tokenizeForIndex(text) {
  const s = String(text || '');
  const out = [];
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) {
    if (!w) continue;
    if (CJK.test(w)) {
      // bigrams + unigrams so single-char queries still match
      for (let i = 0; i < w.length; i++) {
        out.push(w[i]);
        if (i + 1 < w.length) out.push(w[i] + w[i + 1]);
      }
    } else {
      const low = w.toLowerCase();
      if (low.length >= 2) out.push(low);
    }
  }
  return out.join(' ');
}

/** Sanitize a user query into an FTS5 MATCH expression. */
export function toFtsQuery(text) {
  const toks = tokenizeForIndex(text).split(' ').filter((t) => t && t.length >= 1);
  const uniq = [...new Set(toks)].slice(0, 40);
  if (!uniq.length) return null;
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** 关键词查询词元，供 LIKE 降级路径使用（与 FTS 用同一套分词）。 */
export function queryTokens(text) {
  const toks = tokenizeForIndex(text).split(' ').filter(Boolean);
  return [...new Set(toks)].slice(0, 40);
}

/**
 * LIKE 降级检索：没有 FTS5 时按词元做模糊匹配。
 *
 * 只拿「多字词元」做 LIKE，避免单个 bigram 汉字把整库都捞回来；
 * 中文场景下双字 bigram 恰好是合适的检索粒度。
 * 排序用命中词元数，语义上接近 bm25 的「匹配得越多越靠前」。
 *
 * 返回完整业务字段（与 FTS 分支的 SELECT 对齐），否则上层拿不到 content。
 */
function likeSearch({ table, columns, personaId, tokens, select, limit = 40 }) {
  const long = tokens.filter((t) => t.length >= 2);
  const use = long.length ? long : tokens;
  if (!use.length) return [];
  const expr = `(${columns.map((c) => `COALESCE(${c},'')`).join(" || ' ' || ")})`;
  const clauses = use.map(() => `${expr} LIKE ?`).join(' OR ');
  const params = use.map((t) => `%${t}%`);
  const rows = all(
    `SELECT ${select}, ${expr} AS hay FROM ${table}
     WHERE persona_id = ? AND (${clauses}) LIMIT ${limit * 4}`,
    [personaId, ...params]
  );
  return rows
    .map((r) => {
      const hay = String(r.hay || '').toLowerCase();
      const hits = use.reduce((n, t) => n + (hay.includes(t.toLowerCase()) ? 1 : 0), 0);
      return { ...r, hits };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Chunking: group consecutive messages into windows suitable for
 * retrieval, keeping speaker attribution and time boundaries.
 * ------------------------------------------------------------------ */
export function chunkMessages(messages, { maxChars = 900, maxGapMin = 90, minChars = 120 } = {}) {
  const chunks = [];
  let cur = [];
  let curChars = 0;

  const flush = () => {
    if (!cur.length) return;
    const content = cur.map((m) => `${m.role === 'persona' ? 'TA' : '我'}: ${m.content}`).join('\n');
    chunks.push({
      messages: cur.slice(),
      content,
      start_ts: cur[0].ts || null,
      end_ts: cur[cur.length - 1].ts || null,
      start_seq: cur[0].seq ?? null,
      end_seq: cur[cur.length - 1].seq ?? null,
      msg_count: cur.length,
    });
    cur = [];
    curChars = 0;
  };

  for (const m of messages) {
    const len = String(m.content || '').length;
    const prev = cur[cur.length - 1];
    const gap = prev && m.ts && prev.ts ? (m.ts - prev.ts) / 60000 : 0;
    if (cur.length && (curChars + len > maxChars || gap > maxGapMin)) flush();
    cur.push(m);
    curChars += len;
    if (curChars >= maxChars) flush();
  }
  flush();

  // merge trailing tiny chunk into previous
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (last.content.length < minChars) {
      const prev = chunks[chunks.length - 2];
      prev.content += '\n' + last.content;
      prev.messages.push(...last.messages);
      prev.end_ts = last.end_ts;
      prev.end_seq = last.end_seq;
      prev.msg_count += last.msg_count;
      chunks.pop();
    }
  }
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Embedding provider resolution
 * ------------------------------------------------------------------ */
export function resolveEmbedder(llmCfg) {
  if (!llmCfg) return null;
  let params = {};
  try { params = JSON.parse(llmCfg.params_json || '{}'); } catch { /* ignore */ }
  const model = params.embeddingModel;
  if (!model) return null;
  return { baseUrl: llmCfg.base_url, model, provider: llmCfg.provider };
}

export async function embedTexts(embedder, texts, { batchSize = 32 } = {}) {
  if (!embedder) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await llmEmbed({
      baseUrl: embedder.baseUrl,
      apiKey: embedder.apiKey,
      model: embedder.model,
      input: batch,
    });
    for (const v of vectors) out.push(l2normalize(Float32Array.from(v)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Index maintenance
 * ------------------------------------------------------------------ */
export function indexChunk({ userId, personaId, chunk, embedding = null, embedModel = null }) {
  const id = `chk_${crypto.randomUUID()}`;
  run(
    `INSERT INTO memory_chunks (id,user_id,persona_id,start_ts,end_ts,start_seq,end_seq,content,embedding,embed_model,msg_count,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, userId, personaId, chunk.start_ts, chunk.end_ts, chunk.start_seq, chunk.end_seq,
      chunk.content, embedding ? toBlob(embedding) : null, embedModel, chunk.msg_count, Date.now()]
  );
  if (hasFts()) {
    run('INSERT INTO chunks_fts (content_tok, chunk_id, persona_id) VALUES (?,?,?)',
      [tokenizeForIndex(chunk.content), id, personaId]);
  }
  return id;
}

export function indexMemory({ userId, personaId, kind = 'fact', content, salience = 3, confidence = 0.6,
  sourceType = 'manual', sourceRef = null, happenedAt = null, embedding = null, embedModel = null, dedupeHash = null }) {
  const id = `mem_${crypto.randomUUID()}`;
  const now = Date.now();
  const dh = dedupeHash || crypto.createHash('sha256')
    .update(String(content).replace(/\s+/g, '').toLowerCase()).digest('hex').slice(0, 32);
  const existing = get('SELECT id FROM memories WHERE persona_id = ? AND dedupe_hash = ?', [personaId, dh]);
  if (existing) {
    // merge: keep higher salience/confidence, refresh timestamp
    run(`UPDATE memories SET salience = MAX(salience, ?), confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?`,
      [salience, confidence, now, existing.id]);
    return { id: existing.id, merged: true };
  }
  run(
    `INSERT INTO memories (id,user_id,persona_id,kind,content,salience,confidence,source_type,source_ref,
       happened_at,embedding,embed_model,dedupe_hash,is_deleted,edited,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)`,
    [id, userId, personaId, kind, content, salience, confidence, sourceType, sourceRef,
      happenedAt, embedding ? toBlob(embedding) : null, embedModel, dh, now, now]
  );
  if (hasFts()) {
    run('INSERT INTO memories_fts (content_tok, memory_id, persona_id) VALUES (?,?,?)',
      [tokenizeForIndex(content), id, personaId]);
  }
  return { id, merged: false };
}

export function updateMemorySearch(id, personaId, content) {
  if (!hasFts()) return;
  run('DELETE FROM memories_fts WHERE memory_id = ?', [id]);
  run('INSERT INTO memories_fts (content_tok, memory_id, persona_id) VALUES (?,?,?)',
    [tokenizeForIndex(content), id, personaId]);
}

/* ------------------------------------------------------------------ *
 * Hybrid retrieval: vector (cosine over BLOB) + FTS5 keyword, fused
 * with Reciprocal Rank Fusion, then salience/recency re-rank.
 * ------------------------------------------------------------------ */
function rrf(rank, k = 60) { return 1 / (k + rank); }

export async function recallMemories({
  userId, personaId, query, embedder = null, limit = 8, kinds = null, includeChunks = true, chunkLimit = 5,
}) {
  const now = Date.now();
  const scored = new Map();

  // --- keyword search over curated memories
  const ftsQ = toFtsQuery(query);
  if (ftsQ) {
    try {
      const rows = hasFts()
        ? all(
          `SELECT m.id, m.kind, m.content, m.salience, m.confidence, m.source_type, m.happened_at, m.updated_at,
                  bm25(memories_fts) AS score
           FROM memories_fts f JOIN memories m ON m.id = f.memory_id
           WHERE memories_fts MATCH ? AND m.persona_id = ? AND m.is_deleted = 0
           ORDER BY score LIMIT 40`,
          [ftsQ, personaId]
        )
        : likeSearch({
          table: 'memories', columns: ['kind', 'content'], personaId,
          tokens: queryTokens(query), limit: 40,
          select: 'id, kind, content, salience, confidence, source_type, happened_at, updated_at',
        });
      rows.forEach((r, i) => {
        scored.set(r.id, { ...r, type: 'memory', kw: rrf(i + 1), vec: 0 });
      });
    } catch { /* malformed FTS query -> skip keyword leg */ }
  }

  // --- vector search over curated memories
  let queryVec = null;
  if (embedder) {
    try {
      const [v] = await embedTexts(embedder, [query]);
      queryVec = v;
    } catch { queryVec = null; }
  }
  if (queryVec) {
    const rows = all(
      `SELECT id,kind,content,salience,confidence,source_type,happened_at,updated_at,embedding
       FROM memories WHERE persona_id = ? AND is_deleted = 0 AND embedding IS NOT NULL`, [personaId]);
    const sims = [];
    for (const r of rows) {
      const v = fromBlob(r.embedding);
      if (!v) continue;
      sims.push({ ...r, sim: cosine(queryVec, v) });
    }
    sims.sort((a, b) => b.sim - a.sim);
    sims.slice(0, 40).forEach((r, i) => {
      const prev = scored.get(r.id);
      if (prev) prev.vec = rrf(i + 1);
      else scored.set(r.id, { ...r, type: 'memory', kw: 0, vec: rrf(i + 1) });
    });
  }

  // --- fallback when nothing matched: most salient recent memories
  if (scored.size === 0) {
    const rows = all(
      `SELECT id,kind,content,salience,confidence,source_type,happened_at,updated_at
       FROM memories WHERE persona_id = ? AND is_deleted = 0
       ORDER BY salience DESC, updated_at DESC LIMIT ?`, [personaId, limit]);
    rows.forEach((r) => scored.set(r.id, { ...r, type: 'memory', kw: 0, vec: 0 }));
  }

  const rankedMem = [...scored.values()]
    .filter((m) => !kinds || kinds.includes(m.kind))
    .map((m) => {
      const ageDays = m.updated_at ? (now - m.updated_at) / 86400000 : 999;
      const recency = 1 / (1 + Math.log1p(Math.max(0, ageDays)) / 3);
      const base = m.kw + m.vec;
      const score = base * 10 + (m.salience / 5) * 1.2 + recency * 0.4 + (m.confidence || 0.6) * 0.3;
      return { ...m, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // --- historical dialogue chunks
  let chunks = [];
  if (includeChunks) {
    const chScored = new Map();
    if (ftsQ) {
      try {
        const rows = hasFts()
          ? all(
            `SELECT c.id, c.content, c.start_ts, c.end_ts, bm25(chunks_fts) AS score
             FROM chunks_fts f JOIN memory_chunks c ON c.id = f.chunk_id
             WHERE chunks_fts MATCH ? AND c.persona_id = ?
             ORDER BY score LIMIT 30`, [ftsQ, personaId])
          : likeSearch({
            table: 'memory_chunks', columns: ['content'], personaId,
            tokens: queryTokens(query), limit: 30,
            select: 'id, content, start_ts, end_ts',
          });
        rows.forEach((r, i) => chScored.set(r.id, { ...r, kw: rrf(i + 1), vec: 0 }));
      } catch { /* ignore */ }
    }
    if (queryVec) {
      const rows = all(
        `SELECT id,content,start_ts,end_ts,embedding FROM memory_chunks
         WHERE persona_id = ? AND embedding IS NOT NULL`, [personaId]);
      const sims = [];
      for (const r of rows) {
        const v = fromBlob(r.embedding);
        if (!v) continue;
        sims.push({ ...r, sim: cosine(queryVec, v) });
      }
      sims.sort((a, b) => b.sim - a.sim);
      sims.slice(0, 30).forEach((r, i) => {
        const prev = chScored.get(r.id);
        if (prev) prev.vec = rrf(i + 1);
        else chScored.set(r.id, { ...r, kw: 0, vec: rrf(i + 1) });
      });
    }
    chunks = [...chScored.values()]
      .map((c) => ({ ...c, score: (c.kw + c.vec) * 10 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, chunkLimit);
  }

  return { memories: rankedMem, chunks, usedEmbedding: !!queryVec };
}

/** Build the memory block injected into the system prompt. */
export function formatRecallForPrompt({ memories, chunks, maxChars = 2400 }) {
  const parts = [];
  if (memories?.length) {
    parts.push('【长期记忆·结构化要点】（按重要度排序，可信度低的内容不要当作事实断言）');
    for (const m of memories) {
      const conf = m.confidence >= 0.8 ? '' : `（可信度${Math.round((m.confidence || 0.6) * 100)}%）`;
      parts.push(`- [${kindLabel(m.kind)}] ${m.content}${conf}`);
    }
  }
  if (chunks?.length) {
    parts.push('');
    parts.push('【真实历史对话片段】（这是"你"过去真实说过的话，模仿语气时优先参考，不要逐字复述）');
    for (const c of chunks) {
      const when = c.start_ts ? new Date(c.start_ts).toISOString().slice(0, 10) : '未知时间';
      parts.push(`- (${when})\n${indent(c.content, '  ')}`);
    }
  }
  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…（已截断）';
  return out;
}

function indent(s, pad) {
  return String(s).split('\n').map((l) => pad + l).join('\n');
}

export function kindLabel(k) {
  return ({
    fact: '事实', event: '共同经历', topic: '共同话题', preference: '偏好',
    agreement: '约定', nickname: '称呼', quote: '口头禅', other: '其他',
  })[k] || '其他';
}

export const MEMORY_KINDS = ['fact', 'event', 'topic', 'preference', 'agreement', 'nickname', 'quote', 'other'];

/* ------------------------------------------------------------------ *
 * Rebuild chunk index for a persona (used after import / delete)
 * ------------------------------------------------------------------ */
export async function rebuildChunkIndex({ userId, personaId, embedder, onProgress }) {
  const msgs = all(
    `SELECT id, role, content, ts, seq FROM messages
     WHERE persona_id = ? AND is_imported = 1 ORDER BY COALESCE(ts, 0) ASC, seq ASC`, [personaId]);
  const chunks = chunkMessages(msgs);
  tx(() => {
    if (hasFts()) run('DELETE FROM chunks_fts WHERE persona_id = ?', [personaId]);
    run('DELETE FROM memory_chunks WHERE persona_id = ?', [personaId]);
  });

  let embedded = 0;
  if (embedder && chunks.length) {
    try {
      const vectors = await embedTexts(embedder, chunks.map((c) => c.content));
      chunks.forEach((c, i) => {
        indexChunk({ userId, personaId, chunk: c, embedding: vectors[i], embedModel: embedder.model });
        embedded++;
        onProgress?.(i + 1, chunks.length);
      });
      return { chunks: chunks.length, embedded };
    } catch {
      // fall through to keyword-only indexing
    }
  }
  for (let i = 0; i < chunks.length; i++) {
    indexChunk({ userId, personaId, chunk: chunks[i] });
    onProgress?.(i + 1, chunks.length);
  }
  return { chunks: chunks.length, embedded };
}

export { hashMessage };
