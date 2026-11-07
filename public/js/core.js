/* --- 内联 SVG 图标 ---
   createElement 建不出 SVG 命名空间里的元素（会得到一个 HTMLUnknownElement，
   图形一律不渲染），所以这里必须用 createElementNS。
   同理，属性也要用 setAttribute 而不是 el.foo。

   注意：图标必须**按需创建**，不能在模块顶层就建好。
   core.js 在无 DOM 的环境里也会被 import（测试、SSR 探测），
   顶层调用 document.createElementNS 会直接 ReferenceError。 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_BUILDERS = {
  // 微信语音气泡里的喇叭：一个喇叭本体 + 两道播放波纹
  voiceSpeaker(svg) {
    const path = (d, cls) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      if (cls) p.setAttribute('class', cls);
      svg.append(p);
    };
    path('M4 9.5v5h3.2L12 18V6L7.2 9.5H4z');
    path('M15 9.2a4 4 0 0 1 0 5.6', 'arc arc-2');
    path('M17.6 6.8a7.5 7.5 0 0 1 0 10.4', 'arc arc-3');
  },
  // 微信登录按钮上的对话气泡（微信品牌的绿色由 CSS 给，图形本身不带色）
  wechatBubble(svg) {
    const path = (d, opts = {}) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      if (opts.fill) p.setAttribute('fill', opts.fill);
      if (opts.cls) p.setAttribute('class', opts.cls);
      svg.append(p);
    };
    // 大气泡
    path('M9.2 3C5.2 3 2 5.8 2 9.2c0 1.9 1 3.6 2.7 4.7L4 16.4l2.7-1.4c.8.2 1.6.3 2.5.3h.4a5.5 5.5 0 0 1-.2-1.5c0-3.3 3-5.9 6.7-5.9h.5C16.1 5.1 13 3 9.2 3z');
    // 小气泡
    path('M22 13.8c0-2.8-2.6-5-5.9-5s-5.9 2.2-5.9 5 2.6 5 5.9 5c.7 0 1.4-.1 2-.3l2.2 1.2-.7-2c1.5-.9 2.4-2.5 2.4-4.6z', { cls: 'sub' });
  },
  // 手机验证码：一个手机轮廓 + 一道虚线信号
  phoneCode(svg) {
    const mk = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    };
    mk('rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 3, class: 'phone-body' });
    mk('path', { d: 'M10.2 5.6h3.6', class: 'phone-notch' });
    mk('path', { d: 'M9.6 10.2h4.8M9.6 13.4h4.8M9.6 16.6h2.8', class: 'phone-lines' });
  },

  /* ---- 落地页功能区图标 ----
     之前用 ◈ ❋ ◐ ♪ ⚿ ⊘ 这些字符当图标。问题有两个：
     一是字体缺字时会显示成方框或豆腐块，二是这些字符本身没有明确语义，
     读者第一眼认不出「这代表语言指纹」。这里全部改成描边图标，
     统一 1.6 线宽、圆角端点，跟产品细字重的调性一致。 */
  icFingerprint(svg) {
    const p = (d, cls) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', cls || 'ic-line');
      svg.append(el);
    };
    p('M12 4.4c-4.2 0-7.6 3.4-7.6 7.6');
    p('M19.6 12c0 3-1.1 5.7-2.9 7.8');
    p('M6.6 18.6A9.4 9.4 0 0 1 4.4 12');
    p('M12 7.8A4.2 4.2 0 0 0 7.8 12c0 2-.4 3.9-1.1 5.6');
    p('M16.2 12A4.2 4.2 0 0 0 12 7.8');
    p('M12 11.2c.5 0 .8.4.8.9 0 2.6-.4 5-1.2 7.2');
    p('M16.2 12c0 3.6-.8 6.6-2.2 9');
    p('M12 4.4c4.2 0 7.6 3.4 7.6 7.6');
  },
  icLayers(svg) {
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M12 3.6 20.4 8 12 12.4 3.6 8 12 3.6z');
    p('M3.6 12.4 12 16.8l8.4-4.4');
    p('M3.6 16.6 12 21l8.4-4.4');
  },
  icMemory(svg) {
    const mk = (tag, a, cls) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
      el.setAttribute('class', cls || 'ic-line');
      svg.append(el);
    };
    const p = (d, cls) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', cls || 'ic-line');
      svg.append(el);
    };
    // 「记忆网络」：三个节点用虚线连起来，其中一个被检索到（实心）。
    // 比放大镜更贴切——要表达的是「从一堆记忆里召回相关的几条」。
    mk('circle', { cx: 7.4, cy: 8, r: 2.6 });
    mk('circle', { cx: 17.2, cy: 6.4, r: 2 });
    mk('circle', { cx: 15.4, cy: 17, r: 2.6 });
    mk('circle', { cx: 6.6, cy: 17.4, r: 1.8 });
    p('M9.8 8.6 15.4 7', 'ic-line dashed');
    p('M17.6 8.4 16.2 14.5', 'ic-line dashed');
    p('M12.9 17.2 9.2 17.3', 'ic-line dashed');
    mk('circle', { cx: 15.4, cy: 17, r: 4.6, 'stroke-width': '1.2', 'stroke-opacity': '0.55' });
  },
  icWave(svg) {
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M4 12h1.6M8 6.5v11M12 9v6M16 5v14M20 10.5v3');
  },
  // 钥匙：环形握把 + 斜杆 + 两枚齿。之前那版握把和杆没分开，看着像口哨。
  icKey(svg) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', 8); circle.setAttribute('cy', 8); circle.setAttribute('r', 4.4);
    circle.setAttribute('class', 'ic-line');
    svg.append(circle);
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M11.1 11.1 20 20');
    p('M16.4 16.4l-2 2');
    p('M18.6 18.6l-2 2');
  },
  icQuestion(svg) {
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z');
    p('M9.7 9.6a2.4 2.4 0 1 1 3.2 2.3c-.6.3-.9.8-.9 1.4v.5');
    p('M12 16.9h.01');
  },

  /* ---- 侧边栏 / 顶栏图标 ----
     同一个道理：以前侧边栏用的是 ◈ ❋ ◐ ♪ ⚙ ⚿ ☺ ⌗ 这些字符。
     它们在 macOS 上靠系统字体还能看，到 Windows 就变成又细又糊的一坨，
     而「♪」「☺」这种字符还容易被用户当成 emoji 渲染成彩色方块，
     跟界面完全不是一套视觉语言。全部换成 1.55 描边的线性图标。 */
  navDashboard(svg) {
    const r = (x, y) => {
      const el = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of Object.entries({ x, y, width: 7.2, height: 7.2, rx: 2.1 })) {
        el.setAttribute(k, v);
      }
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    r(3.4, 3.4); r(13.4, 3.4); r(3.4, 13.4); r(13.4, 13.4);
  },
  navChat(svg) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M12 3.8c-4.8 0-8.6 3.3-8.6 7.4 0 2.4 1.3 4.5 3.3 5.8l-1 3.2 3.6-1.7c.9.2 1.8.3 2.7.3 4.8 0 8.6-3.3 8.6-7.6S16.8 3.8 12 3.8z');
    p.setAttribute('class', 'ic-line');
    svg.append(p);
  },
  navPersona(svg) {
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M12 4.2a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8z');
    p('M4.9 20.1c0-3.6 3.2-6.3 7.1-6.3s7.1 2.7 7.1 6.3');
  },
  // 麦克风：语音页和语音设置都指「说话的设备」，比音符 ♪ 更准确
  navVoice(svg) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: 8.8, y: 2.8, width: 6.4, height: 10.4, rx: 3.2 })) {
      rect.setAttribute(k, v);
    }
    rect.setAttribute('class', 'ic-line');
    svg.append(rect);
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M5.6 11.4v1.2a6.4 6.4 0 0 0 12.8 0v-1.2');
    p('M12 19.2v2.2');
  },
  // 设置用「推子」而不是齿轮：齿轮那 8 个齿在 16px 下会糊成一团
  navSettings(svg) {
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    const c = (cx, cy) => {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', 2.5);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M4 8.2h1.6M11 8.2h9M4 15.8h8.6M17.4 15.8h2.6');
    c(8.3, 8.2); c(15, 15.8);
  },
  navAccount(svg) {
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M12 3.5 19 6.1v5.3c0 4.1-2.9 7.2-7 8.5-4.1-1.3-7-4.4-7-8.5V6.1z');
    p('M9.2 11.7l2 2 3.6-3.9');
  },
  // 管理后台：一个带顶栏和侧栏的「面板」轮廓
  navAdmin(svg) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: 3.3, y: 4.4, width: 17.4, height: 15.2, rx: 2.6 })) {
      rect.setAttribute(k, v);
    }
    rect.setAttribute('class', 'ic-line');
    svg.append(rect);
    const p = (d) => {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'ic-line');
      svg.append(el);
    };
    p('M3.3 9.3h17.4M9.4 9.3v10.3');
  },
  icMenu(svg) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M4 7.2h16M4 12h16M4 16.8h16');
    p.setAttribute('class', 'ic-line');
    svg.append(p);
  },
  icClose(svg) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6');
    p.setAttribute('class', 'ic-line');
    svg.append(p);
  },
  icMore(svg) {
    for (const cx of [6.2, 12, 17.8]) {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', cx); el.setAttribute('cy', 12); el.setAttribute('r', 1.45);
      el.setAttribute('class', 'ic-dot');
      svg.append(el);
    }
  },
  // 「召回了什么」用的星芒：和 .recall-chip 的绿色搭配，暗示「捞出来几条」
  icSpark(svg) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M12 3.4l1.9 5.2 5.2 1.9-5.2 1.9L12 17.6l-1.9-5.2L4.9 10.5l5.2-1.9z');
    p.setAttribute('class', 'ic-line');
    svg.append(p);
  },
};

/* ==================================================================
 * 空状态插画
 *
 * 手上没有可用的图片素材（也不想引入来源不明的图），所以用手绘感的
 * 内联 SVG：体积几百字节、无网络请求、跟随主题色。比一个 26px 的
 * 「❋」字符更能让人知道「这里本来应该有什么」。
 *
 * 刻意画得「不干净」：线条略带抖动、笔画粗细不一、有溢出和重复描绘。
 * 规整的几何图形会立刻显出机器味，微小的不规则才像人画的。
 * ================================================================== */
const EMPTY_ART = {
  /** 还没有人格：一个还空着的人像相框 + 一句冒出来的话
   *
   * 为什么用相框而不是两个气泡：
   * 产品做的是「把一个人的说话方式留下来」，空状态的语义是
   * 「这里有一个人的位置，还没被放进来」。虚线人像剪影是大家一眼就懂的
   * 「还没有头像」约定，不会被当成加载占位符；气泡只作为点缀，
   * 暗示这个位置是用来对话的。
   */
  noPersona(svg) {
    const mk = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    // 相框（略微倾斜，避免像 UI 组件）
    mk('g', { transform: 'rotate(-2.2 60 58)' });
    const g = svg.lastChild;
    const add = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      g.append(el);
      return el;
    };
    add('rect', { x: 24, y: 12, width: 70, height: 80, rx: 7, class: 'art-frame' });
    add('rect', { x: 30, y: 18, width: 58, height: 58, rx: 4, class: 'art-frame-inner' });
    // 人像剪影：头 + 肩，撑满取景框上中部。
    // 虚线是「还没有人」的通用画法，一眼能懂，不像加载占位符。
    add('circle', { cx: 59, cy: 37, r: 12, class: 'art-ghost' });
    add('path', { d: 'M39.5 76c0-11.8 8.7-19 19.5-19s19.5 7.2 19.5 19', class: 'art-ghost' });
    // 相框下沿的「手写备注」——一条写了一半的线
    add('path', { d: 'M37 84h30', class: 'art-stroke thin' });
    add('path', { d: 'M72 84h9', class: 'art-stroke thin dashed' });

    // 冒出来的对话气泡（压在相框右下角，制造前后层次）
    mk('path', {
      d: 'M74 58h28a8.5 8.5 0 0 1 8.5 8.5v12a8.5 8.5 0 0 1-8.5 8.5h-15.5l-8.5 7.5 1.8-7.5h-5.8a8.5 8.5 0 0 1-8.5-8.5v-12A8.5 8.5 0 0 1 74 58z',
      class: 'art-bubble',
    });
    for (const cx of [80, 88, 96]) mk('circle', { cx, cy: 72.5, r: 2.2, class: 'art-dot' });
  },

  /** 还没有导入记录：一份被翻开的聊天记录 */
  noImport(svg) {
    const mk = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    mk('rect', { x: 24, y: 14, width: 52, height: 66, rx: 4, class: 'art-ghost' });
    mk('rect', { x: 30, y: 20, width: 52, height: 66, rx: 4, class: 'art-line' });
    // 记录里的「一行行对话」：左右交错，像真实的聊天界面
    const rows = [
      [36, 44, 22, 'l'], [42, 50, 18, 'r'], [36, 56, 26, 'l'],
      [40, 62, 20, 'r'], [36, 68, 24, 'l'], [38, 74, 14, 'l'],
    ];
    for (const [x, y, w] of rows) mk('rect', { x, y, width: w, height: 4.4, rx: 2.2, class: 'art-line-soft' });
    // 一个还没被填上的空位
    mk('rect', { x: 62, y: 74, width: 14, height: 4.4, rx: 2.2, class: 'art-dash' });
  },

  /** 还没有对话：一条空着的对话流 */
  noChat(svg) {
    const mk = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    mk('path', {
      d: 'M22 34c0-8 6.6-14.4 14.8-14.4h30.4C75.4 19.6 82 26 82 34v18c0 8-6.6 14.4-14.8 14.4H46.5L34 76l2.2-9.6C27.6 63.4 22 56.4 22 48.6z',
      class: 'art-line',
    });
    mk('path', { d: 'M36 41h32M36 49h24M36 57h16', class: 'art-stroke thin' });
    mk('path', { d: 'M62 64c5-1 8.6 1 10.6 4', class: 'art-stroke thin dashed' });
  },
};

/** 取一张空状态插画。无 DOM 环境返回 null（h() 会跳过）。 */
export function emptyArt(name, { size = 132 } = {}) {
  const build = EMPTY_ART[name];
  if (!build || typeof document === 'undefined') return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 112 104');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(Math.round(size * 104 / 112)));
  svg.setAttribute('class', `empty-art empty-art-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  build(svg);
  return svg;
}

/** 拿一个图标的**独立副本**（同一节点只能挂在一处，所以每次新建） */
export function svgIcon(name) {
  const build = ICON_BUILDERS[name];
  // h() 会跳过 null 子节点，所以无 DOM 环境返回 null 是安全的
  if (!build || typeof document === 'undefined') return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', name === 'voiceSpeaker' ? 'voice-spk' : `ico-svg ico-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  build(svg);
  return svg;
}



export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.cls', {attrs}, ...children)
 *  第二个参数既可以是属性对象，也可以直接是子节点（或子节点数组）。
 *  早期版本把数组当成属性对象处理，导致 '0' is not a valid attribute name。 */
/**
 * 建元素。语法：`h('div.foo.bar#someId', attrs, ...children)`
 *
 * 标签名后面可以跟 `.class` 和 `#id`，顺序随意（跟 CSS 选择器写法一致）。
 *
 * 注意 `#id` 必须在这里解析掉：以前只按 '.' 拆，`h('div#x')` 会把
 * `div#x` 整个当成标签名交给 document.createElement，而标签名不允许
 * 含 # —— 浏览器直接抛 `Failed to execute 'createElement' on
 * 'Document': The tag name provided ('div#x') is not a valid name`。
 * 这个错误在建 app 外壳时就发生，表现是"登录后整页加载失败"。
 */
export function h(tag, attrs = {}, ...children) {
  const raw = String(tag);
  // 先切出 id（# 之后到下一个 . 或结尾），剩下的再按 . 拆 class
  let rest = raw;
  let id = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const tail = rest.slice(hash + 1);
    const dot = tail.indexOf('.');
    id = dot >= 0 ? tail.slice(0, dot) : tail;
    rest = rest.slice(0, hash) + (dot >= 0 ? tail.slice(dot) : '');
  }
  const [name, ...classes] = rest.split('.');
  const el = document.createElement(name || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');

  // 允许 h('div', child) / h('div', [a, b]) 这种写法
  const isAttrs = attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)
    && !(attrs instanceof Node);
  const allChildren = isAttrs ? children : [attrs, ...children];

  for (const [k, v] of Object.entries(isAttrs ? attrs : {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of allChildren.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function mount(node) {
  const root = $('#app');
  root.replaceChildren(node);
  window.scrollTo(0, 0);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
    this.code = body?.code;
  }
}

async function handle(res) {
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    let body = {};
    if (ct.includes('application/json')) {
      try { body = await res.json(); } catch { /* ignore */ }
    } else {
      const t = await res.text().catch(() => '');
      body = { error: t.slice(0, 200) };
    }
    if (res.status === 401 && !body.code) {
      body.code = 'UNAUTHENTICATED';
    }
    throw new ApiError(body.error || `请求失败（${res.status}）`, res.status, body);
  }
  if (res.status === 204) return null;
  if (ct.includes('application/json')) return res.json();
  return res;
}

export const api = {
  async get(path, params) {
    const url = params ? `${path}?${new URLSearchParams(clean(params))}` : path;
    return handle(await fetch(url, { credentials: 'same-origin' }));
  },
  async post(path, body) {
    // 没有请求体时绝不能带 content-type: application/json。
    // Fastify 见到这个头会按 JSON 解析，空 body 直接 400
    // FST_ERR_CTP_EMPTY_JSON_BODY，前端只能显示成「请求错误」。
    // 这就是「运行人格分析一点就报错」的真正原因 —— 那个接口不需要入参。
    const hasBody = body !== undefined && body !== null;
    return handle(await fetch(path, {
      method: 'POST',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      credentials: 'same-origin',
      body: hasBody ? JSON.stringify(body) : undefined,
    }));
  },
  async patch(path, body) {
    return handle(await fetch(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }));
  },
  async del(path) {
    return handle(await fetch(path, { method: 'DELETE', credentials: 'same-origin' }));
  },
  async form(path, formData, { onProgress } = {}) {
    if (!onProgress) {
      return handle(await fetch(path, { method: 'POST', body: formData, credentials: 'same-origin' }));
    }
    // XHR so we can report upload progress
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total, e.loaded, e.total);
      };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { body = { error: xhr.responseText.slice(0, 200) }; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(body.error || `上传失败（${xhr.status}）`, xhr.status, body));
      };
      xhr.onerror = () => reject(new ApiError('网络错误，上传失败', 0, {}));
      xhr.send(formData);
    });
  },
};

function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/* ------------------------------------------------------------------ *
 * Markdown (safe, minimal: bold/italic/code/links/lists/headings)
 * ------------------------------------------------------------------ */
export function md(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let listBuf = [];

  const flushList = () => {
    if (!listType) return;
    out.push(`<${listType}>${listBuf.map((x) => `<li>${x}</li>`).join('')}</${listType}>`);
    listType = null; listBuf = [];
  };

  const inline = (s) => {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
    return t;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = []; inCode = false;
      } else { flushList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (!line.trim()) { flushList(); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType && listType !== want) flushList();
      listType = want;
      listBuf.push(inline((ul || ol)[1]));
      continue;
    }
    flushList();

    const hd = line.match(/^(#{1,4})\s+(.*)$/);
    if (hd) { out.push(`<h${hd[1].length + 2}>${inline(hd[2])}</h${hd[1].length + 2}>`); continue; }

    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }

    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  flushList();
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * formatting helpers
 * ------------------------------------------------------------------ */
export function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hh}:${mm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 2592000000) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtDate(ts);
}

export function initials(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  // CJK: take last 1-2 chars; latin: initials
  if (/[\u4e00-\u9fff]/.test(s)) return s.slice(-2);
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------------ *
 * toast
 * ------------------------------------------------------------------ */
let toastHost = null;
export function toast(msg, kind = '') {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.append(toastHost);
  }
  const el = h('div.toast' + (kind ? `.${kind}` : ''), { text: msg });
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, kind === 'err' ? 4200 : 2400);
}

/* ------------------------------------------------------------------ *
 * modal
 * ------------------------------------------------------------------ */
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const scrim = h('div.modal-scrim');
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const foot = h('div.modal-foot');
  for (const a of actions) {
    foot.append(h('button.btn' + (a.kind ? `.btn-${a.kind}` : ''), {
      type: 'button',
      onclick: async (e) => {
        if (a.onClick) {
          const keep = await a.onClick(e, close);
          if (keep === false) return;
        }
        close();
      },
    }, a.label));
  }

  const m = h('div.modal' + (wide ? '.wide' : ''),
    { role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head',
      h('h3', { text: title }),
      h('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', onclick: close, 'aria-label': '关闭' }, '✕')
    ),
    h('div.modal-body', typeof body === 'string' ? h('div', { html: body }) : body),
    actions.length ? foot : null
  );
  scrim.append(m);
  document.body.append(scrim);
  setTimeout(() => {
    const focusable = m.querySelector('input, textarea, select, button:not([aria-label="关闭"])');
    focusable?.focus();
  }, 30);
  return { close, el: m };
}

export function confirmDialog({ title, message, confirmLabel = '确认', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const { close } = modal({
      title,
      body: h('p.small', { style: { color: 'var(--ink-2)', lineHeight: '1.65' }, text: message }),
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => { done = true; resolve(false); } },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => { done = true; resolve(true); },
        },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/* ------------------------------------------------------------------ *
 * avatar element
 * ------------------------------------------------------------------ */
export function avatar(name, url, size = 40, square = false) {
  const el = h(`div.av.av-${size}` + (square ? '.av-sq' : ''));
  if (url) {
    const img = h('img', { src: url, alt: name || '', loading: 'lazy' });
    img.addEventListener('error', () => {
      img.remove();
      el.textContent = initials(name);
    });
    el.append(img);
  } else {
    el.textContent = initials(name);
  }
  return el;
}

/* ------------------------------------------------------------------ *
 * route helpers
 * ------------------------------------------------------------------ */

/**
 * 需要在整个会话期间保留的查询参数。
 *
 * 托管平台的网关用 `sharecode` 放行访问：带它访问一次会下发 `__wb_rsc` cookie，
 * 但该 cookie 在部分环境（如内置预览、第三方浏览器）里并不生效，
 * 于是网关只能每次都看 URL 上的参数。SPA 跳转若把它丢掉，
 * 后续所有请求都会被拦成 403 —— 表现就是登录/注册后一直停在「加载中」。
 * 所以这里在每次 pushState 时把这类参数原样带上。
 */
const STICKY_PARAMS = ['sharecode'];

export function navigate(path, { replace = false } = {}) {
  let target = path;
  try {
    const url = new URL(path, location.origin);
    const current = new URLSearchParams(location.search);
    for (const key of STICKY_PARAMS) {
      if (!url.searchParams.has(key) && current.has(key)) {
        url.searchParams.set(key, current.get(key));
      }
    }
    target = url.pathname + url.search + url.hash;
  } catch { /* 非法 URL 就按原样跳 */ }

  if (replace) history.replaceState({}, '', target);
  else history.pushState({}, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function parseRoute() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const parts = p.split('/').filter(Boolean);
  return { path: p, parts };
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
