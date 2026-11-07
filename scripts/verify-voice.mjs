#!/usr/bin/env node
/**
 * 语音输出形态的端到端验证（真实服务 + 假上游，不 mock 业务逻辑）。
 *
 * 验证这次改动的核心诉求：
 *   1. [语音转文字] 被解析成 audio + 转写文本，并入库保留
 *   2. 口语统计进入人格档案（_meta.voiceStats / voiceShare）
 *   3. speaking_style 不被 normalizeProfile 裁掉，且写进 system prompt
 *   4. 人格能保存 voice_mode（text / voice）
 *   5. 对话接口按 voiceMode 返回 speak 判定
 *   6. 合成出来的语音让消息带上 audioUrl（前端据此画微信式语音气泡）
 *
 * 用法： node scripts/verify-voice.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-voice-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'verify-voice-key-0123456789abcdef';
process.env.SSRF_ALLOW_PRIVATE = '1';
process.env.BACKUP_INTERVAL_HOURS = '0';

const checks = [];
const ok = (name, detail = '') => { checks.push({ ok: true, name, detail }); console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail = '') => { checks.push({ ok: false, name, detail }); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

const { startLlm, startTts } = await import('../tests/helpers/upstreams.js');
const { buildServer } = await import('../src/server.js');

let llmServer, ttsServer, app, cookie = '';

async function req(method, url, body) {
  const res = await app.inject({
    method, url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers['set-cookie'];
  if (sc) {
    const c = Array.isArray(sc) ? sc[0] : sc;
    const val = c.split(';')[0];
    if (val.startsWith('ep_session=')) cookie = val;
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* SSE / binary */ }
  return { status: res.statusCode, body: json, raw: res.body, headers: res.headers };
}

/** 从 SSE 响应里挑某个类型的事件 */
function sseEvents(raw) {
  return raw.split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

async function main() {
  llmServer = await startLlm();
  ttsServer = await startTts();
  app = await buildServer({ logger: false });
  await app.ready();
  console.log('\n[verify-voice] 开始\n');

  /* --------------------------------------------------- 注册 + 建人格 */
  let r = await req('POST', '/api/auth/register', {
    email: `v${Date.now()}@example.com`, password: 'Passw0rd123', displayName: '验证', consent: true,
  });
  if (!r.body?.ok && r.status >= 400) return bad('注册账号', `HTTP ${r.status} ${r.raw.slice(0, 140)}`);
  ok('注册账号');

  r = await req('POST', '/api/personas', { name: '林小满', relationship: '女朋友' });
  const personaId = r.body?.persona?.id;
  if (!personaId) return bad('创建人格', r.raw.slice(0, 160));
  ok('创建人格', personaId);

  /* ------------------------------- 导入带 [语音转文字] 的聊天记录 */
  // 做成微信导出的真实样子：转写有时独立成行，有时和 [语音] 同行，
  // 还有一条纯语音（只有时长、没有转写）。
  const chatTxt = `2024-03-12 21:04:33 林小满
[语音] 12"
[语音转文字] 你在干嘛呀

2024-03-12 21:05:02 我
在加班

2024-03-12 21:05:41 林小满
[语音] 8" [语音转文字] 又加班啊你 我跟你说 别老这样

2024-03-12 21:06:10 林小满
[语音] 5"

2024-03-12 21:07:02 我
快结束了

2024-03-12 21:07:40 林小满
[语音] 9"
[语音转文字] 嗯 那你早点回来 给你留了饭

2024-03-12 21:09:02 林小满
知道了就回个话呀

2024-03-12 21:10:02 我
好

2024-03-12 21:11:02 林小满
害 每次都这样
`;
  // 真正的 multipart：字段名是 senderMap（不是 mapping），路径带 personaId
  const form = new FormData();
  form.append('file', new Blob([chatTxt], { type: 'text/plain' }), 'wechat.txt');
  form.append('senderMap', JSON.stringify({ 林小满: 'persona', 我: 'user' }));
  const mp = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/imports`,
    headers: { cookie }, payload: form,
  });
  const imp = (() => { try { return JSON.parse(mp.body); } catch { return null; } })();
  if (mp.statusCode === 200 && imp?.added > 0) ok('导入聊天记录', `added=${imp.added} dup=${imp.duplicates}`);
  else bad('导入聊天记录', `HTTP ${mp.statusCode} ${mp.body.slice(0, 200)}`);

  /* --------------------------------- 语音消息是否被识别并保留下来 */
  const { all, run } = await import('../src/db/index.js');
  const audioRows = all(
    `SELECT content, msg_type, meta_json FROM messages
     WHERE persona_id = ? AND role='persona' AND msg_type='audio' ORDER BY seq`, [personaId]);
  const withText = audioRows.filter((x) => x.content && x.content.trim());
  const withoutText = audioRows.filter((x) => !x.content || !x.content.trim());

  if (audioRows.length >= 3) ok('语音消息入库', `${audioRows.length} 条（有转写 ${withText.length}，纯语音 ${withoutText.length}）`);
  else bad('语音消息入库', `只有 ${audioRows.length} 条`);

  if (withText.some((x) => x.content.includes('你在干嘛呀'))) ok('语音转写文本保留正确', withText.map((x) => x.content.replace(/\n/g, ' / ')).join(' | '));
  else bad('语音转写文本保留正确', JSON.stringify(withText.map((x) => x.content)));

  // 时长（12"）不能当成内容混进转写
  if (!withText.some((x) => /\d\s*["'′]/.test(x.content))) ok('时长没被当成说话内容');
  else bad('时长没被当成说话内容', JSON.stringify(withText.map((x) => x.content)));

  if (withoutText.length >= 1) ok('纯语音（无转写）也保留', '这是「爱发语音」的证据');
  else bad('纯语音（无转写）也保留');

  const metaOk = audioRows.every((x) => {
    const m = JSON.parse(x.meta_json || '{}');
    return m.voice === true && typeof m.transcript === 'boolean';
  });
  if (metaOk) ok('meta 标记 voice / transcript');
  else bad('meta 标记 voice / transcript', audioRows.map((x) => x.meta_json).join(' '));

  /* ---------------------------- 分析提示词里真的带了语音转写原文 */
  // 用户最核心的要求是「语音输出要重点学 [语音转文字] 的内容来模仿说话」。
  // 前面几项只验证了「转写被存下来」，但存下来不等于喂给了模型 ——
  // 中间任何一环把 voiceLines 丢掉，模型都只能拿打字样本瞎猜，
  // 而分析结果仍然会「看起来正常」。所以这里直接检查送给模型的那段文字。
  {
    const { buildAnalysisPrompt, sampleVoiceLines, computeVoiceStats, voiceShare } =
      await import('../src/lib/persona.js');
    const vLines = sampleVoiceLines(personaId);
    const vStats = computeVoiceStats(vLines);
    const vShare = voiceShare(personaId);

    if (vLines.length >= 3) ok('取到语音转写样本', `${vLines.length} 条`);
    else bad('取到语音转写样本', `只有 ${vLines.length} 条`);

    // 只取 persona 自己发的语音，不能把「我」发的也算进去
    const bogus = vLines.filter((l) => !l.content || !l.content.trim());
    if (!bogus.length) ok('语音样本只含 persona 自己的话且都带转写');
    else bad('语音样本只含 persona 自己的话且都带转写', JSON.stringify(bogus.map((x) => x.content)));

    const prompt = buildAnalysisPrompt({
      persona: { name: '林小满', relationship: '女朋友', description: '' },
      stats: null, lines: [], pairs: [], voiceLines: vLines,
      voiceStats: vStats, voiceShareInfo: vShare, lang: 'zh',
    });
    const text = prompt.map((m) => m.content).join('\n');

    if (text.includes('【TA 发过的语音（语音转文字')) ok('分析提示词里单列了语音转写段落（不混进打字样本）');
    else bad('分析提示词里单列了语音转写段落（不混进打字样本）', text.slice(0, 200));

    // 必须是原文，不是「有 N 条语音」这种概括 —— 模型要靠原文才能学到口癖
    const sampleLine = '你在干嘛呀';
    if (text.includes(sampleLine)) ok('语音转写原文进了提示词', `含「${sampleLine}」`);
    else bad('语音转写原文进了提示词', `没找到「${sampleLine}」`);

    if (text.includes('语音口语特征')) ok('提示词含客观口语统计');
    else bad('提示词含客观口语统计');

    if (text.includes('这是「说」出来的话，不是打字')) ok('明确告诉模型这段是口语而非打字');
    else bad('明确告诉模型这段是口语而非打字');

    // 没有语音样本时，提示词必须承认「没有」，而不是留一个空段落让模型自由发挥
    const noVoicePrompt = buildAnalysisPrompt({
      persona: { name: '某人', language: 'zh' },
      stats: null, lines: [], pairs: [], voiceLines: [], voiceStats: null, voiceShareInfo: null,
    }).map((m) => m.content).join('\n');
    if (noVoicePrompt.includes('这个人没有留下语音记录')) ok('无语音样本时提示词如实说明');
    else bad('无语音样本时提示词如实说明');
  }

  /* ------------------------------------------- 分析档案含 speaking_style */
  r = await req('POST', '/api/llm-configs', {
    label: 'fake', provider: 'openai',
    baseUrl: `http://127.0.0.1:${llmServer.address().port}/v1`,
    apiKey: 'sk-test', model: 'gpt-4o-mini', isDefault: true,
  });
  if (r.status === 200 || r.status === 201) ok('配置假上游模型');
  else bad('配置假上游模型', r.raw.slice(0, 160));

  const { runAnalysis, buildSystemPrompt, normalizeProfile } = await import('../src/lib/persona.js');
  try {
    const personaRow = all('SELECT * FROM personas WHERE id = ?', [personaId])[0];
    const llmRow = all("SELECT * FROM llm_configs WHERE user_id = ? AND provider='openai'", [personaRow.user_id])[0];
    const { decryptSecret } = await import('../src/lib/crypto.js');
    const llmCfg = {
      id: llmRow.id, base_url: llmRow.base_url, model: llmRow.model,
      params: JSON.parse(llmRow.params_json || '{}'),
    };
    const out = await runAnalysis({
      userId: personaRow.user_id, persona: { ...personaRow, model: 'gpt-4o-mini' },
      llmCfg, apiKey: decryptSecret(llmRow.api_key_enc),
    });
    const prof = out.profile;
    if (prof?._meta?.voiceStats?.sampleCount > 0) {
      ok('档案记录了语音统计', `样本 ${prof._meta.voiceStats.sampleCount} 条，平均 ${prof._meta.voiceStats.avgLength} 字`);
    } else bad('档案记录了语音统计', JSON.stringify(prof?._meta || null).slice(0, 200));

    if (prof?._meta?.voiceShare?.share > 0) {
      ok('档案记录了语音占比', `${Math.round(prof._meta.voiceShare.share * 100)}%（${prof._meta.voiceShare.audioCount}/${prof._meta.voiceShare.total}）`);
    } else bad('档案记录了语音占比', JSON.stringify(prof?._meta?.voiceShare || null));

    if (prof?.speaking_style && typeof prof.speaking_style.hasVoiceEvidence === 'boolean') {
      ok('档案保留了 speaking_style', `hasVoiceEvidence=${prof.speaking_style.hasVoiceEvidence}`);
    } else bad('档案保留了 speaking_style', JSON.stringify(prof?.speaking_style || null).slice(0, 160));
  } catch (e) {
    bad('跑人格分析', e.message);
  }

  /* --------------------------- system prompt 里出现「说话的样子」段落 */
  const profRow = all('SELECT data_json FROM profiles WHERE persona_id = ? AND is_active = 1', [personaId])[0];
  const profile = profRow ? JSON.parse(profRow.data_json) : null;

  const withVoice = buildSystemPrompt({
    persona: { name: '林小满', relationship: '女朋友', language: 'zh' },
    profile, mode: 'natural', voiceEnabled: true,
  });
  if (withVoice.includes('说话的样子')) ok('语音模式下提示词含「说话的样子」');
  else bad('语音模式下提示词含「说话的样子」');

  if (withVoice.includes('发语音时的要求')) ok('语音模式下提示词要求「像开口说话」');
  else bad('语音模式下提示词要求「像开口说话」');

  const withoutVoice = buildSystemPrompt({
    persona: { name: '林小满', relationship: '女朋友', language: 'zh' },
    profile, mode: 'natural', voiceEnabled: false,
  });
  if (!withoutVoice.includes('发语音时的要求')) ok('文字模式不注入发言要求');
  else bad('文字模式不注入发言要求');

  // 没有语音样本时，不能装作很懂
  const noEvidence = normalizeProfile({ summary: 'x' });
  noEvidence._meta = { voiceStats: null, voiceShare: { share: 0 } };
  const guessy = buildSystemPrompt({
    persona: { name: '某人', language: 'zh' }, profile: noEvidence,
    mode: 'natural', voiceEnabled: true,
  });
  if (guessy.includes('没有留下语音记录')) ok('无语音样本时说明「不知道 TA 怎么说话」');
  else bad('无语音样本时说明「不知道 TA 怎么说话」');

  /* ------------------------------------- voice_mode 存取与 speak 判定 */
  r = await req('PATCH', `/api/personas/${personaId}`, { voiceMode: 'voice' });
  if (r.body?.persona?.voiceMode === 'voice') ok('保存 voiceMode=voice');
  else bad('保存 voiceMode=voice', r.raw.slice(0, 160));

  r = await req('PATCH', `/api/personas/${personaId}`, { voiceMode: 'bogus' });
  if (r.body?.persona?.voiceMode === 'text') ok('非法 voiceMode 退回 text');
  else bad('非法 voiceMode 退回 text', String(r.body?.persona?.voiceMode));

  await req('PATCH', `/api/personas/${personaId}`, { voiceMode: 'voice' });

  // 没有 TTS 配置时，即使 voice 模式也必须只发文字（否则聊天里撞 400）
  r = await req('POST', `/api/personas/${personaId}/chat`, { message: '在吗', voiceMode: 'voice' });
  const d1 = sseEvents(r.raw).find((x) => x.type === 'done');
  if (d1 && d1.speak === false && d1.speakReason === 'voice-not-ready') {
    ok('没配 TTS 时不硬发语音', d1.speakReason);
  } else bad('没配 TTS 时不硬发语音', JSON.stringify(d1 || r.raw.slice(0, 200)));

  /* ---------------------------- 配上 TTS 后能真的合成并变成语音气泡 */
  // 参考音频 + 音色
  const vrefForm = new FormData();
  vrefForm.append('audio', new Blob([Buffer.alloc(2048)], { type: 'audio/wav' }), 'ref.wav');
  vrefForm.append('name', 'ref');
  vrefForm.append('refText', '你好');
  vrefForm.append('consent', 'true');
  const vrefRes = await app.inject({ method: 'POST', url: '/api/voice-refs', headers: { cookie }, payload: vrefForm });
  const vref = (() => { try { return JSON.parse(vrefRes.body); } catch { return null; } })();
  if (vref?.id) ok('上传参考音频', vref.id);
  else bad('上传参考音频', `HTTP ${vrefRes.statusCode} ${vrefRes.body.slice(0, 160)}`);

  if (vref?.id) {
    run('UPDATE voice_refs SET remote_voice_id = ?, is_default = 1 WHERE id = ?', ['fake-voice-1', vref.id]);
  }

  r = await req('POST', '/api/tts-configs', {
    label: 'fake-tts', kind: 'breezeblue',
    baseUrl: `http://127.0.0.1:${ttsServer.address().port}`,
    apiKey: 'tts-key', isDefault: true,
  });
  const ttsId = r.body?.id;
  if (ttsId) ok('配置假 TTS', ttsId);
  else bad('配置假 TTS', r.raw.slice(0, 200));

  await req('PATCH', `/api/personas/${personaId}`, {
    voiceMode: 'voice', ttsConfigId: ttsId, voiceRefId: vref?.id || null,
  });

  r = await req('POST', `/api/personas/${personaId}/chat`, { message: '你在干嘛', voiceMode: 'voice' });
  const d2 = sseEvents(r.raw).find((x) => x.type === 'done');
  if (d2?.speak === true) ok('配好 TTS 后 voice 模式判定为发语音');
  else bad('配好 TTS 后 voice 模式判定为发语音', JSON.stringify(d2 || {}).slice(0, 220));

  if (d2?.messageId) {
    const ttsRes = await req('POST', '/api/tts', { messageId: d2.messageId, personaId });
    if (ttsRes.status === 200 && ttsRes.body?.url) {
      ok('合成语音成功', ttsRes.body.url);
      // chatId 只在 start 事件里，done 事件没有
      const startEv = sseEvents(r.raw).find((x) => x.type === 'start');
      const msgs = await req('GET', `/api/chats/${startEv.chatId}/messages`);
      const target = msgs.body?.messages?.find((m) => m.id === d2.messageId);
      if (target?.audioUrl) ok('消息列表带 audioUrl（前端可画微信式语音气泡）', target.audioUrl);
      else bad('消息列表带 audioUrl', JSON.stringify(target || msgs.body || null).slice(0, 220));
    } else {
      bad('合成语音成功', `HTTP ${ttsRes.status} ${ttsRes.raw.slice(0, 200)}`);
    }
  } else {
    bad('合成语音成功', '上一轮没拿到 messageId');
  }

  /* ------------------------------------------------ 已废弃的 mixed 模式
   *
   * 这里原本断言「mixed 会按真实语音占比随机掷骰子」—— 那条断言现在必然失败，
   * 因为 mixed 这个模式本身被删掉了（见 src/lib/voice-mode.js 顶部注释：
   * 大多数人导入的记录里语音占比很低，掷骰子结果几乎总是文字，
   * 用户选了「随机」却一直收到文字，体感就是开关坏了）。
   *
   * 删掉一个用户能看见的选项，比留着一个用户无法预测、也无法验证的随机更诚实。
   * 所以现在该验的是反面：**残留的 mixed 绝不能让人收到语音**，
   * 否则老数据里的 'mixed' 会绕过归一化偷偷发声。 */
  const { decideSpeak } = await import('../src/lib/voice-mode.js');
  const legacyMixed = Array.from({ length: 400 }, () => decideSpeak({
    mode: 'mixed', share: 0.85, sampleCount: 20, voiceReady: true, content: '嗯',
  })).filter((d) => d.speak).length;

  if (legacyMixed === 0) ok('老数据里的 mixed 不会偷偷发声（已归一化为 text）', '400 次全为文字');
  else bad('老数据里的 mixed 不会偷偷发声（已归一化为 text）', `有 ${legacyMixed}/400 次发声`);

  /* voice 模式该发就得发：这是用户明确选的，不能被概率削弱 */
  const forced = Array.from({ length: 200 }, () => decideSpeak({
    mode: 'voice', voiceReady: true, content: '嗯',
  })).filter((d) => d.speak).length;
  if (forced === 200) ok('voice 模式每次都发语音', '200/200');
  else bad('voice 模式每次都发语音', `只有 ${forced}/200`);

  /* ------------------------------------------------------ 收尾 */
  await app.close();
  llmServer.close(); ttsServer.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[verify-voice] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error('\n[verify-voice] 崩了：', e);
  try { await app?.close(); } catch { /* ignore */ }
  try { llmServer?.close(); ttsServer?.close(); } catch { /* ignore */ }
  process.exit(1);
});
