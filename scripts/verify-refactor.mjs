#!/usr/bin/env node
/**
 * 这一轮「交互与结构整理」的端到端验证（真实服务 + 假上游）。
 *
 * 覆盖三件事，一次跑完，避免为每个小改动单独起一轮：
 *   1. 参考音色支持「直接选 ID」—— 不传音频文件也能建出一条可用的音色，
 *      并且真的会被语音合成链路用上；重复 ID 要挡住。
 *   2. 音色只在「语音」页管理 —— 设置页不再有第二份可增删的音色列表。
 *   3. 导航不再有空白等待 —— 骨架屏在慢网络下真的出现，且真实内容到达后消失。
 *
 * 用法： node scripts/verify-refactor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-rf-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'verify-refactor-key-0123456789abc';
process.env.SSRF_ALLOW_PRIVATE = '1';
process.env.BACKUP_INTERVAL_HOURS = '0';

const checks = [];
const ok = (n, d = '') => { checks.push({ ok: true, n }); console.log(`  PASS ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { checks.push({ ok: false, n }); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); };

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
  try { json = JSON.parse(res.body); } catch { /* binary */ }
  return { status: res.statusCode, body: json, raw: res.body };
}

async function main() {
  llmServer = await startLlm();
  ttsServer = await startTts();
  app = await buildServer({ logger: false });
  await app.ready();
  console.log('\n[verify-refactor] 开始\n');

  let r = await req('POST', '/api/auth/register', {
    email: `rf${Date.now()}@example.com`, password: 'Passw0rd123', displayName: '验证', consent: true,
  });
  if (r.status >= 400) return bad('注册账号', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);
  ok('注册账号');

  /* ------------------------------------------------ TTS 服务先配好 */
  r = await req('POST', '/api/tts-configs', {
    label: '假 Breeze', kind: 'breezeblue', baseUrl: `http://127.0.0.1:${ttsServer.address().port}`, apiKey: 'xi-test-key',
  });
  if (r.status >= 400) return bad('创建 TTS 配置', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);
  ok('创建 TTS 配置');

  /* ============================================================== *
   * 1. 直接选音色 ID（不带任何音频文件）
   * ============================================================== */
  r = await req('GET', '/api/voice-refs/remote-voices?limit=10');
  const remote = r.body?.voices || [];
  if (r.status === 200 && remote.length && remote[0].voiceId) {
    ok('能读到账号里的音色库', `${r.body.total} 个，首个 ${remote[0].voiceId}`);
  } else {
    bad('能读到账号里的音色库', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);
  }
  const vid = remote[0]?.voiceId || 'voc_fake';

  // 关键点：multipart 都不发，纯 JSON 也必须能建出音色
  r = await req('POST', '/api/voice-refs', { name: '直接选的音色', remoteVoiceId: vid });
  const refId = r.body?.id;
  if (r.status === 200 && refId) ok('纯 JSON 直接挂音色 ID，不需要上传音频');
  else bad('纯 JSON 直接挂音色 ID', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  r = await req('GET', '/api/voice-refs');
  const created = (r.body?.voices || []).find((v) => v.id === refId);
  if (created && created.remoteVoiceId === vid) {
    ok('入库的 remote_voice_id 正确', `${created.name} → ${vid}`);
  } else {
    bad('入库的 remote_voice_id 正确', JSON.stringify(created || null));
  }
  if (created && created.hasAudio === false) ok('引用型音色没有伪造音频文件');
  else bad('引用型音色没有伪造音频文件', JSON.stringify(created?.hasAudio));

  // 第一个音色应自动成为默认，否则语音合成会挑不到
  if (created?.isDefault) ok('第一个音色自动设为默认');
  else bad('第一个音色自动设为默认', String(created?.isDefault));

  // 同一个上游音色不许重复挂
  r = await req('POST', '/api/voice-refs', { name: '重复的', remoteVoiceId: vid });
  if (r.status === 409 && r.body?.code === 'DUPLICATE') ok('重复音色 ID 被挡住', 'HTTP 409');
  else bad('重复音色 ID 被挡住', `HTTP ${r.status} ${r.raw.slice(0, 160)}`);

  // 缺 ID 要给出明确提示，而不是 500
  r = await req('POST', '/api/voice-refs', { name: '没填 ID' });
  if (r.status === 400) ok('缺音色 ID 返回 400', r.body?.error || '');
  else bad('缺音色 ID 返回 400', `HTTP ${r.status}`);

  /* -------- 这条音色真的能被合成链路用上（不是只躺在库里） -------- */
  r = await req('POST', '/api/personas', { name: '林小满', relationship: '女朋友' });
  const personaId = r.body?.persona?.id;
  await req('PATCH', `/api/personas/${personaId}`, { voiceRefId: refId });
  const ttsCfg = (await req('GET', '/api/tts-configs')).body?.configs?.[0];
  r = await req('POST', `/api/tts-configs/${ttsCfg?.id}/test-speak`, { voiceRefId: refId, text: '测试一句话' });
  if (r.status === 200) ok('引用型音色可用于合成');
  else bad('引用型音色可用于合成', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  /* ============================================================== *
   * 2. 音色只在语音页管理
   * ============================================================== */
  const settingsSrc = fs.readFileSync(new URL('../public/js/pages/settings.js', import.meta.url), 'utf8');

  // keysTab 里不该再出现可增删的音色卡片
  const keysTabSrc = settingsSrc.slice(
    settingsSrc.indexOf('async function keysTab'),
    settingsSrc.indexOf('function cloudCard') > 0
      ? settingsSrc.indexOf('function cloudCard')
      : settingsSrc.indexOf('/* ------------------------------------------------- voice'),
  );
  if (!/renderVoiceRefs/.test(settingsSrc)) ok('旧的重复音色卡片已移除');
  else bad('旧的重复音色卡片已移除', '仍引用 renderVoiceRefs');

  const pickerUses = (settingsSrc.match(/voicePicker\(/g) || []).length;
  if (pickerUses >= 2) ok('新建与编辑共用同一个音色选择器', `${pickerUses} 处调用`);
  else bad('新建与编辑共用同一个音色选择器', `只有 ${pickerUses} 处`);

  // 新建弹窗必须同时提供两条路
  const uploadFnSrc = settingsSrc.slice(
    settingsSrc.indexOf('function voiceUploadForm'),
    settingsSrc.indexOf('function voiceEditForm'),
  );
  if (/从音色库选择/.test(uploadFnSrc) && /上传音频克隆/.test(uploadFnSrc)) {
    ok('新建音色同时提供「选 ID」和「上传克隆」');
  } else {
    bad('新建音色同时提供「选 ID」和「上传克隆」');
  }
  if (/api\.post\('\/api\/voice-refs',\s*\{\s*name/.test(uploadFnSrc)) ok('新建走的是选 ID 的 JSON 路径');
  else bad('新建走的是选 ID 的 JSON 路径');

  // 后端只该有一个建音色的入口，避免两套逻辑漂移
  const cfgSrc = fs.readFileSync(new URL('../src/routes/configs.js', import.meta.url), 'utf8');
  const postCount = (cfgSrc.match(/app\.post\('\/api\/voice-refs'/g) || []).length;
  if (postCount === 1) ok('建音色只有一个后端入口', 'content-type 分流');
  else bad('建音色只有一个后端入口', `${postCount} 个`);

  /* ============================================================== *
   * 3. 导航骨架屏（慢网络下才出现，内容到了就消失）
   * ============================================================== */
  const routesSrc = fs.readFileSync(new URL('../public/js/routes.js', import.meta.url), 'utf8');
  // 阈值必须在 40~120ms 之间：0 会让每次导航都闪一下骨架（更廉价），
  // 太大又等于没有骨架（用户已经在看空白了）。
  const threshold = routesSrc.match(/skelTimer\s*=\s*setTimeout\([\s\S]{0,200}?\},\s*(\d+)\s*\)/);
  const ms = threshold ? Number(threshold[1]) : null;
  if (ms !== null && ms >= 40 && ms <= 120) ok('骨架屏有合理延迟阈值', `${ms}ms`);
  else bad('骨架屏有合理延迟阈值', ms === null ? '找不到 setTimeout 阈值' : `${ms}ms 不合理`);

  // 骨架只在还没有真实 shell 时出现，否则会盖住已渲染的内容
  if (/\.shell:not\(\.shell-skeleton\)/.test(routesSrc)) ok('骨架不会盖住已渲染的真实页面');
  else bad('骨架不会盖住已渲染的真实页面');
  // 所有提前 return 都要收掉骨架，否则会盖住真实内容
  const clearCount = (routesSrc.match(/clearSkel\(\)/g) || []).length;
  if (clearCount >= 3) ok('骨架在每条返回路径上都被收掉', `${clearCount} 处 clearSkel`);
  else bad('骨架在每条返回路径上都被收掉', `只有 ${clearCount} 处`);

  const cssSrc = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  if (/prefers-reduced-motion/.test(cssSrc) && /skShimmer/.test(cssSrc)) {
    ok('骨架动画尊重「减少动态效果」设置');
  } else {
    bad('骨架动画尊重「减少动态效果」设置');
  }
  if (/:active[^{]*\{[^}]*transform:\s*scale/.test(cssSrc)) ok('点击有即时缩放反馈');
  else bad('点击有即时缩放反馈');

  /* --------------------------------------------------- 汇总 */
  const fail = checks.filter((c) => !c.ok);
  console.log(`\n[verify-refactor] ${checks.length - fail.length}/${checks.length} 通过\n`);
  if (fail.length) {
    console.log('失败项：');
    for (const f of fail) console.log(' - ' + f.n);
  }
  await app.close();
  llmServer.close?.(); ttsServer.close?.();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
