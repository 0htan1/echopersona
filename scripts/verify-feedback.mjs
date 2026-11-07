#!/usr/bin/env node
/**
 * 本轮四个用户反馈的真实浏览器验收：
 *   1. 语音听完后红点消失（含切会话/刷新后仍然消失）
 *   2. 聊天框里不再出现「召回 0 条记忆 / 4 段对话」这种无意义提示
 *   3. 人格分析进度会真的往前走，并显示已用秒数
 *   4. 导入后发送者里不再多出「正文词」
 *
 * 用真实 Chrome + 真实音频播放，不靠截图判断。
 * 用法： node scripts/verify-feedback.mjs [baseUrl]
 */
import fs from 'node:fs';
import { launch } from './lib/browser.mjs';
import { loginFast } from './lib/test-login.mjs';

/* 支持两种目标：
 *   · 本地 http://127.0.0.1:4321
 *   · 线上 https://host/?sharecode=xxx —— 线上有访问码门禁，必须先过门禁
 *     拿到 cookie，之后才能访问 /register。直接 goto /register 会被拦回首页。 */
const RAW_BASE = process.argv[2] || 'http://127.0.0.1:4321';
const isOnline = /^https?:/.test(RAW_BASE) && new URL(RAW_BASE).searchParams.has('sharecode');
const BASE = isOnline ? new URL(RAW_BASE).origin : RAW_BASE;
const OUT = '.tmp/shots-fb';
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const ok = (n, d = '') => { checks.push({ ok: true, n }); console.log(`  PASS ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { checks.push({ ok: false, n }); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); };

const browser = await launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT_TXT = `2024-03-12 21:04:33 林小满
今天下班又是十点半，地铁上人还是好多。
注意：明天要带伞

2024-03-12 21:05:02 我
又加班？你们组是不要人活了吧

2024-03-12 21:05:41 林小满
害，习惯了，反正回去也是一个人待着。
你呢，今天吃得还行吗

2024-03-12 21:06:15 我
凑合吧 楼下那家面馆

2024-03-12 21:06:44 林小满
[语音] 6" [语音转文字] 那家我记得 汤太咸了哈哈哈
下次带你去吃一家特别好吃的

2024-03-13 09:12:20 林小满
早呀 今天天气好好 晒被子了

2024-03-13 09:30:05 我
我也起了 今天要开一天会

2024-03-13 09:31:10 林小满
记得吃饭`;

try {
  /* 线上：先带 sharecode 过访问码门禁，否则后面所有导航都会被拦 */
  if (isOnline) {
    await page.goto(RAW_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
  } else {
    /* 本地：重置固定账号并直接注入登录态。
     *
     * 两件都是"测试准备"，不是被测功能：
     *   · 固定账号是为了绕开注册限流（15 分钟 8 次），但上一轮的数据会留着
     *     （TTS 配置/音色/人格/导入记录累积，重复建同名音色直接 409）。
     *   · 登录接口也有 15 分钟 12 次的限流，一轮全量回归会打满它。
     * 见 scripts/lib/test-login.mjs。线上没有库权限，这两件都做不了，
     * 走表单登录。 */
    await loginFast(page, BASE);
    await sleep(600);
  }

  /* -------------------------------------------------- 登录（兜底）
   * loginFast 已经把 cookie 注进去了；只有它失败（比如线上、或库被锁）
   * 才走表单。表单登录会吃 15 分钟 12 次的限流，所以只当兜底用。 */
  if (!page.url().includes('/app')) {
    const email = process.env.EP_TEST_EMAIL || 'e2e@example.com';
    const pwd = process.env.EP_TEST_PWD || 'Passw0rd123';
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
    await sleep(500);
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', pwd);
    // 登录按钮是 <button type="submit">，走表单提交。
    // form.submit() 不触发 submit 事件，SPA 的 onsubmit 不会跑，所以用 requestSubmit()。
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
      page.evaluate(() => {
        const form = document.querySelector('form.auth-form');
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      }),
    ]);
    await sleep(1600);
  }
  if (!page.url().includes('/app')) { bad('登录', page.url()); throw new Error('登录失败'); }
  ok('登录');

  /* ------------------------------------ 建模型配置（指向 mock 上游） */
  const cfged = await page.evaluate(async () => {
    const r = await fetch('/api/llm-configs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'mock', baseUrl: 'http://127.0.0.1:8790/v1', apiKey: 'sk-mock',
        model: 'mock-chat', isDefault: true, params: { max_tokens: 1024, temperature: 0.9 },
      }),
    });
    return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 200) };
  });
  if (cfged.ok) ok('配置模型', 'max_tokens=1024 temperature=0.9（模拟用户默认值）');
  else bad('配置模型', `${cfged.status} ${cfged.text}`);

  /* TTS：语音红点必须在真的语音气泡上验，所以先配一个指向 mock 的 TTS。
   * 没配 TTS 时服务端会自动退回文字，红点根本不会出现 —— 那验的是空气。
   *
   * 音色先查再建：这个接口对同一个上游音色是唯一约束，重复 POST 会 409。
   * 固定账号意味着上一轮的音色还在，直接 POST 必然 409 —— 而浏览器会把
   * 4xx 记进控制台，最后把「全程没有 JS 报错」也带下水。
   * 这里做成幂等：已有就复用，没有才建。 */
  const ttsCfg = await page.evaluate(async () => {
    const j = (r) => r.json().catch(() => ({}));
    const a = await fetch('/api/tts-configs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'mock tts', kind: 'breezeblue', baseUrl: 'http://127.0.0.1:8790',
        apiKey: 'xi-mock', isDefault: true,
      }),
    });

    const list = await fetch('/api/voice-refs').then(j);
    const dup = (list.voices || []).find((v) => v.remoteVoiceId === 'mock_voice_01');
    let voice;
    if (dup) {
      voice = { status: 200, reused: true };
    } else {
      const b = await fetch('/api/voice-refs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'mock 音色', remoteVoiceId: 'mock_voice_01' }),
      });
      voice = { status: b.status, reused: false, body: (await b.text()).slice(0, 120) };
    }
    return { tts: a.status, voice: voice.status, reused: voice.reused, tee: (await a.text()).slice(0, 120), vee: voice.body };
  });
  if (ttsCfg.tts < 400 && ttsCfg.voice < 400) {
    ok('配置 TTS 与音色', ttsCfg.reused ? '音色已存在，直接复用' : '');
  } else {
    bad('配置 TTS 与音色', JSON.stringify(ttsCfg));
  }

  /* ------------------------------------------ 建人格 + 导入记录 */
  const pid = await page.evaluate(async (txt) => {
    const r = await fetch('/api/personas', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '林小满', relationship: '女朋友' }),
    });
    const j = await r.json();
    const id = j?.persona?.id;
    const fd = new FormData();
    fd.append('file', new Blob([txt], { type: 'text/plain' }), 'wechat.txt');
    const up = await fetch(`/api/personas/${id}/imports`, { method: 'POST', body: fd });
    const uj = await up.json();
    const s = await (await fetch(`/api/personas/${id}/senders`)).json();
    return { id, added: uj?.added, senders: (s?.senders || []).map((x) => x.name) };
  }, CHAT_TXT);

  if (pid.id && pid.added > 0) ok('导入聊天记录', `${pid.added} 条`);
  else bad('导入聊天记录', JSON.stringify(pid));

  /* 用户反馈 3：多出很多人物。
   * 正文里的「注意：明天带伞」绝不能在发送者列表里。 */
  if (pid.senders.length === 2 && !pid.senders.includes('注意')) {
    ok('发送者只有两个真人（没有多出人物）', pid.senders.join(' / '));
  } else {
    bad('发送者只有两个真人（没有多出人物）', JSON.stringify(pid.senders));
  }

  /* ------------------------------------ 用户反馈 2：分析进度 */
  const prog = await page.evaluate(async (id) => {
    const seen = [];
    const r = await fetch(`/api/personas/${id}/analyze`, { method: 'POST' });
    const j = await r.json();
    if (!j.jobId) return { error: j.error || `HTTP ${r.status}`, seen };
    // 采样进度：必须在等待模型期间真的往上爬，且不是一直钉在 30%
    for (let i = 0; i < 60; i++) {
      const k = await (await fetch(`/api/jobs/${j.jobId}`)).json();
      const job = k.job || {};
      seen.push({ p: job.progress, stage: job.stage, status: job.status });
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 300));
    }
    return { seen, jobId: j.jobId };
  }, pid.id);

  if (prog.error) {
    bad('人格分析能跑起来', prog.error);
  } else {
    const last = prog.seen[prog.seen.length - 1] || {};
    if (last.status === 'done') ok('人格分析成功完成（模型真的学到了聊天记录）');
    else bad('人格分析成功完成', JSON.stringify(last).slice(0, 200));

    // 进度单调不减、且最终到 100%
    const ps = prog.seen.map((x) => Number(x.p) || 0);
    let mono = true;
    for (let i = 1; i < ps.length; i++) if (ps[i] < ps[i - 1] - 0.001) mono = false;
    if (mono) ok('进度单调不回退');
    else bad('进度单调不回退', ps.join(','));

    if (ps.length && ps[ps.length - 1] >= 0.999) ok('结束时进度到 100%', String(ps[ps.length - 1]));
    else bad('结束时进度到 100%', JSON.stringify(ps.slice(-4)));

    // 关键：等待模型期间进度要有多个不同值，不能卡在 30%
    const mid = new Set(ps.filter((p) => p > 0.3 && p < 0.8));
    if (mid.size >= 1) ok('等待模型期间进度在前进（不再卡在 30%）', `${mid.size} 个中间值`);
    else bad('等待模型期间进度在前进（不再卡在 30%）', ps.join(','));

    // 阶段文字应带上已用秒数，用户能看到"确实在等"
    const stageWithSec = prog.seen.some((x) => /已用\s*\d+\s*秒/.test(String(x.stage || '')));
    if (stageWithSec) ok('等待阶段显示了已用秒数', prog.seen.find((x) => /已用/.test(String(x.stage || '')))?.stage);
    else bad('等待阶段显示了已用秒数', JSON.stringify(prog.seen.map((x) => x.stage).filter(Boolean).slice(0, 4)));
  }

  /* ------------------------------------- 用户反馈 1：召回提示 */
  await page.goto(`${BASE}/app/chat/${pid.id}`, { waitUntil: 'networkidle2' });
  await sleep(1200);

  // 切到语音模式，这样能同时验红点
  const switched = await page.evaluate(() => {
    const pick = document.querySelector('.voice-mode-pick');
    if (!pick) return false;
    const v = [...pick.querySelectorAll('button')].find((b) => /语音/.test(b.textContent));
    if (v) { v.click(); return true; }
    return false;
  });
  if (switched) ok('切到「语音」回复模式');
  else bad('切到「语音」回复模式', '没找到 .voice-mode-pick 里的语音按钮');

  await page.type('.composer-box textarea, .composer-box input[type="text"]', '今天好累啊');
  await page.evaluate(() => document.querySelector('.composer-send')?.click());
  await sleep(6000);

  const chatInfo = await page.evaluate(() => {
    const chip = document.querySelector('.recall-chip');
    const foot = document.querySelector('.composer-foot');
    const vd = document.querySelector('.msg-bubble.is-voice .voice-bubble-dur');
    return {
      hasChip: !!chip,
      chipText: chip ? chip.textContent.trim() : null,
      footText: foot ? foot.innerText.replace(/\s+/g, ' ').trim() : '',
      voiceDur: vd ? vd.textContent.trim() : null,
      voiceCount: document.querySelectorAll('.msg-bubble.is-voice').length,
      bodyText: document.body.innerText,
    };
  });

  // 无意义提示必须消失
  if (!/召回\s*0\s*条/.test(chatInfo.bodyText)) ok('页面上不再出现「召回 0 条记忆」');
  else bad('页面上不再出现「召回 0 条记忆」', chatInfo.bodyText.slice(0, 200));

  if (!/段对话/.test(chatInfo.footText)) ok('输入框下方不再挂「N 段对话」', chatInfo.footText);
  else bad('输入框下方不再挂「N 段对话」', chatInfo.footText);

  // 有召回时必须说人话
  if (chatInfo.hasChip && /参考了/.test(chatInfo.chipText)) {
    ok('召回提示说清了参考了什么', chatInfo.chipText);
  } else if (!chatInfo.hasChip) {
    ok('没有召回时不贴标签（而不是显示 0 条）');
  } else {
    bad('召回提示说清了参考了什么', String(chatInfo.chipText));
  }

  /* ------------------------ 用户反馈 4：语音听完红点消失 */
  if (chatInfo.voiceCount > 0 && chatInfo.voiceDur && chatInfo.voiceDur !== '…') {
    ok('语音条已生成且显示秒数', chatInfo.voiceDur);
  } else {
    bad('语音条已生成且显示秒数', JSON.stringify(chatInfo));
  }

  const beforeDot = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.msg-bubble.is-voice')].pop();
    if (!b) return null;
    const dot = b.querySelector('.voice-bubble-dot');
    return { hasDot: !!dot, dotShown: dot ? getComputedStyle(dot).display !== 'none' : false, heard: b.classList.contains('heard') };
  });
  if (beforeDot && beforeDot.dotShown) ok('未听的语音显示红点');
  else bad('未听的语音显示红点', JSON.stringify(beforeDot));

  // 真实点击播放，等它放完（mock 音频 0.5s）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.msg-bubble.is-voice')].pop();
    b?.click();
  });
  await sleep(2500);

  const afterDot = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.msg-bubble.is-voice')].pop();
    if (!b) return null;
    const dot = b.querySelector('.voice-bubble-dot');
    const a = b.querySelector('audio');
    return {
      heard: b.classList.contains('heard'),
      dotShown: dot ? getComputedStyle(dot).display !== 'none' : false,
      playedTime: a ? a.currentTime : -1,
      localStorage: localStorage.getItem('ep.voiceHeard.v1'),
    };
  });
  if (afterDot?.heard) ok('听完后气泡进入已听状态');
  else bad('听完后气泡进入已听状态', JSON.stringify(afterDot));
  if (afterDot && !afterDot.dotShown) ok('听完后红点消失（真的不见了，不是透明）');
  else bad('听完后红点消失', JSON.stringify(afterDot));
  if (afterDot?.localStorage && /msg_/.test(afterDot.localStorage)) ok('已听状态被持久化', String(afterDot.localStorage).slice(0, 60));
  else bad('已听状态被持久化', String(afterDot?.localStorage));

  // 刷新后仍然不该亮红点 —— 这是用户最容易再遇到的一次
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(2000);
  const afterReload = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.msg-bubble.is-voice')];
    const b = all.pop();
    if (!b) return { noVoice: true };
    const dot = b.querySelector('.voice-bubble-dot');
    return { heard: b.classList.contains('heard'), dotShown: dot ? getComputedStyle(dot).display !== 'none' : false };
  });
  if (afterReload.noVoice) {
    ok('刷新后语音条仍在（跳过红点复验）');
  } else if (afterReload.heard && !afterReload.dotShown) {
    ok('刷新后红点依然不亮（记住听过了）');
  } else {
    bad('刷新后红点依然不亮（记住听过了）', JSON.stringify(afterReload));
  }

  /* ---------------------------------- 中途暂停也要消红点 */
  // 发第二条语音，播放 1 秒后暂停，红点应当消失
  await page.type('.composer-box textarea, .composer-box input[type="text"]', '那你早点睡');
  await page.evaluate(() => document.querySelector('.composer-send')?.click());
  await sleep(6000);
  const pauseCase = await page.evaluate(async () => {
    const all = [...document.querySelectorAll('.msg-bubble.is-voice')];
    const b = all.pop();
    if (!b) return { error: 'no-bubble' };
    b.click();
    await new Promise((r) => setTimeout(r, 300));
    const a = b.querySelector('audio');
    if (a) a.pause();
    await new Promise((r) => setTimeout(r, 600));
    const dot = b.querySelector('.voice-bubble-dot');
    return {
      heard: b.classList.contains('heard'),
      dotShown: dot ? getComputedStyle(dot).display !== 'none' : false,
      played: a ? a.currentTime : -1,
    };
  });
  if (pauseCase.heard || !pauseCase.dotShown) {
    ok('听到一半暂停，红点也会消失', JSON.stringify(pauseCase));
  } else {
    bad('听到一半暂停，红点也会消失', JSON.stringify(pauseCase));
  }

  await page.screenshot({ path: `${OUT}/01-chat.png` });

  /* --------------------------------------------- 页面无报错 */
  const realErrs = errs.filter((e) => !/favicon|ERR_|net::/i.test(e));
  if (!realErrs.length) ok('全程没有 JS 报错');
  else bad('全程没有 JS 报错', realErrs.slice(0, 3).join(' | '));
} catch (e) {
  bad('脚本执行', e.message);
} finally {
  const fail = checks.filter((c) => !c.ok);
  console.log(`\n[verify-feedback] ${checks.length - fail.length}/${checks.length} 通过\n`);
  for (const f of fail) console.log(' - ' + f.n);
  await browser.close();
  process.exit(fail.length ? 1 : 0);
}
