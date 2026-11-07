import { h, mount, api, toast, navigate, ApiError, svgIcon } from '../core.js';
import { state, loadSession, loadPersonas, setTitle } from '../shell.js';

/* ==================================================================
 * 云端第三方登录（微信 / 手机号）
 *
 * 分工：
 *   浏览器只用 SDK 完成「拿云端 session」这一步（扫码、收验证码），
 *   拿到 accessToken 后交给服务端 /api/auth/cloud/exchange，
 *   由服务端回源确认身份并下发我们自己的 ep_session。
 *
 * 为什么不前端直接写身份：
 *   前端报什么都不可信。服务端必须自己拿 token 去问云端「你是谁」，
 *   否则伪造 openid 就能登录别人账号。
 * ================================================================== */

let sdkPromise = null;
async function cloudSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const cfg = await api.get('/api/auth/cloud-config');
      if (!cfg?.enabled) throw new Error('本站还没有配置云登录服务。');
      const { createWorkBuddyCloud } = await import('/vendor/workbuddy-cloud-sdk.js');
      return createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
        publishableKey: cfg.publishableKey,
      });
    })();
  }
  return sdkPromise;
}

/** 微信扫码登录入口。返回 false 表示没能跳转（调用方自行提示）。 */
async function startWechat(next) {
  // 先在本页把「这个地址根本走不通」判断掉。
  // 原因：relay 要求 callback_url 是**已发布站点的 https 地址**，
  // localhost / 127.0.0.1 / http 一律 400。如果照直跳过去，用户会落在
  // 一个纯 JSON 的错误页上，既看不懂也没有返回按钮 —— 那是死路。
  // 与其把人送进死胡同，不如在这里直接说清楚该去哪儿。
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i
    .test(location.hostname);
  if (isLocal || location.protocol !== 'https:') {
    throw new Error('微信扫码只能在已发布的正式域名（https）上使用。本地或预览地址会被微信登录网关拒绝，请先发布站点，或改用邮箱 / 手机号登录。');
  }

  const cli = await cloudSdk();
  if (!cli.oauthRelayBaseUrl) {
    throw new Error('服务端没有配置微信登录网关，请联系管理员。');
  }
  // 回调必须回到「当前页」，且要带上 next，否则回来就丢了目标页面。
  const back = new URL('/login', location.origin);
  back.searchParams.set('next', next);
  back.searchParams.set('wechat', '1');
  const r = await cli.auth.signInWithOAuth({ provider: 'wechat', redirectTo: back.toString() });
  if (r.error) {
    throw new Error(r.error.message || '无法发起微信登录');
  }
  location.assign(r.data.url);
  return true;
}

/**
 * 处理微信回调：URL 上带 ?code=&state= 时说明刚从微信回来。
 * 成功后必须把 code 从地址栏抹掉——它会一次性失效，留着只会误导刷新。
 */
async function finishWechatCallback() {
  const q = new URLSearchParams(location.search);
  if (q.get('wechat') !== '1' || !q.get('code')) return null;
  const cli = await cloudSdk();
  // SDK 自己会校验 state / provider_id，并用 PKCE 换 session
  const r = await cli.auth.handleWechatWebCallback();
  if (r.error) throw new Error(r.error.message || '微信登录失败，请重试');
  /* 这里**必须**用换回来的那个 session，不能再调一次 getSession()。
   *
   * 原因：getSession() 内部是 ensure()，只要 expiresAt 看上去"快过期了"
   * 就拿 refresh_token 去换一个新的 —— 而云端一旦签发新 token，**旧的那个
   * 立刻作废**。于是我们拿去换身份的是一个刚被自己弄废的 token，
   * 云端只好回 "invalid, expired or issued for another client"。
   *
   * handleWechatWebCallback 已经把 session 写在返回值里了，直接用。 */
  const session = r.data;
  if (!session?.accessToken) throw new Error('微信登录没有拿到凭据，请重试');

  const ex = await api.post('/api/auth/cloud/exchange', {
    accessToken: session.accessToken, intent: 'wechat',
  });
  // 清掉地址栏里的 code/state，避免被收藏或分享后误用
  const clean = new URL(location.href);
  for (const k of ['code', 'state', 'wechat', 'provider_id', 'provider', 'scode']) clean.searchParams.delete(k);
  history.replaceState(null, '', clean.pathname + (clean.search ? clean.search : ''));
  return ex;
}

/** 一个好看的「或」分隔线 */
function orDivider() {
  return h('div.auth-or', h('span', { text: '或' }));
}

/* ------------------------------------------------------------------ *
 * 微信回跳时的等待态
 *
 * 从微信扫完码跳回来，地址栏上带着 ?wechat=1&code=...，服务端还要拿
 * 这个 code 去换 token、再问云端「你是谁」，整条链路 1~3 秒（网络差时更久）。
 *
 * 这段时间以前页面上**什么都不会变**：用户看到的就是一张普通的登录页，
 * 像什么都没发生。他刚在微信里点完「允许」，回来却安静得像失败了，
 * 于是要么再扫一次，要么以为登录没成功直接走掉。
 *
 * 所以这里盖一层明确的提示：正在验证、请勿关闭页面。它同时挡住
 * 底下的邮箱表单 —— 换 token 还在跑的时候用户手动登另一个号，
 * 两个会话会互相覆盖，最后谁也登不上。
 * ------------------------------------------------------------------ */
const WX_STEPS = [
  '正在向微信确认身份…',
  '正在读取你的授权信息…',
  '正在建立登录状态…',
];

function wechatWaitOverlay() {
  const label = h('div.wx-wait-label', { text: WX_STEPS[0] });
  const bar = h('div.wx-wait-bar-fill');
  const note = h('div.wx-wait-note', { text: '这一步通常只要几秒。请不要关闭或刷新这个页面。' });

  const el = h('div.wx-wait', { role: 'status', 'aria-live': 'polite' },
    h('div.wx-wait-card',
      h('div.wx-wait-ico', svgIcon('wechatBubble')),
      h('h2.wx-wait-title', { text: '正在完成微信登录' }),
      label,
      h('div.wx-wait-bar', bar),
      note
    )
  );

  /* 进度条不假装真实进度，只按时间往前爬到一个不会到头的值
   * （0.9 封顶）—— 真到了 100% 却不跳转，反而更像卡死。
   * 文案跟着阶段走，给用户"在动"的确认。 */
  let i = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    bar.style.transform = `scaleX(${Math.min(0.9, 0.12 + sec / 6)})`;
    const next = Math.min(WX_STEPS.length - 1, Math.floor(sec / 1.6));
    if (next !== i) { i = next; label.textContent = WX_STEPS[i]; }
    // 超过 8 秒还没好，主动解释一下在等什么，而不是让进度条干爬
    if (sec > 8) {
      note.textContent = '网络似乎有点慢，还在等微信的回应。如果超过 1 分钟没有反应，请返回登录页重试。';
    }
  }, 200);

  el.dataset.stop = String(0);
  el.stop = () => {
    clearInterval(timer);
    el.dataset.stop = String(1);
    el.remove();
  };
  return el;
}

/** 这一趟是不是刚从微信跳回来？决定要不要盖等待层。 */
function isWechatReturn() {
  const q = new URLSearchParams(location.search);
  return q.get('wechat') === '1' && !!q.get('code');
}

/** 第三方登录按钮组：只在服务端确认云登录可用时才渲染 */
function socialBlock({ next, onError, allowWechat = true }) {
  if (!state.config?.cloudAuthEnabled) {
    // 云服务没配置：整块不出现。不能画一个点了必然报错的按钮。
    return null;
  }
  const wrap = h('div.auth-social');

  if (allowWechat) {
    const wxBtn = h('button.btn.auth-wx.w-full', { type: 'button' },
      svgIcon('wechatBubble'),
      h('span', { text: '微信扫码登录' })
    );
    wxBtn.addEventListener('click', async () => {
      wxBtn.disabled = true;
      const label = wxBtn.querySelector('span');
      const old = label.textContent;
      // 跳转本身也要时间（要先把 SDK 拉起来、拿 relay 地址），
      // 只改个「正在跳转…」不够明显，加一个转圈让用户知道点了有反应。
      label.textContent = '正在打开微信…';
      wxBtn.classList.add('is-busy');
      try {
        await startWechat(next);
      } catch (e) {
        onError(e.message);
        wxBtn.disabled = false;
        wxBtn.classList.remove('is-busy');
        label.textContent = old;
      }
    });
    wrap.append(wxBtn);
  }

  wrap.append(
    h('a.btn.auth-phone.w-full', { href: `/phone-login?next=${encodeURIComponent(next)}` },
      svgIcon('phoneCode'),
      h('span', { text: '手机号验证码登录' })
    )
  );
  return wrap;
}

function authLayout({ title, subtitle, form, alt, quote, social = null }) {
  return h('div.auth-wrap',
    h('aside.auth-side',
      h('a.brand', { href: '/' },
        h('span.mark', { text: 'E' }),
        h('span', { text: 'EchoPersona' })
      ),
      h('div.grow'),
      h('div.quote', { text: quote.text }),
      h('div.quote-attr', { text: quote.attr })
    ),
    h('main.auth-main',
      h('div.auth-box',
        h('h1', { text: title }),
        h('p.auth-sub', { text: subtitle }),
        social,
        social ? orDivider() : null,
        form,
        alt
      )
    )
  );
}

export function loginPage(params) {
  setTitle('登录');
  const next = params.get('next') || '/app';

  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: '••••••••' });
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });
  const btn = h('button.btn.btn-copper.btn-lg.w-full', { type: 'submit' }, '登录');

  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      btn.replaceChildren(h('span.spin'), ' 登录中');
      try {
        await api.post('/api/auth/login', { email: email.value, password: pw.value });
        await loadSession();
        await loadPersonas();
        toast('登录成功');
        navigate(next, { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = '登录';
        if (ex.body?.needVerify) {
          err.textContent = ex.message;
        }
      }
    },
  },
    h('div.field', h('label', { text: '邮箱' }), email),
    h('div.field', h('label', { text: '密码' }), pw),
    err,
    btn
  );

  mount(authLayout({
    title: '欢迎回来',
    subtitle: '登录后继续与你的 AI 人格对话。',
    social: socialBlock({ next, onError: (m) => { err.textContent = m; } }),
    form,
    alt: h('div.auth-alt',
      h('a', { href: '/forgot-password', text: '忘记密码？' }),
      h('span', { text: ' · ' }),
      h('a', { href: '/register', text: '还没有账户？注册' })
    ),
    quote: {
      text: '「有些话，只有用那个人的语气说出来，才算说完了。」',
      attr: 'EchoPersona · 产品理念',
    },
  }));

  // 从微信回来的那一趟：URL 上带 code。放在渲染之后处理，
  // 这样即使换 token 失败，用户也已经看到登录页和错误位置。
  //
  // 但"已经看到登录页"不等于"知道自己正在登录"：换 token 的那几秒里
  // 页面看起来毫无变化，用户会以为微信那边点完没生效。所以先盖一层
  // 明确的等待提示，成功/失败都把它撤掉。
  const waiting = isWechatReturn() ? wechatWaitOverlay() : null;
  if (waiting) document.body.append(waiting);

  finishWechatCallback().then(async (r) => {
    waiting?.stop();
    if (!r) return;
    await loadSession();
    await loadPersonas();
    toast(r.created ? '账号已创建，欢迎' : '登录成功');
    navigate(next, { replace: true });
  }).catch((e) => {
    waiting?.stop();
    err.textContent = e.message;
    /* 失败时要把地址栏上的 code/state 清掉。
     * 不清的话用户一刷新，又重新走一遍必然失败的换 token，
     * 而且看起来像是"一直卡在这里"。 */
    const clean = new URL(location.href);
    for (const k of ['code', 'state', 'wechat', 'provider_id', 'provider', 'scode']) clean.searchParams.delete(k);
    history.replaceState(null, '', clean.pathname + (clean.search ? clean.search : ''));
  });
}

/* ----------------------------------------------------------------- *
 * 手机号验证码登录
 *
 * 两步：发码 → 验证。云端对同一号码限 1 条/分钟（实测 429），
 * 所以按钮要真的倒计时，否则用户会一直点、一直被拒。
 * ----------------------------------------------------------------- */

/** 一次性丢弃口令：只为满足云端 `/signup` 的必填校验。
 *  `crypto.randomUUID` 在非 https 的局域网地址上不存在（非 secure context），
 *  这里用 getRandomValues 并留 Math.random 兜底，保证按钮不会因此报错。 */
function discardPassword() {
  const bytes = new Uint8Array(18);
  try {
    (globalThis.crypto || window.crypto).getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const rnd = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `ep_${rnd}Aa1!`;
}

export function phoneLoginPage(params) {
  setTitle('手机号登录');
  const next = params.get('next') || '/app';

  const cc = h('input.phone-cc', {
    type: 'text', value: '+86', maxlength: 5, inputmode: 'tel', 'aria-label': '国家码',
  });
  const num = h('input', {
    type: 'tel', required: true, autocomplete: 'tel-national',
    placeholder: '13800000000', maxlength: 20, inputmode: 'numeric',
  });
  const code = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    placeholder: '6 位验证码', maxlength: 8,
  });

  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });
  const hint = h('div.tiny.muted', { style: { minHeight: '1.2em' } });

  // 这里刻意不用 btn-ghost：幽灵按钮是透明底，和输入框并排时看起来
  // 像一截没有归属的文字，用户不知道它能不能点。发验证码是个明确动作，
  // 需要看得见的边界。
  const sendBtn = h('button.btn.send-code', { type: 'button' }, '获取验证码');
  const submit = h('button.btn.btn-copper.btn-lg.w-full', { type: 'submit' }, '登录 / 注册');

  let verificationId = '';
  // 上游在发码时就告诉我们这个号码是不是已注册用户（`is_user`）。
  // 验码时必须如实回传它 —— 早期版本这里写死 `isExistingUser: true`，
  // 于是新号码被送去走「登录」，云端没有这个账号，用户看到的是
  // 「用户不存在」。一个本该是注册的流程，报了一个像登录失败的错。
  let isExistingUser = false;
  let countdown = 0;
  let timer = null;

  function tick() {
    if (countdown <= 0) {
      clearInterval(timer);
      timer = null;
      sendBtn.disabled = false;
      sendBtn.textContent = '重新获取';
      return;
    }
    sendBtn.textContent = `${countdown}s 后重发`;
    countdown -= 1;
  }

  /** 云端要求号码形如 `+86 13800000000`（国家码与号码之间必须有空格）。
   *  这个格式不是随手定的：实测 `+8613800000000` 会被上游
   *  以 regex 不匹配直接 400 拒掉。 */
  function fullNumber() {
    const c = String(cc.value || '+86').trim().replace(/\s+/g, '');
    const n = String(num.value || '').replace(/\D/g, '');
    return `${c.startsWith('+') ? c : `+${c}`} ${n}`;
  }

  sendBtn.addEventListener('click', async () => {
    err.textContent = '';
    const digits = String(num.value || '').replace(/\D/g, '');
    if (digits.length < 6) { err.textContent = '请填写正确的手机号'; return; }
    sendBtn.disabled = true;
    sendBtn.textContent = '发送中…';
    try {
      const cli = await cloudSdk();
      const r = await cli.auth.sendOtp({ phone: fullNumber() });
      if (r.error) throw new Error(r.error.message || '验证码发送失败');
      verificationId = r.data.verificationId;
      // 新号码返回 false、老用户返回 true，两种情况都要能把人送进去：
      // 老用户走登录，新用户走注册。之前的按钮文案「登录 / 注册」是对的，
      // 只是背后这个布尔值被写死了，注册那一半从来没生效过。
      isExistingUser = r.data.isExistingUser === true;
      countdown = 60;
      tick();
      if (!timer) timer = setInterval(tick, 1000);
      hint.textContent = '验证码已发送，请查看短信。';
      code.focus();
    } catch (e) {
      err.textContent = e.message;
      sendBtn.disabled = false;
      sendBtn.textContent = '获取验证码';
    }
  });

  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!verificationId) { err.textContent = '请先获取验证码'; return; }
      const c = String(code.value || '').replace(/\D/g, '');
      if (c.length < 4) { err.textContent = '请输入收到的验证码'; return; }

      submit.disabled = true;
      submit.replaceChildren(h('span.spin'), ' 验证中');
      try {
        const cli = await cloudSdk();
        /* 注册分支必须带 password：云端 `/signup` 要求
         * verification_token + password，只给 token 会被上游拒掉。
         *
         * 这个密码本地并不使用（本地账号由服务端按身份另建），
         * 但也不能省 —— 少了它，新用户永远注册不成功。
         * 用随机串而不是固定值：固定值等于给别人的云端账号留一个已知口令。
         * 不用 crypto.randomUUID：http 的局域网地址上它不是 secure context，
         * 会直接抛错，把「注册」变成另一种失败。 */
        const r = await cli.auth.verifyOtp({
          verificationId, token: c, phone: fullNumber(),
          isExistingUser,
          password: isExistingUser ? undefined : discardPassword(),
        });
        if (r.error) throw new Error(r.error.message || '验证码校验失败');

        /* 同微信回调：直接用 verifyOtp 换回来的 session。
         * 再调 getSession() 可能触发 refresh，把刚签发的 token 轮换掉，
         * 我们随后拿一个已作废的 token 去换身份，必然 401。 */
        const session = r.data;
        if (!session?.accessToken) throw new Error('验证没有拿到凭据，请重试');

        const ex = await api.post('/api/auth/cloud/exchange', {
          accessToken: session.accessToken, intent: 'phone',
        });
        await loadSession();
        await loadPersonas();
        toast(ex.created ? '账号已创建，欢迎' : '登录成功');
        navigate(next, { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
        submit.textContent = '登录 / 注册';
      }
    },
  },
    h('div.field',
      h('label', { text: '手机号' }),
      h('div.phone-row', cc, num)
    ),
    h('div.field',
      h('label', { text: '短信验证码' }),
      h('div.code-row', code, sendBtn)
    ),
    err, hint, submit
  );

  mount(authLayout({
    title: '手机号登录',
    subtitle: '没注册过？验证通过后会自动为你创建账号。',
    form,
    alt: h('div.auth-alt',
      h('a', { href: `/login?next=${encodeURIComponent(next)}`, text: '← 用邮箱登录' })
    ),
    quote: {
      text: '「手机号只是一把钥匙，锁着的东西还是你的。」',
      attr: 'EchoPersona · 隐私说明',
    },
  }));
}

export function registerPage() {
  setTitle('注册');

  const name = h('input', { type: 'text', autocomplete: 'nickname', placeholder: '你想被怎么称呼', maxlength: 60 });
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: '至少 8 位，含字母和数字' });
  const pw2 = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: '再输入一次' });
  const consent = h('input', { type: 'checkbox' });
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });
  const btn = h('button.btn.btn-copper.btn-lg.w-full', { type: 'submit' }, '创建账户');

  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (pw.value !== pw2.value) { err.textContent = '两次输入的密码不一致'; return; }
      if (!consent.checked) { err.textContent = '请先阅读并同意隐私说明'; return; }
      btn.disabled = true;
      btn.replaceChildren(h('span.spin'), ' 创建中');
      try {
        await api.post('/api/auth/register', {
          email: email.value.trim(), password: pw.value, displayName: name.value.trim(), consent: true,
        });
        await loadSession();
        await loadPersonas();
        toast('账户已创建，欢迎');
        navigate('/app', { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = '创建账户';
      }
    },
  },
    h('div.field', h('label', { text: '昵称（可选）' }), name),
    h('div.field', h('label', '邮箱 ', h('span.req', '*')), email),
    h('div.field', h('label', '密码 ', h('span.req', '*')), pw),
    h('div.field', h('label', '确认密码 ', h('span.req', '*')), pw2),
    h('label.checkbox', consent,
      h('span', { html: '我已阅读并同意数据使用说明：我上传的聊天记录仅用于为我本人构建 AI 人格，'
        + '不会用于训练模型；我确认对所上传内容拥有合法使用权。' })
    ),
    err,
    btn
  );

  mount(authLayout({
    // 微信/手机号登录建的账号没有密码，进设置页会看到「修改密码」表单，
    // 而那张表要填旧密码——他根本没有。所以要明确提示，并给「设密码」入口。
    title: '创建你的第一个回声',
    // 有了微信/手机号登录之后，「短信、实名一概不需要」这句就不成立了，
    // 继续挂着就是在骗用户。改成只陈述邮箱注册这条路的实际情况。
    subtitle: '用邮箱注册，只需要一个密码；也可以用微信或手机号直接开始。',
    form,
    alt: h('div.auth-alt', h('a', { href: '/login', text: '已有账户？登录' })),
    quote: {
      text: '「聊天记录里藏着一个人的节奏：什么时候停顿，什么时候岔开话题。」',
      attr: 'EchoPersona · 分析方法说明',
    },
  }));
}

export function forgotPage() {
  setTitle('找回密码');
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: '你注册时使用的邮箱' });
  const msg = h('div.tiny', { style: { minHeight: '1.2em' } });
  const btn = h('button.btn.btn-primary.btn-lg.w-full', { type: 'submit' }, '发送重置链接');

  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.replaceChildren(h('span.spin'), ' 发送中');
      try {
        const r = await api.post('/api/auth/forgot-password', { email: email.value.trim() });
        msg.style.color = 'var(--sage)';
        msg.textContent = r.message + (state.config.smtpConfigured ? '' : '（当前未配置邮件服务，请联系管理员在服务器日志中获取链接）');
      } catch (ex) {
        msg.style.color = 'var(--danger)';
        msg.textContent = ex.message;
      }
      btn.disabled = false;
      btn.textContent = '发送重置链接';
    },
  },
    h('div.field', h('label', { text: '注册邮箱' }), email),
    msg,
    btn
  );

  mount(authLayout({
    title: '找回密码',
    subtitle: '输入注册邮箱，我们会发送一个 1 小时内有效的重置链接。',
    form,
    alt: h('div.auth-alt', h('a', { href: '/login', text: '← 返回登录' })),
    quote: { text: '「密码会忘，语气不会。」', attr: 'EchoPersona' },
  }));
}

export function resetPage(params) {
  setTitle('重置密码');
  const token = params.get('token') || '';
  const pw = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: '至少 8 位，含字母和数字' });
  const pw2 = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: '再输入一次' });
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });
  const btn = h('button.btn.btn-primary.btn-lg.w-full', { type: 'submit' }, '设置新密码');

  if (!token) {
    err.textContent = '链接缺少凭证，请重新申请重置邮件。';
  }

  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (pw.value !== pw2.value) { err.textContent = '两次输入的密码不一致'; return; }
      btn.disabled = true;
      btn.replaceChildren(h('span.spin'), ' 提交中');
      try {
        await api.post('/api/auth/reset-password', { token, password: pw.value });
        toast('密码已更新，请重新登录', 'ok');
        setTimeout(() => navigate('/login', { replace: true }), 600);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = '设置新密码';
      }
    },
  },
    h('div.field', h('label', { text: '新密码' }), pw),
    h('div.field', h('label', { text: '确认新密码' }), pw2),
    err, btn
  );

  mount(authLayout({
    title: '设置新密码',
    subtitle: '设置完成后，其他设备上的登录状态会被注销。',
    form,
    alt: h('div.auth-alt', h('a', { href: '/login', text: '← 返回登录' })),
    quote: { text: '「重新开始，也是一种延续。」', attr: 'EchoPersona' },
  }));
}
