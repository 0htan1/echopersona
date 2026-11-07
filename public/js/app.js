/* 应用入口：只负责启动，路由分发在 routes.js（便于测试）。 */
import { navigate } from './core.js';
import { loadSession, loadPersonas, state } from './shell.js';
import { render, resetOverrides } from './routes.js';

async function boot() {
  await loadSession();
  if (state.user) await loadPersonas();

  window.addEventListener('popstate', async () => {
    resetOverrides();
    await render();
  });

  // 拦截站内链接，走 SPA 跳转
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || a.hasAttribute('download')
      || a.getAttribute('target')) return;
    if (a.dataset.noSpa !== undefined) return;
    e.preventDefault();
    resetOverrides();
    navigate(href);
  });

  await render();
}

boot();
