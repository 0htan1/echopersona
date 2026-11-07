/* 启动看门狗（外置脚本，因为 CSP 是 script-src 'self'，内联脚本会被拦掉）。
 *
 * 之前的表现是：JS 一旦在模块加载阶段抛错，#app 里的加载占位符就永远留在那里，
 * 用户看到的是无止境的「正在加载…」，而真正的原因只躺在控制台里。
 * 这里兜住 module 脚本的加载失败与运行期错误，超过 12 秒仍未挂载也给出提示，
 * 让失败可见、可定位，而不是伪装成「还在加载」。 */
(function () {
  var shown = false;

  function fail(msg) {
    if (shown) return;
    shown = true;
    var box = document.getElementById('boot-fallback');
    var pre = document.getElementById('boot-fallback-msg');
    if (!box || !pre) return;
    pre.textContent = String(msg || '未知错误');
    box.hidden = false;
  }

  window.__epBootFail = fail;

  window.addEventListener('error', function (e) {
    // 资源加载失败（如 js 被拦截）不会有 message，只有 target
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      fail('资源加载失败：' + (t.src || t.href));
      return;
    }
    fail((e.message || '脚本错误') + (e.filename ? '\n' + e.filename + ':' + e.lineno : ''));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    fail('异步操作失败：' + ((r && (r.message || r)) || 'unknown'));
  });

  setTimeout(function () {
    // 已成功渲染的页面会清掉占位符；还留着说明启动没跑完
    var app = document.getElementById('app');
    if (app && app.querySelector('#boot-fallback') && !shown) {
      if (!app.querySelector('.shell') && !app.querySelector('.landing') && !app.querySelector('.auth-wrap')) {
        fail('启动超时：页面脚本没有完成初始化，可能是网络或浏览器扩展拦截了请求。');
      }
    }
  }, 12000);
})();
