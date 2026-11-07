/**
 * 微信外观的真实浏览器验收。
 *
 * 不截图给机器看，而是让浏览器自己算样式 —— 这才是用户真正看到的东西。
 * 截图只能证明"画出来了"，getComputedStyle 能证明"颜色和形状是对的"。
 *
 * 用法： node scripts/verify-wechat-ui.mjs [baseUrl]
 */
import fs from 'node:fs';
import { launch } from './lib/browser.mjs';
import { loginFast } from './lib/test-login.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const OUT = '.tmp/shots-wx';
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const ok = (n, d = '') => { checks.push({ ok: true, n }); console.log(`  PASS ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { checks.push({ ok: false, n }); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); };

const browser = await launch({
  defaultViewport: { width: 1280, height: 860 },
});

const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  /* ---------------------------------------------------- 登录
   * 直接注入 session 而不是走登录表单：
   *   · 注册接口有 15 分钟 8 次的防刷限流；
   *   · 登录接口有 15 分钟 12 次的防刷限流，一轮全量回归会打满它。
   * 被限流拦住的是"测试准备"，不是被测功能，不该混进结论。
   * loginFast 同时会把账号的业务数据清空 —— 否则
   * 「默认是 classic 外观」会读到上一轮设的 wechat，
   * 重复 POST 同一个上游音色会 409 并污染「控制台无报错」。
   * 见 scripts/lib/test-login.mjs。 */
  await loginFast(page, BASE);
  await sleep(800);
  if (page.url().includes('/login')) {
    const email = process.env.EP_TEST_EMAIL || 'e2e@example.com';
    const pwd = process.env.EP_TEST_PWD || 'Passw0rd123';
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', pwd);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
      page.evaluate(() => {
        const form = document.querySelector('form.auth-form');
        if (form && form.requestSubmit) form.requestSubmit();
        else form?.submit();
      }),
    ]);
    await sleep(1600);
  }
  ok('登录', page.url());

  /* ------------------------------------------------ 默认经典外观 */
  const t0 = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  if (t0 === 'classic') ok('默认是 classic 外观');
  else bad('默认是 classic 外观', String(t0));

  /* ------------------------------------------------ 切到微信外观 */
  await page.goto(`${BASE}/app/settings/account`, { waitUntil: 'networkidle2' });
  await sleep(900);

  const hasCards = await page.evaluate(() => {
    const t = document.body.innerText;
    return t.includes('聊天界面') && t.includes('微信风格') && t.includes('经典');
  });
  if (hasCards) ok('设置页有「聊天界面」两个版本可选');
  else bad('设置页有「聊天界面」两个版本可选');

  await page.screenshot({ path: `${OUT}/01-settings.png` });

  // 点「微信风格」那张卡
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.innerText.includes('微信风格'));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) bad('点得到「微信风格」');
  await sleep(1500);

  const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  if (t1 === 'wechat') ok('切换后 html[data-ui-theme=wechat]');
  else bad('切换后 html[data-ui-theme=wechat]', String(t1));

  // 刷新后仍然是微信外观（说明存到了服务端）
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(900);
  const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  if (t2 === 'wechat') ok('刷新后外观仍然保持（服务端持久化）');
  else bad('刷新后外观仍然保持', String(t2));

  /* --------------------------------------------- 进聊天页量样式 */
  // 聊天页在「一个模型都没配」时会整页显示空状态（这是对的），
  // 所以先塞一个模型配置，让它渲染出真正的聊天界面。
  await page.evaluate(async () => {
    await fetch('/api/llm-configs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: '本地假模型', baseUrl: 'http://127.0.0.1:8791/v1', model: 'mock-model', apiKey: 'sk-fake', isDefault: true,
      }),
    });
  });

  // 先建一个人格（走接口，快）
  const personaId = await page.evaluate(async () => {
    const r = await fetch('/api/personas', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '林小满', relationship: '女朋友' }),
    });
    const j = await r.json();
    return j.persona?.id || null;
  });
  if (!personaId) { bad('建人格'); } else ok('建人格');

  // 塞两条消息进会话，这样页面有消息可量
  await page.evaluate(async (pid) => {
    const c = await fetch(`/api/personas/${pid}/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cj = await c.json();
    window.__cid = cj.chat?.id;
  }, personaId);

  await page.goto(`${BASE}/app/chat/${personaId}`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/02-chat-wechat.png` });

  const style = await page.evaluate(() => {
    const main = document.querySelector('.chat-main');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      theme: document.documentElement.getAttribute('data-ui-theme'),
      mainBg: cs(main)?.backgroundColor || null,
      composerWrapBg: cs(document.querySelector('.composer-wrap'))?.backgroundColor || null,
      headBg: cs(document.querySelector('.chat-head'))?.backgroundColor || null,
    };
  });

  if (style.theme === 'wechat') ok('聊天页带着 wechat 主题');
  else bad('聊天页带着 wechat 主题', String(style.theme));

  // #ededed = rgb(237, 237, 237)
  const wantBg = 'rgb(237, 237, 237)';
  if (style.mainBg === wantBg) ok('聊天区背景是微信灰 #EDEDED', style.mainBg);
  else bad('聊天区背景是微信灰', String(style.mainBg));

  if (style.composerWrapBg === 'rgb(247, 247, 247)') ok('输入栏底色 #F7F7F7', style.composerWrapBg);
  else bad('输入栏底色 #F7F7F7', String(style.composerWrapBg));

  /* --------------------------------- 真发一条消息，量气泡颜色和形状
   * 必须走真实的发送链路：导入的历史消息是 is_imported=1，
   * 不会出现在会话流里（那是"学到的东西"，不是"聊过的内容"）。
   * 所以这里用 mock 上游跑一次真实对话，拿到的气泡才是用户看到的那个。 */
  const ta = await page.$('.composer-box textarea');
  if (!ta) { bad('找得到输入框'); } else {
    await ta.click();
    await ta.type('在吗');
    await sleep(200);
    const before = await page.evaluate(() => document.querySelectorAll('.msg-bubble').length);
    await page.keyboard.press('Enter').catch(() => {});
    // Enter 可能只是换行，兜底点发送按钮
    await sleep(600);
    const afterEnter = await page.evaluate(() => document.querySelectorAll('.msg-bubble').length);
    if (afterEnter === before) {
      await page.evaluate(() => {
        const b = document.querySelector('.composer-send');
        b?.click();
      });
    }
    // 等流式回复落地
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const n = await page.evaluate(() => document.querySelectorAll('.msg-row.them .msg-bubble').length);
      if (n > 0) break;
    }
  }
  await page.screenshot({ path: `${OUT}/03-chat-sent.png` });

  const bubble = await page.evaluate(() => {
    const me = document.querySelector('.msg-row.me .msg-bubble');
    const them = document.querySelector('.msg-row.them .msg-bubble');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const out = {};
    if (me) {
      const s = cs(me);
      out.meBg = s.backgroundColor;
      out.meRadius = s.borderRadius;
      out.meHasTail = getComputedStyle(me, '::before').borderLeftWidth !== '0px';
    }
    if (them) {
      const s = cs(them);
      out.themBg = s.backgroundColor;
      out.themRadius = s.borderRadius;
      out.themHasTail = getComputedStyle(them, '::before').borderRightWidth !== '0px';
    }
    out.meCount = document.querySelectorAll('.msg-row.me').length;
    out.themCount = document.querySelectorAll('.msg-row.them').length;
    out.bubbleCount = document.querySelectorAll('.msg-bubble').length;
    return out;
  });

  if (bubble.meCount > 0) ok('自己的消息气泡已渲染', `${bubble.bubbleCount} 个气泡`);
  else bad('自己的消息气泡已渲染', JSON.stringify(bubble));

  if (bubble.meBg === 'rgb(149, 236, 105)') ok('自己的气泡是微信绿 #95EC69', bubble.meBg);
  else bad('自己的气泡是微信绿', String(bubble.meBg));

  if (bubble.themBg === 'rgb(255, 255, 255)') ok('对方的气泡是白底', bubble.themBg);
  else bad('对方的气泡是白底', String(bubble.themBg));

  if (bubble.meRadius && bubble.meRadius.startsWith('4px')) ok('气泡圆角 4px（不是药丸）', bubble.meRadius);
  else bad('气泡圆角 4px', String(bubble.meRadius));

  if (bubble.meHasTail && bubble.themHasTail) ok('两侧气泡都有指向头像的尖角');
  else bad('两侧气泡都有指向头像的尖角', JSON.stringify({ me: bubble.meHasTail, them: bubble.themHasTail }));

  /* 三列必须同一套灰阶。之前只给聊天区上色，外层导航栏还是纸色 #F2EDE6，
     表现为「左边是另一个应用」。 */
  const cols = await page.evaluate(() => {
    const bg = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    return { sidebar: bg('.sidebar'), rail: bg('.chat-rail'), main: bg('.chat-main') };
  });
  if (cols.sidebar === 'rgb(247, 247, 247)') ok('左侧导航栏是微信浅灰 #F7F7F7', cols.sidebar);
  else bad('左侧导航栏是微信浅灰', String(cols.sidebar));
  if (cols.rail === 'rgb(247, 247, 247)') ok('会话列表是微信浅灰', cols.rail);
  else bad('会话列表是微信浅灰', String(cols.rail));

  /* ------------------------------------ 切回经典，确认能还原 */
  await page.evaluate(async () => {
    await fetch('/api/me', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiTheme: 'classic' }),
    });
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);
  const back = await page.evaluate(() => {
    const main = document.querySelector('.chat-main');
    return {
      theme: document.documentElement.getAttribute('data-ui-theme'),
      mainBg: main ? getComputedStyle(main).backgroundColor : null,
    };
  });
  if (back.theme === 'classic' && back.mainBg !== 'rgb(237, 237, 237)') {
    ok('切回经典后背景不是微信灰', String(back.mainBg));
  } else {
    bad('切回经典', JSON.stringify(back));
  }
  await page.screenshot({ path: `${OUT}/04-chat-classic.png` });

  /* -------------------------------- 侧边栏不该有重复设置入口 */
  const navDup = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.side-nav a, aside a')].map((a) => a.getAttribute('href') || '');
    return links.filter((h) => h.includes('/app/settings/'));
  });
  if (navDup.length === 0) ok('侧边栏没有指向设置子页的重复入口');
  else bad('侧边栏没有重复入口', JSON.stringify(navDup));

  /* ================================================================ *
   * 语音条：切到「语音」模式真发一条，必须直接出现语音气泡，
   * 而不是「先出文字气泡再变成语音」。
   *
   * 这一段必须在 wechat 主题下跑 —— 微信语音条的白底/绿底是
   * 主题规则，切回经典再断言 rgb(255,255,255) 是在测错目标。
   * ================================================================ */
  // 先切回 wechat
  await page.evaluate(async () => {
    await fetch('/api/me', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiTheme: 'wechat' }),
    });
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1200);

  // 配好 TTS + 音色
  await page.evaluate(async () => {
    await fetch('/api/tts-configs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'mock tts', kind: 'breezeblue', baseUrl: 'http://127.0.0.1:8791',
        apiKey: 'xi-mock', isDefault: true,
      }),
    });
    await fetch('/api/voice-refs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mock 音色', remoteVoiceId: 'mock_voice_01' }),
    });
  });

  // 切到语音模式（顶栏那三个按钮里点「语音」）
  const switched = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.voice-mode-pick button')];
    const b = btns.find((x) => x.textContent.trim() === '语音');
    if (!b) return false;
    b.click();
    return true;
  });
  if (switched) ok('能切到语音模式'); else bad('能切到语音模式');
  await sleep(500);

  const ta2 = await page.$('.composer-box textarea');
  if (!ta2) { bad('语音测试：找得到输入框'); } else {
    await ta2.click();
    await ta2.type('今天怎么样');
    await sleep(150);

    // 记录整个过程中是否出现过文字 delta —— 语音模式不该有。
    // 只盯"这次新长出来的气泡"：页面上本来就有历史文字气泡，
    // 用 querySelector('.msg-row.them .msg-bubble') 会一直命中最上面那条旧的，
    // 于是无论发什么都判定成"出现过文字"，是个假阳性。
    await page.evaluate(() => {
      window.__sawTextDelta = false;
      window.__baseRows = document.querySelectorAll('.msg-flow .msg-row').length;
      const isNew = (b) => {
        const row = b.closest('.msg-row');
        if (!row) return false;
        const all = [...document.querySelectorAll('.msg-flow .msg-row')];
        return all.indexOf(row) >= window.__baseRows;
      };
      const obs = new MutationObserver(() => {
        for (const b of document.querySelectorAll('.msg-row.them .msg-bubble')) {
          if (!isNew(b)) continue;
          if (b.classList.contains('is-voice')) continue;
          if (b.textContent.trim().length > 0) window.__sawTextDelta = true;
        }
      });
      const flow = document.querySelector('.msg-flow');
      if (flow) obs.observe(flow, { childList: true, subtree: true, characterData: true });
      window.__obs = obs;
    });

    await page.evaluate(() => document.querySelector('.composer-send')?.click());

    // 等语音气泡出现（取最新那条，避免拿到上一轮遗留的）
    let gotVoice = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      gotVoice = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.msg-bubble.is-voice')];
        return all.length > 0 && !!all[all.length - 1];
      });
      if (gotVoice) break;
    }
    await page.evaluate(() => window.__obs?.disconnect());
    await page.screenshot({ path: `${OUT}/05-chat-voice.png` });

    if (gotVoice) ok('发完直接出现语音气泡（不是文字气泡）');
    else bad('发完直接出现语音气泡', '没等到 .msg-bubble.is-voice');

    const voiceInfo = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.msg-bubble.is-voice')];
      const b = all[all.length - 1];
      if (!b) return null;
      const cs = getComputedStyle(b);
      return {
        bg: cs.backgroundColor,
        radius: cs.borderRadius,
        text: b.textContent.trim(),
        sawTextDelta: !!window.__sawTextDelta,
        hasSpeaker: !!b.querySelector('.voice-spk, svg'),
        isPending: b.classList.contains('voice-pending'),
      };
    });

    if (voiceInfo?.hasSpeaker) ok('语音条上有喇叭图标');
    else bad('语音条上有喇叭图标', JSON.stringify(voiceInfo));

    if (voiceInfo && !voiceInfo.sawTextDelta) {
      ok('整个过程没有出现文字气泡（没有"先文字再变语音"）');
    } else {
      bad('整个过程没有出现文字气泡', `sawTextDelta=${voiceInfo?.sawTextDelta}`);
    }

    if (voiceInfo?.bg === 'rgb(255, 255, 255)') ok('语音条是白底（微信风格）', voiceInfo.bg);
    else bad('语音条是白底', String(voiceInfo?.bg));

    if (voiceInfo?.text && voiceInfo.text !== '…' && /\d/.test(voiceInfo.text)) {
      ok('语音条上直接显示了真实秒数', voiceInfo.text);
    } else {
      bad('语音条上直接显示了真实秒数', String(voiceInfo?.text));
    }

    if (voiceInfo && !voiceInfo.isPending) ok('合成完不再是"合成中"占位态');
    else bad('合成完不再是占位态');

    // 微信收到语音不会自动播放 —— 静音是正确行为，响了才是 bug
    const autoPlayed = await page.evaluate(async () => {
      const all = [...document.querySelectorAll('.msg-bubble.is-voice')];
      const b = all[all.length - 1];
      const a = b?.querySelector('audio');
      return !!(a && !a.paused);
    });
    if (!autoPlayed) ok('收到语音不自动播放（和微信一致）');
    else bad('收到语音不自动播放', '刚收到就自己响了');

    /* 点一下应该真的开始播放。
     *
     * 注意不能断言「1200ms 后还在播」—— mock 音频只有 0.5 秒，
     * 那时候早就自然播完了，paused 必然是 true。这不是 bug，
     * 是断言写错了窗口。正确判据是「确实播出过声音」：
     * 当前进度 > 0，或已经进入 playing / heard 状态。 */
    const played = await page.evaluate(async () => {
      const all = [...document.querySelectorAll('.msg-bubble.is-voice')];
      const b = all[all.length - 1];
      if (!b) return { ok: false, why: 'no-bubble' };
      const a = b.querySelector('audio');
      const t0 = a ? a.currentTime : 0;
      b.click();
      await new Promise((r) => setTimeout(r, 600));
      const mid = a ? a.currentTime : 0;
      await new Promise((r) => setTimeout(r, 800));
      const t1 = a ? a.currentTime : 0;
      return {
        ok: mid > t0 || t1 > 0 || b.classList.contains('playing') || b.classList.contains('heard'),
        hasAudioEl: !!a,
        paused: a ? a.paused : null,
        progress: mid,
        cls: b.className,
      };
    });
    if (played.ok) ok('点语音条能播放');
    else bad('点语音条能播放', JSON.stringify(played));
  }

  /* ------------------------------------------------- 控制台干净 */
  const realErrs = errs.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  if (realErrs.length === 0) ok('控制台无报错');
  else bad('控制台无报错', realErrs.slice(0, 3).join(' | '));

  /* ------------------------------------------------- 溢出检查 */
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow <= 1) ok('没有横向溢出', `overflow=${overflow}`);
  else bad('没有横向溢出', `overflow=${overflow}px`);

} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n[verify-wechat-ui] ${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  -', f.n);
}
console.log(`截图：${OUT}`);
process.exit(failed.length ? 1 : 0);
