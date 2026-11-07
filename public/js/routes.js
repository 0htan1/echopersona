/* 路由分发。
 *
 * 这段逻辑放在独立模块里，是为了能被测试直接驱动：
 * 之前它内嵌在 app.js 且只在导入时自启动，测试只能检查「页面函数是否返回节点」，
 * 永远发现不了「返回了节点但没人挂载」——而那正是登录后一直转圈的真正原因。
 */
import { mount, navigate, parseRoute, h } from './core.js';
import { state, loadPersonas, setTitle } from './shell.js';
import { landingPage } from './pages/landing.js';
import {
  loginPage, registerPage, forgotPage, resetPage, phoneLoginPage,
} from './pages/auth.js';
import { dashboardPage, personasPage, newPersonaPage } from './pages/dashboard.js';
import { personaDetailPage, profileEditorPage } from './pages/persona.js';
import { chatPage } from './pages/chat.js';
import { settingsPage, voicePage, adminPage } from './pages/settings.js';

/* 页面骨架。
 *
 * 存在的理由只有一个：点击导航后到数据回来之前，页面原本是一动不动的。
 * 一次导航要串行等 3~5 个接口（会话、人格列表、人格详情……），
 * 每个 40~150ms，加起来就是半秒到一秒的「死机感」。用户会说「不跟手」。
 *
 * 所以先在 60ms 内画出侧边栏和骨块，再让真实内容替换掉它。
 * 60ms 是个刻意的阈值：比这更快的话骨架会闪一下（反而更廉价），
 * 比这更慢的话用户已经感觉到停顿了。 */
function skeleton(active, title) {
  const block = (w, hgt = '14px') => h('div', {
    style: {
      width: w, height: hgt, borderRadius: '7px',
      background: 'linear-gradient(90deg, rgba(0,0,0,0.045), rgba(0,0,0,0.075), rgba(0,0,0,0.045))',
      backgroundSize: '220px 100%',
      animation: 'skShimmer 1.1s ease-in-out infinite',
    },
  });
  return h('div.shell.shell-skeleton',
    h('aside.sidebar',
      h('div.sidebar-head', h('a.brand', { href: '/app' },
        h('span.mark', { text: 'E' }), h('span', { text: 'EchoPersona' }))),
      h('nav.side-nav',
        ...['工作台', '对话', '人格', '语音', '设置'].map((label) => h('div.side-item', {
          'data-active': String(active === label.toLowerCase()),
        }, h('span.ico'), h('span', { text: label }))))
    ),
    h('div.main',
      h('header.topbar', h('div.page-title', { text: title || '' })),
      h('div.content', { style: { paddingTop: '26px' } },
        h('div', { style: { maxWidth: '760px' } },
          block('38%', '26px'),
          h('div', { style: { height: '14px' } }),
          block('64%'),
          h('div', { style: { height: '26px' } }),
          block('100%', '120px'),
          h('div', { style: { height: '16px' } }),
          block('86%', '86px')
        ))
    )
  );
}

/* 渲染序号：每次 render 自增。
 *
 * 快速连点两个导航时，两次 render 会并发跑：先发的那次可能后返回，
 * 于是把用户已经跳走的目标页盖回上一个页面 —— 表现是「点了 A 却看到 B」。
 * 只让最后一次 render 有挂载权，早于它的全部丢弃。 */
let renderSeq = 0;

/* 顶部细进度条：点击后 ~0ms 就出现，用来回答「我这一下点到了吗」。
 * 没有它，用户点完到新页面出来之间是一片完全静止的旧界面，
 * 主观上就是「按钮没反应」。它不假装进度，只是一直往前走，到 90% 停住等结果。 */
function progressStart() {
  let el = document.getElementById('nav-progress');
  if (!el) {
    el = h('div', { id: 'nav-progress' });
    document.body.append(el);
  }
  el.style.transition = 'none';
  el.style.opacity = '1';
  el.style.transform = 'scaleX(0)';
  // 必须让浏览器真的把 scaleX(0) 画出来一帧，再改成 0.85，否则两次赋值
  // 在同一帧内会被合并，条子直接从 0 跳到 0.85 —— 看上去什么都没发生。
  // offsetWidth 在本项目实测不可靠（可能被合并），用两帧 rAF 更稳。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transition = 'transform .5s cubic-bezier(.2,.7,.3,1), opacity .3s';
      el.style.transform = 'scaleX(0.85)';
    });
  });
  return el;
}

function progressDone(el) {
  if (!el) return;
  el.style.transform = 'scaleX(1)';
  el.style.opacity = '0';
  setTimeout(() => { if (el.style.opacity === '0') el.style.transform = 'scaleX(0)'; }, 320);
}

export async function render() {
  const { path, parts } = parseRoute();
  const params = new URLSearchParams(location.search);
  const seq = ++renderSeq;

  // 骨架屏定时器挂在外层，catch 也要能取消它
  let skelTimer = null;
  const clearSkel = () => { if (skelTimer) { clearTimeout(skelTimer); skelTimer = null; } };
  const bar = parts[0] === 'app' || path === '/' ? progressStart() : null;

  try {
    // --- public：这些页面自己在内部 mount，没有返回值
    if (path === '/' || path === '') return landingPage();
    if (path === '/login') return loginPage(params);
    if (path === '/phone-login') return phoneLoginPage(params);
    if (path === '/register') return registerPage();
    if (path === '/forgot-password') return forgotPage();
    if (path === '/reset-password') return resetPage(params);

    // app 区先上骨架：数据回来之前不让页面空着。
    // 用 setTimeout 而不是立即画，是为了让「瞬时完成」的导航（本地缓存命中）
    // 完全不闪骨架 —— 只有真的慢了才出现。
    if (parts[0] === 'app') {
      skelTimer = setTimeout(() => {
        if (!document.querySelector('.shell:not(.shell-skeleton)')) {
          mount(skeleton('', ''));
        }
      }, 60);
    }

    // --- app（各页面对未登录用户自行 guard）
    let node;
    // 是否命中了一条已知的 app 路由。用来区分两件长得一样的事：
    //   • 页面函数内部 requireUser() 把用户送去登录页 → 不该再挂 404
    //   • 路径压根就写错了（/app/personas/xxx 之外的东西） → 必须给 404
    // 早期两种情况都直接 return，于是写错 URL 时页面永久停在
    // index.html 的「正在加载…」占位符上，看起来像卡死。
    let matched = false;
    if (parts[0] === 'app') {
      const seg = parts.slice(1);

      if (seg.length === 0) {
        if (!state.user) return navigate(`/login?next=${encodeURIComponent('/app')}`, { replace: true });
        matched = true;
        node = await dashboardPage();
      } else if (seg[0] === 'personas') {
        matched = true;
        if (seg.length === 1) node = await personasPage();
        else if (seg[1] === 'new') node = await newPersonaPage();
        else if (seg.length === 2) node = await personaDetailPage(seg[1]);
        else if (seg[2] === 'profile') node = await profileEditorPage(seg[1]);
        else node = await personaDetailPage(seg[1], seg[2]);
      } else if (seg[0] === 'chat') {
        matched = true;
        if (seg.length === 1) {
          await loadPersonas();
          clearSkel();
          if (state.personas.length) return navigate(`/app/chat/${state.personas[0].id}`, { replace: true });
          return navigate('/app/personas/new', { replace: true });
        }
        node = await chatPage(seg[1], seg[2] || null);
      } else if (seg[0] === 'voice') {
        matched = true;
        node = await voicePage();
      } else if (seg[0] === 'admin') {
        matched = true;
        node = await adminPage(seg[1]);
      } else if (seg[0] === 'settings') {
        matched = true;
        node = await settingsPage(seg[1] === 'account' ? 'account' : 'keys');
      }
    }

    // 真实内容要挂载了，先把骨架的定时器取消掉 ——
    // 否则它在 60ms 后会把刚挂好的页面整个替换成骨块（比不显示骨架还糟）。
    clearSkel();

    // 过期的渲染不许挂载：用户已经跳到别处了，这次结果属于上一个页面。
    if (seq !== renderSeq) { progressDone(bar); return; }

    // 页面函数返回节点，必须在这里统一挂载。
    // 早期版本把返回值直接丢掉，导致 /app 永远停在 index.html 的加载占位符上，
    // 而请求其实全都成功了——表现就是「登录/注册后一直转圈」。
    if (node) { progressDone(bar); return mount(node); }

    // app 路由命中但没有节点 = 页面里的 requireUser() 已把用户送去登录页，
    // 这里不要再覆盖成 404。
    if (parts[0] === 'app' && matched) { progressDone(bar); return; }

    // 404
    // 登录后写错 URL 时给「回工作台」而不是「回首页」——首页是营销页，
    // 对已登录用户等于把自己踢出去。
    progressDone(bar);
    const loggedIn = !!state.user;
    setTitle('未找到');
    mount(h('div', { style: { padding: '80px 24px', textAlign: 'center' } },
      h('h1', { text: '404' }),
      h('p.muted', { text: '这个地址不存在。' }),
      h('a.btn.btn-primary', { href: loggedIn ? '/app' : '/' }, loggedIn ? '回到工作台' : '回到首页')
    ));
  } catch (e) {
    clearSkel();
    progressDone(bar);
    console.error(e);
    // 把错误摘要带进标题，生产环境排障时一眼能看到
    try { document.title = 'ERR: ' + String((e && e.message) || e).slice(0, 140); } catch { /* ignore */ }
    mount(h('div', {
      style: {
        padding: '70px 24px', textAlign: 'center', maxWidth: '520px', margin: '0 auto',
      },
    },
      h('h2', { style: { marginBottom: '10px' }, text: '页面加载失败' }),
      h('p.small.muted', { id: 'boot-error', style: { marginBottom: '18px' }, text: e.message || '未知错误' }),
      h('div.row.gap-8', { style: { justifyContent: 'center' } },
        h('button.btn', { type: 'button', onclick: () => location.reload() }, '重试'),
        h('a.btn.btn-primary', { href: '/app' }, '回工作台')
      )
    ));
  }
}

// 清掉对话页对顶层布局的临时改写
export function resetOverrides() {
  const contentEl = document.querySelector('.content');
  if (contentEl) {
    contentEl.style.padding = '';
    contentEl.style.maxWidth = '';
  }
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.style.display = '';
}
