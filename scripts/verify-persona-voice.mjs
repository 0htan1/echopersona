#!/usr/bin/env node
/**
 * 本轮验证：人物模仿 / 语音直出 / 移除云模型 / 微信外观 / 导航去重。
 *
 * 一次跑完，不为每个小改动单独起一轮 —— token 和机器时间都要省。
 *
 * 每一项都断言「真实发生的事实」，不是「接口返回 200」：
 *   • 模仿：真的把导入的原话放进了 system prompt（从假上游把它截下来看）
 *   • 语音：真的先判定后生成（前端一个 delta 都没收到），且真的拿到 audioUrl
 *   • 云模型：/api/cloud/* 全部 404，SDK 不再被聊天页引用
 *   • 微信外观：ui_theme 能存能读，且非法值落回 classic
 *   • 导航：侧边栏不再有重复入口
 *
 * 用法： node scripts/verify-persona-voice.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-pv-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'verify-persona-voice-0123456789ab';
process.env.SSRF_ALLOW_PRIVATE = '1';
process.env.BACKUP_INTERVAL_HOURS = '0';

const checks = [];
const ok = (n, d = '') => { checks.push({ ok: true, n }); console.log(`  PASS ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { checks.push({ ok: false, n }); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); };

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/* 把假上游换成一个会**记录收到的 prompt** 的版本。
 * 想证明「模型真的看到了聊天记录」，唯一可靠的办法就是看它到底收到了什么。 */
const http = await import('node:http');
let capturedPrompt = '';
let capturedMessages = null;

function startRecordingLlm() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? JSON.parse(raw) : {};
        if (req.url.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        }
        if (req.url.includes('/embeddings')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }] }));
        }
        if (req.url.includes('/chat/completions')) {
          capturedMessages = body.messages || [];
          capturedPrompt = String(body.messages?.[0]?.content || '');
          // 语音模式下模型不该写标点 —— 这里故意写成"像话"的样子
          const content = '嗯 今天还行吧\n就是有点累';
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(404).end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const { startTts } = await import('../tests/helpers/upstreams.js');
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

/** 读 SSE 流，返回所有事件 */
function parseSse(text) {
  return String(text).split('\n\n').map((b) => {
    const line = b.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    try { return JSON.parse(line.slice(6)); } catch { return null; }
  }).filter(Boolean);
}

async function main() {
  llmServer = await startRecordingLlm();
  ttsServer = await startTts();
  app = await buildServer({ logger: false });
  await app.ready();
  console.log('\n[verify-persona-voice] 开始\n');

  /* ---------------------------------------------------- 建账号 */
  let r = await req('POST', '/api/auth/register', {
    email: `pv${Date.now()}@example.com`, password: 'Passw0rd123', displayName: '验证', consent: true,
  });
  if (r.status >= 400) { bad('注册账号', `HTTP ${r.status} ${r.raw.slice(0, 200)}`); return; }
  ok('注册账号');

  /* ---------------------------------------------- 配 LLM + TTS */
  const llmBase = `http://127.0.0.1:${llmServer.address().port}`;
  r = await req('POST', '/api/llm-configs', {
    label: '假模型', baseUrl: llmBase, model: 'fake-model', apiKey: 'sk-test', isDefault: true,
  });
  if (r.status >= 400) { bad('创建 LLM 配置', `HTTP ${r.status} ${r.raw.slice(0, 200)}`); return; }
  ok('创建 LLM 配置');

  r = await req('POST', '/api/tts-configs', {
    label: '假 Breeze', kind: 'breezeblue',
    baseUrl: `http://127.0.0.1:${ttsServer.address().port}`, apiKey: 'xi-test-key',
  });
  if (r.status >= 400) { bad('创建 TTS 配置', `HTTP ${r.status} ${r.raw.slice(0, 200)}`); return; }
  ok('创建 TTS 配置');

  r = await req('POST', '/api/voice-refs', { name: '音色', remoteVoiceId: 'voc_fake' });
  const refId = r.body?.id;
  if (refId) ok('挂一个现成音色'); else { bad('挂一个现成音色', r.raw.slice(0, 160)); return; }

  /* ------------------------------------------------ 建人格 */
  r = await req('POST', '/api/personas', { name: '林小满', relationship: '女朋友' });
  const pid = r.body?.persona?.id;
  if (!pid) { bad('创建人格', r.raw.slice(0, 200)); return; }
  ok('创建人格');
  await req('PATCH', `/api/personas/${pid}`, { voiceRefId: refId, voiceMode: 'voice' });

  /* ================================================================ *
   * 1. 导入聊天记录 —— 里面要有一条**只有原话才能体现**的口头禅
   * ================================================================ */
  const chatLog = [
    '我：今天加班到十点',
    '林小满：害，我这也刚到家',
    '我：吃饭了吗',
    '林小满：没呢 懒得弄 待会儿煮个面吧',
    '我：那不行，得吃点正经的',
    '林小满：知道啦知道啦 你别老是这样嘛',
    // 她本人的语音 —— 语音样本只该从「复刻对象的语音」里取
    '林小满：[语音] 5"',
    '林小满：[语音转文字] 嗯…那个 我今天其实也挺想你的 就是没说',
    '我：那就说啊',
    '林小满：说了就没意思了呀',
    '林小满：[语音][语音转文字] 你早点睡呀 别熬那么晚',
  ].join('\n');

  r = await req('POST', `/api/personas/${pid}/imports/preview`, { content: chatLog, format: 'txt' });
  // 导入接口吃 multipart（真实用户就是上传一个 txt），不是 JSON —— 这里也照真实方式走
  const { FormData, Blob } = globalThis;
  const fd1 = new FormData();
  fd1.append('file', new Blob([chatLog], { type: 'text/plain' }), 'chat.txt');
  const pv = await app.inject({
    method: 'POST', url: `/api/personas/${pid}/imports/preview`, headers: { cookie }, payload: fd1,
  });
  let previewBody = null;
  try { previewBody = JSON.parse(pv.body); } catch { /* ignore */ }
  if (pv.statusCode === 200) {
    previewBody = previewBody || {};
    ok('解析聊天记录', `senders=${JSON.stringify(previewBody.senders || []).slice(0, 80)}`);
  } else {
    bad('解析聊天记录', `HTTP ${pv.statusCode} ${pv.body.slice(0, 200)}`);
  }

  if (previewBody) {
    const fd2 = new FormData();
    fd2.append('file', new Blob([chatLog], { type: 'text/plain' }), 'chat.txt');
    // 把「林小满」标记成复刻对象，否则它的发言不会被当成样本
    fd2.append('personaSender', '林小满');
    const im = await app.inject({
      method: 'POST', url: `/api/personas/${pid}/imports`, headers: { cookie }, payload: fd2,
    });
    /* 导入已改成后台 job：202 + jobId。必须等到 done 再往下走，
     * 否则后面读 style-stats 会拿到空人格，断言失败看起来像"统计坏了"。 */
    let b = null; try { b = JSON.parse(im.body); } catch { /* ignore */ }
    if (im.statusCode === 202 && b?.jobId) {
      for (let i = 0; i < 300; i += 1) {
        const j = await req('GET', `/api/jobs/${b.jobId}`);
        const st = j.body?.job?.status;
        if (st === 'done') { b = j.body.job.result; break; }
        if (st === 'failed') { b = { error: j.body.job.error }; break; }
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    if (b?.error) bad('导入入库', `job 失败: ${b.error}`);
    else if (im.statusCode === 202 || im.statusCode === 200) ok('导入入库', `新增 ${b?.added ?? b?.inserted ?? '?'} 条`);
    else bad('导入入库', `HTTP ${im.statusCode} ${im.body.slice(0, 300)}`);
  }

  r = await req('GET', `/api/personas/${pid}/style-stats`);
  if (r.status === 200) ok('能读到说话样本', `stats 有 ${Object.keys(r.body?.stats || {}).length} 个字段`);
  else bad('能读到说话样本', `HTTP ${r.status} ${r.raw.slice(0, 200)}`);

  /* ================================================================ *
   * 2. 模仿：system prompt 里必须真的含有导入的原话
   * ================================================================ */
  capturedPrompt = '';
  r = await req('POST', `/api/personas/${pid}/chat`, { message: '在干嘛呢', voiceMode: 'text' });
  const ev1 = parseSse(r.raw);

  if (capturedPrompt.includes('害，我这也刚到家')) {
    ok('prompt 里含导入的原话（"害，我这也刚到家"）');
  } else {
    bad('prompt 里含导入的原话', `prompt 前 300 字：${capturedPrompt.slice(0, 300)}`);
  }
  if (/对方：[\s\S]*?她：/.test(capturedPrompt)) {
    ok('prompt 里有「对方说→她怎么回」的成对样本');
  } else {
    bad('prompt 里有成对样本');
  }
  if (capturedPrompt.includes('这是找手感的依据')) ok('样本带上了"照着模仿、别照抄"的说明');
  else bad('样本带上了模仿说明');

  const startEv = ev1.find((e) => e.type === 'start');
  if (startEv?.samples && (startEv.samples.pairs > 0 || startEv.samples.lines > 0)) {
    ok('start 事件回报了本次用了多少条语料',
      `pairs=${startEv.samples.pairs} lines=${startEv.samples.lines}`);
  } else {
    bad('start 事件回报语料条数', JSON.stringify(startEv?.samples));
  }

  /* ================================================================ *
   * 3. 语音直出：语音模式下前端一个字符都不该收到
   * ================================================================ */
  capturedPrompt = '';
  r = await req('POST', `/api/personas/${pid}/chat`, { message: '想你了', voiceMode: 'voice' });
  const ev2 = parseSse(r.raw);

  const deltas = ev2.filter((e) => e.type === 'delta');
  if (deltas.length === 0) ok('语音模式下没有向前端流任何文字');
  else bad('语音模式下没有向前端流任何文字', `收到 ${deltas.length} 个 delta`);

  const doneEv = ev2.find((e) => e.type === 'done');
  if (doneEv?.speak === true) ok('done 事件标明这条是语音');
  else bad('done 事件标明这条是语音', JSON.stringify(doneEv && { speak: doneEv.speak, reason: doneEv.speakReason }));

  if (doneEv?.audioUrl) ok('done 事件直接带回音频地址', doneEv.audioUrl);
  else bad('done 事件直接带回音频地址', `tts_failed=${JSON.stringify(ev2.find((e) => e.type === 'tts_failed'))}`);

  // 有 speaking 心跳，前端才知道该把气泡切成语音形态
  if (ev2.some((e) => e.type === 'speaking')) ok('生成过程中发了 speaking 心跳');
  else bad('生成过程中发了 speaking 心跳');

  // 关键：语音提示词必须真的差异化了，而且是"说话"的写法
  const voiceRules = [
    ['语音专用段落', /这一条是语音|会被直接念出来/],
    ['禁止标点', /一个标点都不要/],
    ['禁止 emoji', /不要 emoji|一个都不要/],
    ['禁止括号动作', /不要任何表情符号|括号里/],
  ];
  for (const [name, re] of voiceRules) {
    if (re.test(capturedPrompt)) ok(`语音提示词：${name}`);
    else bad(`语音提示词：${name}`, `prompt 长度 ${capturedPrompt.length}`);
  }
  // 语音模式下不该再教它"不要用 Markdown 排版"这类打字规则占用注意力
  if (!/不要用列表、标题、加粗等 Markdown 排版/.test(capturedPrompt)) {
    ok('语音模式跳过了打字专属输出规则');
  } else {
    bad('语音模式跳过了打字专属输出规则');
  }
  // 语音样本要来自 [语音转文字] 那批，而不是打字那批
  if (/她发语音时的原话|语音转写/.test(capturedPrompt)) {
    ok('语音模式使用了语音样本');
  } else {
    bad('语音模式使用了语音样本', capturedPrompt.slice(-600));
  }

  // 落库的消息必须是 audio，且内容已清洗（这段假上游返回的内容本来就没标点）
  r = await req('GET', `/api/chats/${doneEv?.chatId || ''}/messages`).catch(() => ({ body: null }));
  if (doneEv) {
    const listRes = await req('GET', `/api/personas/${pid}/chats`);
    const cid = listRes.body?.chats?.[0]?.id;
    const msgs = await req('GET', `/api/chats/${cid}/messages`);
    const last = (msgs.body?.messages || []).at(-1);
    if (last?.type === 'audio') ok('落库消息标成了 audio');
    else bad('落库消息标成了 audio', JSON.stringify(last && { type: last.type }));
    if (last?.hasAudio && last?.audioUrl) ok('消息带可播放的音频地址');
    else bad('消息带可播放的音频地址', JSON.stringify(last && { hasAudio: last.hasAudio }));
  }

  /* ================================================================ *
   * 4. 云模型已移除
   * ================================================================ */
  const gone = [
    ['/api/cloud/status', 'GET'],
    ['/api/cloud/enable', 'POST'],
    ['/api/cloud/chat/prepare', 'POST'],
    ['/api/cloud/analyze/prepare', 'POST'],
  ];
  let all404 = true;
  for (const [u, m] of gone) {
    const rr = await req(m, u, m === 'POST' ? {} : undefined);
    if (rr.status !== 404) { all404 = false; bad(`云接口已下线 ${u}`, `HTTP ${rr.status}`); }
  }
  if (all404) ok('所有 /api/cloud/* 接口返回 404');

  for (const f of ['src/routes/cloud.js', 'src/lib/cloud.js', 'scripts/verify-cloud-e2e.mjs']) {
    if (!fs.existsSync(path.join(ROOT, f))) ok(`已删除 ${f}`);
    else bad(`已删除 ${f}`);
  }
  const chatSrc = fs.readFileSync(path.join(ROOT, 'public/js/pages/chat.js'), 'utf8');
  if (!/cloud\/chat\/prepare|\/api\/cloud/.test(chatSrc)) ok('聊天页不再调用任何云接口');
  else bad('聊天页不再调用任何云接口');
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
  if (!/cloudCard|\/api\/cloud/.test(settingsSrc)) ok('设置页不再有云模型卡片');
  else bad('设置页不再有云模型卡片');

  /* ================================================================ *
   * 5. 聊天界面两套 + 服务端持久化
   * ================================================================ */
  r = await req('GET', '/api/me');
  if (r.body?.user?.uiTheme === 'classic') ok('默认外观是 classic');
  else bad('默认外观是 classic', String(r.body?.user?.uiTheme));

  r = await req('PATCH', '/api/me', { uiTheme: 'wechat' });
  if (r.body?.user?.uiTheme === 'wechat') ok('可以切到 wechat');
  else bad('可以切到 wechat', JSON.stringify(r.body?.user?.uiTheme));

  r = await req('GET', '/api/auth/session');
  if (r.body?.user?.uiTheme === 'wechat') ok('wechat 已持久化（重新拉 session 仍是它）');
  else bad('wechat 已持久化', String(r.body?.user?.uiTheme));

  r = await req('PATCH', '/api/me', { uiTheme: '../../etc/passwd' });
  if (r.body?.user?.uiTheme === 'classic') ok('非法外观值被落回 classic（不进库）');
  else bad('非法外观值被落回 classic', String(r.body?.user?.uiTheme));

  const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
  if (/data-ui-theme="wechat"/.test(css)) ok('CSS 里有微信外观的一套规则');
  else bad('CSS 里有微信外观的一套规则');
  for (const key of ['#95ec69', '#ededed']) {
    if (css.toLowerCase().includes(key)) ok(`微信配色 ${key} 到位`);
    else bad(`微信配色 ${key} 到位`);
  }
  const settingsJs = fs.readFileSync(path.join(ROOT, 'public/js/pages/settings.js'), 'utf8');
  if (/themeCard/.test(settingsJs) && /setUiTheme/.test(settingsJs)) ok('设置页有两个版本的切换入口');
  else bad('设置页有两个版本的切换入口');

  /* ================================================================ *
   * 6. 侧边栏不再有重复设置入口
   * ================================================================ */
  const shellSrc = fs.readFileSync(path.join(ROOT, 'public/js/shell.js'), 'utf8');
  // 侧边栏导航区里不该再出现指向 settings 子页的入口
  const navSegment = shellSrc.slice(shellSrc.indexOf('const NAV'), shellSrc.indexOf('// user chip'));
  if (!/settings\/keys|settings\/account/.test(navSegment)) ok('侧边栏不再重复指向设置子页');
  else bad('侧边栏不再重复指向设置子页');
  if (!/账户设置|API 配置/.test(shellSrc.slice(shellSrc.indexOf('menu.append(')))) {
    ok('用户菜单里也不再重复列设置子页');
  } else {
    bad('用户菜单里也不再重复列设置子页');
  }

  /* ---------------------------------------------------- 收尾 */
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[verify-persona-voice] ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  -', f.n);
  }
  await app.close();
  llmServer.close();
  ttsServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n[verify-persona-voice] 崩溃：', e);
  try { await app?.close(); } catch { /* ignore */ }
  try { llmServer?.close(); ttsServer?.close(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
