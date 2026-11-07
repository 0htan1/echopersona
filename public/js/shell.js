import { h, $, api, toast, avatar, navigate, parseRoute, svgIcon } from './core.js';

export const state = {
  user: null,
  config: {},
  personas: [],
  loading: true,
};

export async function loadSession() {
  try {
    const r = await api.get('/api/auth/session');
    state.user = r.user;
    state.config = r.config || {};
  } catch {
    state.user = null;
  }
  state.loading = false;
  // 登录状态一确定就把外观贴上，避免用户先看到默认样式再闪一下变成微信风
  applyUiTheme(state.user?.uiTheme);
  return state.user;
}

export async function loadPersonas() {
  if (!state.user) return [];
  try {
    const r = await api.get('/api/personas');
    state.personas = r.personas;
  } catch {
    state.personas = [];
  }
  return state.personas;
}

const NAV = [
  { key: 'dashboard', href: '/app', label: '工作台', icon: 'navDashboard' },
  { key: 'chat', href: '/app/chat', label: '对话', icon: 'navChat' },
  { key: 'personas', href: '/app/personas', label: '人格', icon: 'navPersona' },
  { key: 'voice', href: '/app/voice', label: '语音', icon: 'navVoice' },
  { key: 'settings', href: '/app/settings', label: '设置', icon: 'navSettings' },
];

export function shell({ active, title, content, wide = false, hideNav = false }) {
  const side = h('aside.sidebar', { id: 'sidebar' });

  // brand
  side.append(h('div.sidebar-head',
    h('a.brand', { href: '/app' },
      h('span.mark', { text: 'E' }),
      h('span', { text: 'EchoPersona' })
    )
  ));

  const nav = h('nav.side-nav');
  if (!hideNav) {
    for (const item of NAV) {
      nav.append(h('a.side-item' + (active === item.key ? '.active' : ''), { href: item.href },
        h('span.ico', svgIcon(item.icon)),
        h('span', { text: item.label })
      ));
    }

    // persona shortcut list
    if (state.personas?.length) {
      nav.append(h('div.side-label', { text: '我的人格' }));
      for (const p of state.personas.slice(0, 8)) {
        nav.append(h('a.side-persona' + (active === `persona:${p.id}` ? '.active' : ''), {
          href: `/app/personas/${p.id}`,
        },
          avatar(p.name, p.avatarUrl, 22),
          h('span.nm', { text: p.name }),
          h('span.dot' + (p.analysisStatus === 'ready' ? '' : '.off'), { title: p.analysisStatus === 'ready' ? '已就绪' : '未完成分析' })
        ));
      }
    }

    /* 「账户」分区不再放「API 配置 / 账户与安全」这两个入口。
     * 它们就是设置页里两个 tab 的重复链接 —— 侧边栏已经有一个「设置」，
     * 点进去就是同样的两件事，等于同一条路给了三个入口。
     * 管理后台是另一种页面（不是设置的一部分），保留。 */
    if (state.user?.isAdmin) {
      nav.append(h('div.side-label', { text: '管理' }));
      nav.append(h('a.side-item' + (active === 'admin' ? '.active' : ''), { href: '/app/admin' },
        h('span.ico', svgIcon('navAdmin')), h('span', { text: '管理后台' })));
    }
  }
  side.append(nav);

  // user chip
  const u = state.user || {};
  const chip = h('button.user-chip', { type: 'button' },
    avatar(u.displayName || u.email, u.avatarPath ? `/api/avatar/${u.avatarPath}` : null, 28),
    h('div.grow', { style: { minWidth: 0 } },
      h('div.nm.truncate', { text: u.displayName || '未命名' }),
      h('div.em.truncate', { text: u.email || '' })
    ),
    h('span.dim', svgIcon('icMore'))
  );
  chip.addEventListener('click', () => openUserMenu(chip));
  side.append(h('div.side-foot', chip));

  // main
  const topbar = h('header.topbar',
    h('button.btn.btn-ghost.btn-icon.menu-btn', {
      type: 'button', 'aria-label': '菜单',
      onclick: () => toggleNav(),
    }, svgIcon('icMenu')),
    h('div.page-title', { text: title || '' }),
    h('div.grow'),
    h('div#topbar-actions.row.gap-8')
  );

  // 抽屉的开合状态收敛到一个函数里。之前是 onclick 直接 toggle class，
  // 结果「背景锁滚动」和「点链接后自动收起」都没地方挂，手机上点完一项
  // 抽屉还杵在那儿，用户得再点一次遮罩才能看到目标页面。
  const scrim = h('div.scrim', { onclick: () => closeNav() });

  function toggleNav() {
    if (side.classList.contains('open')) closeNav();
    else openNav();
  }
  function openNav() {
    side.classList.add('open');
    scrim.classList.add('show');
    document.body.classList.add('nav-open');
  }
  function closeNav() {
    if (!side.classList.contains('open')) return;
    side.classList.remove('open');
    scrim.classList.remove('show');
    document.body.classList.remove('nav-open');
  }

  // 抽屉里的链接点完就收。冒泡阶段统一处理，省得每个 <a> 都挂一遍。
  side.addEventListener('click', (e) => {
    if (e.target.closest?.('a')) closeNav();
  });

  // 转成桌面宽度时抽屉态必须清掉，否则会残留 nav-open 把页面锁死
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeNav();
  });

  const main = h('div.main', topbar,
    h('div.content' + (wide ? '.content-wide' : ''), content)
  );

  return h('div.shell', side, scrim, main);
}

function openUserMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const menu = h('div', {
    style: {
      position: 'fixed', left: `${rect.left}px`, bottom: `${window.innerHeight - rect.top + 6}px`,
      background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '10px',
      boxShadow: 'var(--shadow-3)', padding: '5px', zIndex: '120', minWidth: '186px',
    },
  });
  const item = (label, onclick, danger = false) => h('button', {
    type: 'button',
    style: {
      display: 'block', width: '100%', textAlign: 'left', padding: '8px 11px',
      border: '0', background: 'transparent', borderRadius: '6px', cursor: 'pointer',
      fontFamily: 'var(--sans)', fontSize: '0.87rem',
      color: danger ? 'var(--danger)' : 'var(--ink-2)',
    },
    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--paper-2)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
    onclick: () => { close(); onclick(); },
  }, label);

  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside), 0);

  menu.append(
    item('工作台', () => navigate('/app')),
    item('设置', () => navigate('/app/settings')),
    h('div', { style: { height: '1px', background: 'var(--line-2)', margin: '4px 2px' } }),
    item('退出登录', async () => {
      await api.post('/api/auth/logout').catch(() => {});
      state.user = null;
      state.personas = [];
      navigate('/');
    }, true)
  );
  document.body.append(menu);
}

/** Guard: redirect to login when needed. Returns false if redirected. */
export function requireUser() {
  if (state.loading) return true;
  if (!state.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    navigate(`/login?next=${next}`, { replace: true });
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 聊天界面外观
 *
 * 两套：classic（本站原来的样子）/ wechat（复刻微信）。
 * 用 <html data-ui-theme> 挂在根元素上，CSS 里只靠这一个钩子切换，
 * 不去逐个改内联样式 —— 否则切换时要重渲染整页，还容易漏。
 * 纯外观，不影响任何逻辑，所以放在 shell 这一层统一管。
 * ------------------------------------------------------------------ */
export function applyUiTheme(theme) {
  const t = theme === 'wechat' ? 'wechat' : 'classic';
  document.documentElement.setAttribute('data-ui-theme', t);
  return t;
}

/** 登录后/进聊天页前调一次，把账号上的偏好落到 DOM 上 */
export function syncUiTheme() {
  return applyUiTheme(state.user?.uiTheme);
}

export async function setUiTheme(theme) {
  const t = theme === 'wechat' ? 'wechat' : 'classic';
  applyUiTheme(t);
  if (state.user) state.user.uiTheme = t;
  const r = await api.patch('/api/me', { uiTheme: t }).catch(() => null);
  if (r?.user) state.user = r.user;
  return t;
}

export function setTitle(t) {
  document.title = t ? `${t} · EchoPersona` : 'EchoPersona';
}
