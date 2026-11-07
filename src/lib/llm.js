import { safeRequest, safeJson, readBody } from './net.js';

/** Normalize a user-supplied base URL into a chat-completions endpoint. */
export function chatEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('缺少 API Base URL');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

export function modelsEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/models$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/models`;
  return `${b}/v1/models`;
}

export function embeddingsEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/embeddings$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/embeddings`;
  return `${b}/v1/embeddings`;
}

function authHeaders(apiKey, extra) {
  const h = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return { ...h, ...(extra || {}) };
}

export function upstreamError(status, text) {
  let detail = '';
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message || j?.message || j?.error || j?.detail || '';
  } catch {
    detail = String(text || '').slice(0, 300);
  }
  const e = new Error(`上游返回 ${status}${detail ? `：${String(detail).slice(0, 300)}` : ''}`);
  e.statusCode = 502;
  e.upstreamStatus = status;
  return e;
}

export async function listModels({ baseUrl, apiKey }) {
  const { status, json, text } = await safeJson(modelsEndpoint(baseUrl), {
    headers: authHeaders(apiKey), method: 'GET', timeoutMs: 30000, maxResponseBytes: 2 * 1024 * 1024,
  });
  if (status >= 400) throw upstreamError(status, text);
  const arr = json?.data || json?.models || [];
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

/** Non-streaming completion. Returns { content, usage, raw } */
export async function chatComplete({ baseUrl, apiKey, model, messages, params = {}, timeoutMs = 120000, signal }) {
  const build = (mt) => ({
    model,
    messages,
    temperature: params.temperature ?? 0.8,
    stream: false,
    ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
    ...(mt ? { max_tokens: mt } : {}),
    ...(params.frequency_penalty !== undefined ? { frequency_penalty: params.frequency_penalty } : {}),
    ...(params.presence_penalty !== undefined ? { presence_penalty: params.presence_penalty } : {}),
  });

  // max_tokens 各家上限差异极大：老的 4k 模型、部分中转只允许 2048/4096，
  // 给 8000 会直接 400，而错误文案往往只有一句「请求错误」，用户完全无从下手。
  // 这里按 8000 -> 4096 -> 2048 逐级降级重试，只在「明确是 max_tokens 太大」
  // 的 400 上重试，其他错误原样抛出，避免掩盖真实问题。
  const initial = params.max_tokens || null;
  const candidates = initial
    ? [initial, ...[4096, 2048].filter((n) => n < initial)]
    : [null];

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const mt = candidates[i];
    const endpoint = chatEndpoint(baseUrl);
    const { res } = await safeRequest(endpoint, {
      method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(build(mt)), timeoutMs, signal,
    });
    const buf = await readBody(res, 16 * 1024 * 1024);
    const text = buf.toString('utf8');

    if (res.statusCode >= 400) {
      const err = upstreamError(res.statusCode, text);
      lastErr = err;
      const msg = String(err.message || '');
      const tokenIssue = res.statusCode === 400
        && /max[_ ]?tokens?|context length|maximum context|too many tokens|invalid.*token/i.test(msg);
      if (tokenIssue && i < candidates.length - 1) continue;
      throw err;
    }

    let json;
    try { json = JSON.parse(text); } catch { throw new Error('上游返回了非 JSON 响应'); }
    const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
    return {
      content: typeof content === 'string' ? content : JSON.stringify(content),
      usage: json?.usage || null, raw: json, url: endpoint,
      maxTokensUsed: mt,
    };
  }
  throw lastErr || new Error('大模型调用失败');
}

/**
 * Streaming completion over SSE. Yields deltas.
 * Yields: {type:'delta', text} | {type:'done', usage} | {type:'error', message}
 */
export async function* chatStream({ baseUrl, apiKey, model, messages, params = {}, timeoutMs = 180000, signal }) {
  const body = {
    model,
    messages,
    temperature: params.temperature ?? 0.85,
    stream: true,
    ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
    ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
    ...(params.frequency_penalty !== undefined ? { frequency_penalty: params.frequency_penalty } : {}),
    ...(params.presence_penalty !== undefined ? { presence_penalty: params.presence_penalty } : {}),
  };
  const { res } = await safeRequest(chatEndpoint(baseUrl), {
    method: 'POST',
    headers: { ...authHeaders(apiKey), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    timeoutMs,
    signal,
  });

  // 本地 mock 上游会带这个头，用于在界面上明确标注「模拟数据」
  const isMock = res.headers['x-ep-mock'] === '1';

  if (res.statusCode >= 400) {
    const buf = await readBody(res, 1024 * 1024);
    throw upstreamError(res.statusCode, buf.toString('utf8'));
  }

  const ct = String(res.headers['content-type'] || '');
  if (!ct.includes('event-stream')) {
    // Some providers ignore stream:true — degrade to one chunk.
    const buf = await readBody(res, 16 * 1024 * 1024);
    const text = buf.toString('utf8');
    try {
      const json = JSON.parse(text);
      const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
      yield { type: 'delta', text: String(content) };
      yield { type: 'done', usage: json?.usage || null, mock: isMock || json?.mock === true };
      return;
    } catch {
      yield { type: 'error', message: `上游未返回 SSE 流：${text.slice(0, 200)}` };
      return;
    }
  }

  let buf = '';
  let usage = null;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { yield { type: 'done', usage, mock: isMock }; return; }
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          const d = j?.choices?.[0]?.delta;
          const piece = d?.content ?? d?.text ?? (typeof j?.choices?.[0]?.text === 'string' ? j.choices[0].text : '');
          if (piece) yield { type: 'delta', text: String(piece) };
          const fr = j?.choices?.[0]?.finish_reason;
          if (fr) { /* keep reading for usage */ }
        } catch { /* skip malformed keepalive */ }
      }
    }
    if (buf.trim().startsWith('data:')) {
      const data = buf.trim().slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          const j = JSON.parse(data);
          const piece = j?.choices?.[0]?.delta?.content;
          if (piece) yield { type: 'delta', text: String(piece) };
        } catch { /* ignore */ }
      }
    }
    yield { type: 'done', usage, mock: isMock };
  } catch (e) {
    if (signal?.aborted) { yield { type: 'done', usage, aborted: true }; return; }
    yield { type: 'error', message: e?.message || '流式读取失败' };
  }
}

export async function embed({ baseUrl, apiKey, model, input, timeoutMs = 60000 }) {
  const body = { model, input };
  const { res } = await safeRequest(embeddingsEndpoint(baseUrl), {
    method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body), timeoutMs,
  });
  const buf = await readBody(res, 32 * 1024 * 1024);
  const text = buf.toString('utf8');
  if (res.statusCode >= 400) throw upstreamError(res.statusCode, text);
  const json = JSON.parse(text);
  const arr = json?.data;
  if (!Array.isArray(arr) || !arr.length) throw new Error('Embedding 响应格式不正确');
  return arr.map((d) => d.embedding);
}
