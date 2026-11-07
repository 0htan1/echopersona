import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { all, get, run, tx } from '../db/index.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto.js';
import { validateUpstreamUrl } from '../lib/net.js';
import { audit } from '../lib/auth.js';
import { listModels, chatComplete } from '../lib/llm.js';
import {
  detectKind, listVoices, synthesize, previewVoiceStream, cloneVoice, deleteVoice,
  normalizeOutputFormat, BREEZE_BLUE_DEFAULT_BASE,
} from '../lib/tts.js';

export default async function configRoutes(app) {
  const auth = { preHandler: app.requireAuth };

  /* ---------------------------------------------------------- LLM */
  app.get('/api/llm-configs', auth, async (req) => {
    const rows = all('SELECT * FROM llm_configs WHERE user_id = ? ORDER BY is_default DESC, created_at ASC', [req.user.id]);
    return {
      configs: rows.map((r) => ({
        id: r.id, label: r.label, provider: r.provider, baseUrl: r.base_url,
        model: r.model, params: safeJson(r.params_json, {}),
        hasKey: !!r.api_key_enc, keyHint: r.api_key_enc ? maskSecret(decryptOrNull(r.api_key_enc)) : '',
        isDefault: !!r.is_default, lastTestedAt: r.last_tested_at, lastTestOk: r.last_test_ok,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/llm-configs', auth, async (req, reply) => {
    const b = req.body || {};
    const label = String(b.label || '').trim().slice(0, 60);
    const baseUrl = String(b.baseUrl || '').trim();
    const model = String(b.model || '').trim();
    const apiKey = String(b.apiKey || '').trim();
    if (!label) return reply.code(400).send({ error: '请填写配置名称' });
    if (!model) return reply.code(400).send({ error: '请填写模型名称' });
    if (!apiKey) return reply.code(400).send({ error: '请填写 API Key' });
    try {
      await validateUpstreamUrl(baseUrl);
    } catch (e) {
      return reply.code(400).send({ error: `Base URL 不合法：${e.message}` });
    }
    const persist = b.saveKey !== false;   // default: save encrypted
    const id = `llm_${crypto.randomUUID()}`;
    const now = Date.now();
    const isFirst = !get('SELECT id FROM llm_configs WHERE user_id = ?', [req.user.id]);
    tx(() => {
      if (b.isDefault && !isFirst) run('UPDATE llm_configs SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      run(`INSERT INTO llm_configs (id,user_id,label,provider,base_url,api_key_enc,model,params_json,is_default,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, req.user.id, label, b.provider || 'openai-compatible', baseUrl,
          persist ? encryptSecret(apiKey) : null, model,
          JSON.stringify(sanitizeParams(b.params)), (b.isDefault || isFirst) ? 1 : 0, now, now]);
      if (!persist) {
        // temporary mode: keep key in memory-only cache for this session
        app.tempKeys.set(`${req.user.id}:${id}`, apiKey);
      }
    });
    audit(req.user.id, 'llm_config.create', { target: id, ip: req.ip });
    return { ok: true, id, saved: persist };
  });

  app.patch('/api/llm-configs/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM llm_configs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '配置不存在' });
    const b = req.body || {};
    const sets = [];
    const vals = [];
    if (b.label !== undefined) { sets.push('label = ?'); vals.push(String(b.label).trim().slice(0, 60)); }
    if (b.baseUrl !== undefined) {
      try { await validateUpstreamUrl(b.baseUrl); } catch (e) {
        return reply.code(400).send({ error: `Base URL 不合法：${e.message}` });
      }
      sets.push('base_url = ?'); vals.push(String(b.baseUrl).trim());
    }
    if (b.model !== undefined) { sets.push('model = ?'); vals.push(String(b.model).trim()); }
    if (b.provider !== undefined) { sets.push('provider = ?'); vals.push(String(b.provider).slice(0, 40)); }
    if (b.params !== undefined) { sets.push('params_json = ?'); vals.push(JSON.stringify(sanitizeParams(b.params))); }
    if (b.apiKey) {
      if (b.saveKey === false) {
        app.tempKeys.set(`${req.user.id}:${row.id}`, String(b.apiKey).trim());
      } else {
        sets.push('api_key_enc = ?'); vals.push(encryptSecret(String(b.apiKey).trim()));
        app.tempKeys.delete(`${req.user.id}:${row.id}`);
      }
    }
    if (!sets.length) return reply.code(400).send({ error: '没有需要更新的字段' });
    sets.push('updated_at = ?'); vals.push(Date.now(), row.id);
    run(`UPDATE llm_configs SET ${sets.join(', ')} WHERE id = ?`, vals);
    audit(req.user.id, 'llm_config.update', { target: row.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/llm-configs/:id/default', auth, async (req, reply) => {
    const row = get('SELECT id FROM llm_configs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '配置不存在' });
    tx(() => {
      run('UPDATE llm_configs SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      run('UPDATE llm_configs SET is_default = 1, updated_at = ? WHERE id = ?', [Date.now(), row.id]);
    });
    return { ok: true };
  });

  app.delete('/api/llm-configs/:id', auth, async (req, reply) => {
    const row = get('SELECT id FROM llm_configs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '配置不存在' });
    run('DELETE FROM llm_configs WHERE id = ?', [row.id]);
    app.tempKeys.delete(`${req.user.id}:${row.id}`);
    audit(req.user.id, 'llm_config.delete', { target: row.id, ip: req.ip });
    return { ok: true };
  });

  /* 探测模型列表：不落库。
   *
   * 「读取可用模型」按钮存在的意义是「先看看这家上游有哪些模型」，
   * 用户此刻还没决定要不要保存。旧实现靠「先创建一条临时配置再测试」来复用
   * /:id/test，结果是每点一次就多一条记录，点三次页面上三张一样的卡片。
   *
   * 所以单独开一个只读端点：校验 URL（SSRF）、拿模型列表、返回，一行都不写库。
   * 限流比普通接口更紧 —— 它是对外的 GET，不该被当成免费探测代理。 */
  app.post('/api/llm-configs/probe', {
    preHandler: app.requireAuth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['baseUrl', 'apiKey'],
        properties: {
          baseUrl: { type: 'string', maxLength: 500 },
          apiKey: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const baseUrl = String(req.body.baseUrl || '').trim();
    const apiKey = String(req.body.apiKey || '').trim();
    if (!baseUrl) return reply.code(400).send({ error: '请填写 Base URL' });
    if (!apiKey) return reply.code(400).send({ error: '请填写 API Key' });
    try {
      await validateUpstreamUrl(baseUrl);
    } catch (e) {
      return reply.code(400).send({ error: `Base URL 不合法：${e.message}` });
    }
    const started = Date.now();
    try {
      const models = await listModels({ baseUrl, apiKey });
      return { ok: true, modelCount: models.length, models: models.slice(0, 200), latencyMs: Date.now() - started };
    } catch (e) {
      return reply.code(502).send({ error: e.message, latencyMs: Date.now() - started });
    }
  });

  // test connection: list models
  app.post('/api/llm-configs/:id/test', auth, async (req, reply) => {
    // 必须把 :id 传进去，否则 loadLlm 会取「默认配置」——
    // 在 A 上点测试、实际测的是 B，配错了也看不出来。
    const cfg = loadLlm(req, app, req.params.id);
    if (!cfg) return reply.code(404).send({ error: '配置不存在' });
    if (!cfg.apiKey) return reply.code(400).send({ error: '该配置没有可用的 API Key（临时密钥在服务重启后失效，请重新填写）' });
    const started = Date.now();
    try {
      const models = await listModels({ baseUrl: cfg.base_url, apiKey: cfg.apiKey });
      run('UPDATE llm_configs SET last_tested_at = ?, last_test_ok = 1 WHERE id = ?', [Date.now(), cfg.id]);
      return { ok: true, modelCount: models.length, models: models.slice(0, 200), latencyMs: Date.now() - started };
    } catch (e) {
      run('UPDATE llm_configs SET last_tested_at = ?, last_test_ok = 0 WHERE id = ?', [Date.now(), cfg.id]);
      return reply.code(502).send({ error: e.message, latencyMs: Date.now() - started });
    }
  });

  // test an actual reply
  app.post('/api/llm-configs/:id/test-chat', auth, async (req, reply) => {
    const cfg = loadLlm(req, app, req.params.id);
    if (!cfg) return reply.code(404).send({ error: '配置不存在' });
    if (!cfg.apiKey) return reply.code(400).send({ error: '该配置没有可用的 API Key' });
    const prompt = String(req.body?.prompt || '用一句话介绍你自己。').slice(0, 500);
    const started = Date.now();
    try {
      const r = await chatComplete({
        baseUrl: cfg.base_url, apiKey: cfg.apiKey, model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        params: { temperature: 0.7, max_tokens: 200 }, timeoutMs: 60000,
      });
      run('UPDATE llm_configs SET last_tested_at = ?, last_test_ok = 1 WHERE id = ?', [Date.now(), cfg.id]);
      return { ok: true, reply: r.content, usage: r.usage, latencyMs: Date.now() - started };
    } catch (e) {
      return reply.code(502).send({ error: e.message, latencyMs: Date.now() - started });
    }
  });

  /* ---------------------------------------------------------- TTS */
  app.get('/api/tts-configs', auth, async (req) => {
    const rows = all('SELECT * FROM tts_configs WHERE user_id = ? ORDER BY is_default DESC, created_at ASC', [req.user.id]);
    return {
      configs: rows.map((r) => ({
        id: r.id, label: r.label, kind: r.kind, detectedKind: r.detected_kind, baseUrl: r.base_url,
        model: r.model, settings: safeJson(r.settings_json, {}),
        hasKey: !!r.api_key_enc, keyHint: r.api_key_enc ? maskSecret(decryptOrNull(r.api_key_enc)) : '',
        isDefault: !!r.is_default, lastTestedAt: r.last_tested_at, lastTestOk: r.last_test_ok, createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/tts-configs', auth, async (req, reply) => {
    const b = req.body || {};
    const label = String(b.label || '').trim().slice(0, 60);
    let baseUrl = String(b.baseUrl || '').trim();
    if (!label) return reply.code(400).send({ error: '请填写配置名称' });
    // 选了 Breeze Blue 托管版却没填地址时用官方默认地址，省得用户去猜。
    if (!baseUrl) {
      if (b.kind === 'breezeblue' || b.kind === 'auto' || b.kind === undefined) {
        baseUrl = BREEZE_BLUE_DEFAULT_BASE;
      } else {
        return reply.code(400).send({ error: '请填写 TTS 服务地址' });
      }
    }
    try { await validateUpstreamUrl(baseUrl); } catch (e) {
      return reply.code(400).send({ error: `TTS 服务地址不合法：${e.message}` });
    }
    let kind = ['breezeblue', 'breeze_local'].includes(b.kind) ? b.kind : 'auto';
    const apiKey = String(b.apiKey || '').trim();
    let detected = null;
    if (kind === 'auto') {
      detected = await detectKind({ baseUrl, apiKey }).catch(() => null);
      if (!detected) {
        return reply.code(400).send({
          error: '无法自动识别该 TTS 服务的接口类型。请确认地址可访问，或在创建时明确选择「Breeze Blue 托管版 / 自托管 breeze-tts-2」。',
        });
      }
      kind = detected;
    }
    const persist = b.saveKey !== false;
    const id = `tts_${crypto.randomUUID()}`;
    const now = Date.now();
    const isFirst = !get('SELECT id FROM tts_configs WHERE user_id = ?', [req.user.id]);
    tx(() => {
      if (b.isDefault && !isFirst) run('UPDATE tts_configs SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      run(`INSERT INTO tts_configs (id,user_id,label,kind,base_url,api_key_enc,model,settings_json,is_default,detected_kind,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, req.user.id, label, kind, baseUrl, persist ? encryptSecret(apiKey) : null,
          String(b.model || '').trim() || null, JSON.stringify(sanitizeTts(b.settings)),
          (b.isDefault || isFirst) ? 1 : 0, detected, now, now]);
      if (!persist && apiKey) app.tempKeys.set(`${req.user.id}:${id}`, apiKey);
    });
    audit(req.user.id, 'tts_config.create', { target: id, ip: req.ip });
    return { ok: true, id, kind, detected };
  });

  app.patch('/api/tts-configs/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM tts_configs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '配置不存在' });
    const b = req.body || {};
    const sets = []; const vals = [];
    if (b.label !== undefined) { sets.push('label = ?'); vals.push(String(b.label).trim().slice(0, 60)); }
    if (b.baseUrl !== undefined) {
      try { await validateUpstreamUrl(b.baseUrl); } catch (e) {
        return reply.code(400).send({ error: `TTS 服务地址不合法：${e.message}` });
      }
      sets.push('base_url = ?'); vals.push(String(b.baseUrl).trim());
    }
    if (b.kind !== undefined && ['breezeblue', 'breeze_local'].includes(b.kind)) { sets.push('kind = ?'); vals.push(b.kind); }
    if (b.model !== undefined) { sets.push('model = ?'); vals.push(String(b.model).trim() || null); }
    if (b.settings !== undefined) { sets.push('settings_json = ?'); vals.push(JSON.stringify(sanitizeTts(b.settings))); }
    if (b.apiKey) {
      if (b.saveKey === false) app.tempKeys.set(`${req.user.id}:${row.id}`, String(b.apiKey).trim());
      else { sets.push('api_key_enc = ?'); vals.push(encryptSecret(String(b.apiKey).trim())); app.tempKeys.delete(`${req.user.id}:${row.id}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: '没有需要更新的字段' });
    sets.push('updated_at = ?'); vals.push(Date.now(), row.id);
    run(`UPDATE tts_configs SET ${sets.join(', ')} WHERE id = ?`, vals);
    return { ok: true };
  });

  app.post('/api/tts-configs/:id/default', auth, async (req, reply) => {
    const row = get('SELECT id FROM tts_configs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '配置不存在' });
    tx(() => {
      run('UPDATE tts_configs SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      run('UPDATE tts_configs SET is_default = 1, updated_at = ? WHERE id = ?', [Date.now(), row.id]);
    });
    return { ok: true };
  });

  app.delete('/api/tts-configs/:id', auth, async (req, reply) => {
    const row = get('SELECT id FROM tts_configs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '配置不存在' });
    run('DELETE FROM tts_configs WHERE id = ?', [row.id]);
    app.tempKeys.delete(`${req.user.id}:${row.id}`);
    audit(req.user.id, 'tts_config.delete', { target: row.id, ip: req.ip });
    return { ok: true };
  });

  // 列出账号里已有的音色，供前端下拉挑选。
  // 用户以前只能自己知道 voc_xxx 才能填 —— 实际上 key 一读就能拉全量列表，
  // 没有必要让人去猜 ID。这里把列表直接给前端。
  app.get('/api/tts-configs/:id/voices', auth, async (req, reply) => {
    const cfg = loadTts(req, app);
    if (!cfg) return reply.code(404).send({ error: '配置不存在' });
    const q = String(req.query?.q || '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 60));
    try {
      const kind = cfg.kind === 'auto' ? await detectKind({ baseUrl: cfg.base_url, apiKey: cfg.apiKey }) : cfg.kind;
      if (!kind) return reply.code(400).send({ error: '无法识别 TTS 服务类型，请先点「测试」' });
      const r = await listVoices({ kind, baseUrl: cfg.base_url, apiKey: cfg.apiKey });
      let list = r.voices || [];
      if (q) {
        list = list.filter((v) => `${v.name || ''} ${v.description || ''} ${v.voiceId || ''}`
          .toLowerCase().includes(q));
      }
      return { ok: true, kind, total: (r.voices || []).length, voices: list.slice(0, limit), note: r.note || null };
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  });

  app.post('/api/tts-configs/:id/test', auth, async (req, reply) => {
    const cfg = loadTts(req, app);
    if (!cfg) return reply.code(404).send({ error: '配置不存在' });
    const started = Date.now();
    try {
      const kind = cfg.kind === 'auto' ? await detectKind({ baseUrl: cfg.base_url, apiKey: cfg.apiKey }) : cfg.kind;
      if (!kind) return reply.code(400).send({ error: '无法识别服务类型' });
      const voices = await listVoices({ kind, baseUrl: cfg.base_url, apiKey: cfg.apiKey });
      run('UPDATE tts_configs SET last_tested_at = ?, last_test_ok = 1, detected_kind = ?, kind = ? WHERE id = ?',
        [Date.now(), kind, kind, cfg.id]);
      return { ok: true, kind, voices: voices.voices, note: voices.note || null, latencyMs: Date.now() - started };
    } catch (e) {
      run('UPDATE tts_configs SET last_tested_at = ?, last_test_ok = 0 WHERE id = ?', [Date.now(), cfg.id]);
      return reply.code(502).send({ error: e.message, latencyMs: Date.now() - started });
    }
  });

  // synthesize a short test line without persisting
  app.post('/api/tts-configs/:id/test-speak', auth, async (req, reply) => {
    const cfg = loadTts(req, app);
    if (!cfg) return reply.code(404).send({ error: '配置不存在' });
    const text = String(req.body?.text || '你好，这是一段语音测试。').slice(0, 200);
    const voiceRefId = req.body?.voiceRefId || null;
    let remoteVoiceId = req.body?.voiceId || null;
    let refAudio = null;
    let refText = '';
    if (voiceRefId) {
      const v = get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [voiceRefId, req.user.id]);
      if (v) {
        remoteVoiceId = v.remote_voice_id || remoteVoiceId;
        refText = v.ref_text || '';
        if (v.file_path && fs.existsSync(v.file_path)) {
          refAudio = { buffer: fs.readFileSync(v.file_path), mime: v.mime || 'audio/wav', filename: path.basename(v.file_path) };
        }
      }
    }
    const settings = safeJson(cfg.settings_json, {});
    try {
      const out = await synthesize({
        kind: cfg.kind, baseUrl: cfg.base_url, apiKey: cfg.apiKey,
        text, model: cfg.model, voiceId: remoteVoiceId,
        language: req.body?.language || 'zh',
        speed: settings.speed ?? 1, volume: settings.volume ?? 1,
        guidanceScale: settings.guidanceScale ?? null,
        useSpeakerBoost: !!settings.useSpeakerBoost,
        outputFormat: settings.outputFormat || 'mp3',
        instructions: settings.instructions || '',
        refAudio, refText, cfgScale: settings.cfgScale ?? 4, seed: settings.seed ?? 42,
        timeoutMs: 90000,
      });
      reply.type(out.mime).header('cache-control', 'no-store');
      return reply.send(out.buffer);
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  });

  /* ------------------------------------------------- voice refs */
  // 远端（账号里）的音色列表，供「编辑音色」弹窗挑选。
  // 用默认 TTS 配置去读；没有配置就明确告诉前端去配，而不是静默返回空。
  app.get('/api/voice-refs/remote-voices', auth, async (req, reply) => {
    const row = get(
      'SELECT * FROM tts_configs WHERE user_id = ? ORDER BY is_default DESC, created_at ASC LIMIT 1',
      [req.user.id]
    );
    if (!row) {
      return reply.code(400).send({ error: '还没有 TTS 配置，请先在下面添加一个' });
    }
    const q = String(req.query?.q || '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 40));
    let apiKey = '';
    try { apiKey = row.api_key_enc ? (decryptOrNull(row.api_key_enc) || '') : ''; } catch { apiKey = ''; }
    try {
      const kind = row.kind === 'auto' ? await detectKind({ baseUrl: row.base_url, apiKey }) : row.kind;
      if (!kind) return reply.code(400).send({ error: '无法识别 TTS 服务类型，请先点「测试」' });
      const r = await listVoices({ kind, baseUrl: row.base_url, apiKey });
      const allVoices = r.voices || [];
      let list = allVoices;
      if (q) {
        list = list.filter((v) => `${v.name || ''} ${v.description || ''} ${v.voiceId || ''}`
          .toLowerCase().includes(q));
      }
      return { ok: true, kind, total: allVoices.length, voices: list.slice(0, limit), note: r.note || null };
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  });

  app.get('/api/voice-refs', auth, async (req) => {
    const rows = all('SELECT * FROM voice_refs WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', [req.user.id]);
    return {
      voices: rows.map((r) => ({
        id: r.id, name: r.name, refText: r.ref_text, provider: r.provider,
        remoteVoiceId: r.remote_voice_id, isDefault: !!r.is_default, consent: !!r.consent,
        hasAudio: !!r.file_path, durationSec: r.duration_sec, bytes: r.bytes, createdAt: r.created_at,
        audioUrl: r.file_path ? `/api/voice-refs/${r.id}/audio` : null,
      })),
    };
  });

  /* 建音色有两条路，都进这一个接口，靠 content-type 分流：
   *   1) multipart 带音频文件 → 克隆一个新音色（原路径）
   *   2) 纯 JSON + remoteVoiceId → 直接挂上游已有的音色 ID
   * 第 2 条是后加的：TTS 服务商本来就有训练好的音色库（voice_xxx），
   * 直接引用 ID 又快又不占存储，没必要逼用户先录一段音频再克隆。
   * 同一个上游音色不允许重复挂，否则「默认音色」会冒出两条一模一样的。 */
  app.post('/api/voice-refs', async (req, reply) => {
    if (String(req.headers['content-type'] || '').includes('application/json')) {
      const b = req.body || {};
      const remoteVoiceId = String(b.remoteVoiceId || '').trim().slice(0, 120);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!remoteVoiceId) return reply.code(400).send({ error: '请上传参考音频文件，或填写音色 ID' });
      if (!name) return reply.code(400).send({ error: '请填写音色名称' });
      const dup = get('SELECT id FROM voice_refs WHERE user_id = ? AND remote_voice_id = ?',
        [req.user.id, remoteVoiceId]);
      if (dup) return reply.code(409).send({ error: '这个音色已经添加过了', code: 'DUPLICATE', id: dup.id });
      const id = `vrf_${crypto.randomUUID()}`;
      const isFirst = !get('SELECT id FROM voice_refs WHERE user_id = ?', [req.user.id]);
      run(`INSERT INTO voice_refs (id,user_id,name,file_path,mime,bytes,ref_text,provider,remote_voice_id,consent,is_default,created_at)
           VALUES (?,?,?,NULL,NULL,NULL,?,?,?,1,?,?)`,
        [id, req.user.id, name, String(b.refText || '').slice(0, 1000),
          b.provider || null, remoteVoiceId, isFirst ? 1 : 0, Date.now()]);
      audit(req.user.id, 'voice_ref.create_remote', { target: id, ip: req.ip, meta: { remoteVoiceId } });
      return { ok: true, id };
    }

    const parts = req.parts();
    const fields = {};
    let saved = null;
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== 'audio') { await part.toBuffer(); continue; }
        const buf = await part.toBuffer();
        if (buf.length > config.maxAudioRefBytes) {
          return reply.code(413).send({ error: `参考音频不能超过 ${Math.round(config.maxAudioRefBytes / 1024 / 1024)}MB` });
        }
        if (!/^audio\//.test(part.mimetype || '') && !/\.(wav|mp3|m4a|ogg|opus|flac|aac|webm|wma|aiff?)$/i.test(part.filename || '')) {
          return reply.code(400).send({ error: '参考音频格式不支持。请上传 WAV / MP3 / M4A / FLAC / OGG / AAC / WEBM 等音频文件。' });
        }
        const ext = path.extname(part.filename || '').toLowerCase() ||
          ({ 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/flac': '.flac' }[part.mimetype] || '.wav');
        const name = `vref_${crypto.randomUUID()}${ext}`;
        const p = path.join(config.uploadDir, 'voices', name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, buf);
        saved = { path: p, mime: part.mimetype, bytes: buf.length, filename: part.filename };
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!saved) return reply.code(400).send({ error: '请上传参考音频文件' });
    if (!fields.name?.trim()) return reply.code(400).send({ error: '请填写音色名称' });
    if (fields.consent !== 'true' && fields.consent !== '1') {
      fs.unlinkSync(saved.path);
      return reply.code(400).send({ error: '必须确认你已获得该声音所有者的授权，才能上传参考音频' });
    }
    const id = `vrf_${crypto.randomUUID()}`;
    const isFirst = !get('SELECT id FROM voice_refs WHERE user_id = ?', [req.user.id]);
    run(`INSERT INTO voice_refs (id,user_id,name,file_path,mime,bytes,ref_text,provider,consent,is_default,created_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
      [id, req.user.id, fields.name.trim().slice(0, 80), saved.path, saved.mime, saved.bytes,
        String(fields.refText || '').slice(0, 1000), fields.provider || null, isFirst ? 1 : 0, Date.now()]);
    audit(req.user.id, 'voice_ref.create', { target: id, ip: req.ip });
    return { ok: true, id };
  });

  app.patch('/api/voice-refs/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音色不存在' });
    const b = req.body || {};
    if (b.name !== undefined) run('UPDATE voice_refs SET name = ? WHERE id = ?', [String(b.name).trim().slice(0, 80), row.id]);
    if (b.refText !== undefined) run('UPDATE voice_refs SET ref_text = ? WHERE id = ?', [String(b.refText).slice(0, 1000), row.id]);
    if (b.remoteVoiceId !== undefined) run('UPDATE voice_refs SET remote_voice_id = ? WHERE id = ?', [String(b.remoteVoiceId).slice(0, 120) || null, row.id]);
    return { ok: true };
  });

  app.post('/api/voice-refs/:id/default', auth, async (req, reply) => {
    const row = get('SELECT id FROM voice_refs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音色不存在' });
    tx(() => {
      run('UPDATE voice_refs SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      run('UPDATE voice_refs SET is_default = 1 WHERE id = ?', [row.id]);
    });
    return { ok: true };
  });

  app.delete('/api/voice-refs/:id', auth, async (req, reply) => {
    const row = get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音色不存在' });
    // try to remove the remote clone too
    const tts = get('SELECT * FROM tts_configs WHERE user_id = ? AND is_default = 1', [req.user.id]);
    if (row.remote_voice_id && tts) {
      const key = resolveTtsKey(req, app, tts);
      if (key) { try { await deleteVoice({ baseUrl: tts.base_url, apiKey: key, voiceId: row.remote_voice_id }); } catch { /* best effort */ } }
    }
    run('UPDATE personas SET voice_ref_id = NULL WHERE voice_ref_id = ?', [row.id]);
    run('DELETE FROM voice_refs WHERE id = ?', [row.id]);
    try { if (row.file_path) fs.unlinkSync(row.file_path); } catch { /* ignore */ }
    return { ok: true };
  });

  app.get('/api/voice-refs/:id/audio', auth, async (req, reply) => {
    const row = get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) return reply.code(404).send({ error: '音频不存在' });
    reply.type(row.mime || 'audio/wav').header('cache-control', 'private, max-age=600');
    return reply.send(fs.createReadStream(row.file_path));
  });

  // clone reference audio into a hosted Breeze Blue voice
  app.post('/api/voice-refs/:id/clone', auth, async (req, reply) => {
    const row = get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音色不存在' });
    const cfg = loadTts(req, app);
    if (!cfg) return reply.code(400).send({ error: '请先配置并选择默认的 BreezeTTS 服务' });
    if (cfg.kind === 'breeze_local') {
      return reply.code(400).send({ error: '自托管 breeze-tts-2 模式不需要预先克隆，每次生成时直接上传参考音频即可。' });
    }
    if (!row.file_path || !fs.existsSync(row.file_path)) return reply.code(400).send({ error: '参考音频文件缺失' });
    try {
      const r = await cloneVoice({
        baseUrl: cfg.base_url, apiKey: cfg.apiKey, name: row.name,
        audioBuffer: fs.readFileSync(row.file_path), mime: row.mime,
        filename: path.basename(row.file_path), language: req.body?.language || 'zh',
      });
      run('UPDATE voice_refs SET remote_voice_id = ?, provider = ? WHERE id = ?', [r.voiceId, 'breezeblue', row.id]);
      audit(req.user.id, 'voice_ref.clone', { target: row.id, ip: req.ip });
      return { ok: true, voiceId: r.voiceId };
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  });

  app.get('/api/voice-refs/:id/preview', auth, async (req, reply) => {
    const row = get('SELECT * FROM voice_refs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '音色不存在' });
    const cfg = loadTts(req, app);
    if (!cfg || cfg.kind !== 'breezeblue' || !row.remote_voice_id) {
      return reply.code(400).send({ error: '该音色尚未克隆到 Breeze Blue，无法试听克隆效果' });
    }
    try {
      const out = await previewVoiceStream({ baseUrl: cfg.base_url, apiKey: cfg.apiKey, generatedVoiceId: row.remote_voice_id });
      reply.type(out.mime);
      return reply.send(out.buffer);
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  });
}

/* --------------------------------------------------------------- */
export function sanitizeParams(p) {
  const o = (p && typeof p === 'object') ? p : {};
  const num = (v, min, max, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  };
  return {
    temperature: num(o.temperature, 0, 2, 0.8),
    top_p: num(o.top_p, 0, 1, 1),
    max_tokens: Math.round(num(o.max_tokens, 64, 32000, 1024)),
    frequency_penalty: num(o.frequency_penalty, -2, 2, 0),
    presence_penalty: num(o.presence_penalty, -2, 2, 0),
    ...(o.embeddingModel ? { embeddingModel: String(o.embeddingModel).slice(0, 120) } : {}),
  };
}

export function sanitizeTts(s) {
  const o = (s && typeof s === 'object') ? s : {};
  const num = (v, min, max, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  };
  return {
    speed: num(o.speed, 0.5, 2, 1),
    volume: num(o.volume, 0.01, 2, 1),
    // Breeze Blue 文档：guidance_scale 1.0–10.0，控制对 instructions 的遵循强度
    guidanceScale: o.guidanceScale === null || o.guidanceScale === undefined || o.guidanceScale === ''
      ? null : num(o.guidanceScale, 1, 10, null),
    useSpeakerBoost: !!o.useSpeakerBoost,
    // 只接受文档枚举（mp3 / wav / flac / pcm / aac / opus 及其带采样率/码率的变体）
    outputFormat: normalizeOutputFormat(o.outputFormat),
    cfgScale: num(o.cfgScale, 1, 10, 4),
    seed: Number.isFinite(Number(o.seed)) ? Math.round(Number(o.seed)) : 42,
    instructions: String(o.instructions || '').slice(0, 500),
    emotion: String(o.emotion || '').slice(0, 40),
  };
}

export function safeJson(s, d) {
  try { return s ? JSON.parse(s) : d; } catch { return d; }
}

export function decryptOrNull(enc) {
  try { return decryptSecret(enc); } catch { return null; }
}

/** Resolve API key: in-memory temp key wins, else encrypted column. */
export function resolveLlmKey(req, app, row) {
  return app.tempKeys.get(`${row.user_id}:${row.id}`) || decryptOrNull(row.api_key_enc);
}
export function resolveTtsKey(req, app, row) {
  return app.tempKeys.get(`${row.user_id}:${row.id}`) || decryptOrNull(row.api_key_enc);
}

/**
 * 取一条可用的大模型配置。
 *
 * 仍然要排除 provider='workbuddy-cloud'：那是历史遗留的云通道记录。
 * 新版本已经彻底移除了云通道，但老数据库里可能还留着这些行 ——
 * 它们没有 api_key_enc，被选中就会报 NO_API_KEY，表现为
 * 「明明默认模型是它，却提示没有 Key」。留着这个过滤是给老数据兜底。
 */
export function loadLlm(req, app, id = null) {
  const NOT_CLOUD = "provider <> 'workbuddy-cloud'";
  let row;
  if (id) row = get(`SELECT * FROM llm_configs WHERE id = ? AND user_id = ? AND ${NOT_CLOUD}`, [id, req.user.id]);
  else {
    const pid = req.params?.personaId;
    row = null;
    if (pid) {
      const p = get('SELECT llm_config_id FROM personas WHERE id = ? AND user_id = ?', [pid, req.user.id]);
      if (p?.llm_config_id) {
        row = get(`SELECT * FROM llm_configs WHERE id = ? AND user_id = ? AND ${NOT_CLOUD}`,
          [p.llm_config_id, req.user.id]);
      }
    }
    if (!row) {
      row = get(`SELECT * FROM llm_configs WHERE user_id = ? AND is_default = 1 AND ${NOT_CLOUD}`, [req.user.id]);
    }
    // 默认项是云通道、但另有自备 Key 配置时，退而取任意一条自备 Key 配置
    if (!row) {
      row = get(`SELECT * FROM llm_configs WHERE user_id = ? AND ${NOT_CLOUD}
                 ORDER BY is_default DESC, created_at ASC LIMIT 1`, [req.user.id]);
    }
  }
  if (!row) return null;
  return { ...row, params: safeJson(row.params_json, {}), apiKey: resolveLlmKey(req, app, row) };
}

export function loadTts(req, app, id = null) {
  let row;
  if (id) row = get('SELECT * FROM tts_configs WHERE id = ? AND user_id = ?', [id, req.user.id]);
  else row = get('SELECT * FROM tts_configs WHERE user_id = ? AND is_default = 1', [req.user.id]);
  if (!row) return null;
  return { ...row, settings: safeJson(row.settings_json, {}), apiKey: resolveTtsKey(req, app, row) };
}
