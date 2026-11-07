import {
  h, api, toast, avatar, navigate, fmtTime, md, esc, modal, confirmDialog, debounce, svgIcon, emptyArt,
} from '../core.js';
import { state, shell, setTitle, requireUser, loadPersonas } from '../shell.js';

export async function chatPage(personaId, chatId = null) {
  if (!requireUser()) return;
  setTitle('对话');

  let personaData;
  try {
    personaData = await api.get(`/api/personas/${personaId}`);
  } catch {
    return shell({
      active: 'chat', title: '对话',
      content: h('div.empty', h('h3', { text: '找不到这个人格' }), h('a.btn', { href: '/app' }, '返回工作台')),
    });
  }
  const p = personaData.persona;
  await loadPersonas();

  const llms = await api.get('/api/llm-configs').then((r) => r.configs).catch(() => []);

  if (!llms.length) {
    return shell({
      active: `persona:${personaId}`, title: p.name,
      content: h('div.empty.empty-rich',
        emptyArt('noChat'),
        h('h3', { text: '还差一个模型来源' }),
        h('p', { text: '填一个你自己的 OpenAI 兼容 API Key 就能开始对话。Key 只保存在服务端，不会下发给浏览器。' }),
        h('div.row.gap-8', { style: { justifyContent: 'center' } },
          h('a.btn.btn-copper', { href: '/app/settings/keys' }, '去配置'),
        )
      ),
    });
  }

  let chats = (await api.get(`/api/personas/${personaId}/chats`).catch(() => ({ chats: [] }))).chats;
  let currentChatId = chatId || chats[0]?.id || null;
  let messages = [];
  if (currentChatId) {
    const r = await api.get(`/api/chats/${currentChatId}/messages`).catch(() => ({ messages: [] }));
    messages = r.messages;
  }

  /* ---------------------------------------------------------- state */
  let streaming = false;
  let abortCtl = null;
  /* 输出形态：text 只发文字 / voice 只发语音。
   *
   * 以前还有第三档「随机」—— 按 TA 历史里语音占比掷骰子。实测下来
   * 绝大多数人导入的记录里语音占比都很低，掷出来的几乎永远是文字，
   * 用户选了「随机」却从没收到过语音，只会认为开关坏了。删掉这一档，
   * 让用户自己选，行为可预测。
   *
   * 老数据里可能存着 'mixed'：这里显式落回 'text'，否则两个按钮
   * 都不高亮，看起来像设置丢了。 */
  let voiceMode = p.voiceMode === 'voice' ? 'voice' : 'text';
  let mode = p.similarityMode || 'natural';

  /* ------------------------------------------------------------ rail */
  const rail = h('aside.chat-rail', { id: 'chat-rail' });
  const railHead = h('div.rail-head');
  const railPersona = h('button.rail-persona', {
    type: 'button',
    onclick: () => openPersonaPicker(),
  },
    avatar(p.name, p.avatarUrl, 34),
    h('div.meta',
      h('div.nm.truncate', { text: p.name }),
      h('div.rl.truncate', { text: p.relationship || '在线' })
    ),
    h('span.dim', { text: '⇅' })
  );
  railHead.append(railPersona);
  rail.append(railHead);

  const newChatBtn = h('button.btn.btn-sm.w-full', {
    type: 'button',
    onclick: () => {
      currentChatId = null;
      messages = [];
      renderThread();
      refreshRail();
      /* 手机上 rail 是全屏浮层（position:fixed; inset:0; z-index:60）。
       * 不收起它的话，「新对话」只把后面的内容清了，用户眼前还是那张
       * 会话列表 —— 表现就是「点了新对话没反应」。所以必须先关抽屉，
       * 让空白的对话页真的露出来，再把焦点给输入框（宽屏才聚焦，
       * 手机上抢焦点会直接把软键盘弹起来）。 */
      closeRail();
      if (!isNarrow()) composerInput.focus();
    },
    style: { marginTop: '8px' },
  }, '＋ 新对话');
  railHead.append(newChatBtn);

  const railList = h('div.rail-list');
  rail.append(railList);

  // 手机上 rail 是全屏抽屉，没有这个按钮用户只能靠浏览器返回键出去
  const railCloseBtn = h('button.btn.btn-ghost.btn-sm.rail-close', {
    type: 'button',
    onclick: () => closeRail(),
  }, '✕ 收起');
  railHead.prepend(railCloseBtn);

  /* 对话页把全局顶栏藏了，手机上就没有任何回到工作台的入口。
     在抽屉底部补一组导航，只在窄屏显示（.rail-nav 默认 display:none）。 */
  const railNav = h('div.rail-nav',
    h('a.side-item', { href: '/app' }, h('span.ico', svgIcon('navDashboard')), h('span', { text: '工作台' })),
    h('a.side-item', { href: `/app/personas/${personaId}` }, h('span.ico', svgIcon('navPersona')), h('span', { text: '人格档案' })),
    h('a.side-item', { href: '/app/settings' }, h('span.ico', svgIcon('navSettings')), h('span', { text: '设置' })),
  );
  rail.append(railNav);

  /**
   * 删掉整个对话。
   *
   * 以前只能一条条删消息，聊了半个月想清空得点几十次；用户要的是
   * 「这个对话不要了」。后端 DELETE /api/chats/:id 早就有了（会话本身
   * 和它的消息一起删），一直缺的只是入口。
   *
   * 这里必须二次确认并说清后果：删的是整段对话，不是一条消息，
   * 而且不可恢复。确认框里带上条数，用户才知道自己在删掉什么。
   */
  async function deleteChat(c) {
    const n = Number(c.msgCount) || 0;
    const ok = await confirmDialog({
      title: '删除整个对话',
      message: `「${c.title}」${n ? `里的 ${n} 条消息` : ''}会被一起删除，无法恢复。`,
      confirmLabel: '删除对话',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/chats/${c.id}`);
    } catch (e) {
      toast(e.message || '删除失败', 'err');
      return;
    }
    // 删的正好是当前打开的那个：清空消息区，回到"可以开始新对话"的状态
    if (c.id === currentChatId) {
      currentChatId = null;
      messages = [];
      renderThread();
    }
    await refreshRail();
    toast('对话已删除', 'ok');
  }

  const refreshRail = async () => {
    chats = (await api.get(`/api/personas/${personaId}/chats`).catch(() => ({ chats: [] }))).chats;
    railList.replaceChildren();
    if (!chats.length) {
      railList.append(h('div.tiny.dim', { style: { padding: '16px 10px', textAlign: 'center' }, text: '还没有对话' }));
      return;
    }
    railList.append(h('div.rail-group-label', { text: '最近对话' }));
    for (const c of chats) {
      /* 删除按钮不能塞进 .rail-chat 里面 —— 那是 <button>，
       * 里面再放一个 <button> 是非法 HTML，浏览器会把它挤到外面去，
       * 点起来还会连带触发"切换会话"。所以外面包一层定位容器。 */
      railList.append(h('div.rail-chat-wrap',
        h('button.rail-chat' + (c.id === currentChatId ? '.active' : ''), {
          type: 'button',
          onclick: async () => {
            currentChatId = c.id;
            const r = await api.get(`/api/chats/${c.id}/messages`);
            messages = r.messages;
            renderThread();
            refreshRail();
          },
        },
          h('div.t.truncate', { text: c.title }),
          h('div.p.truncate', { text: c.lastText || `${c.msgCount} 条消息` })
        ),
        h('button.rail-chat-del', {
          type: 'button',
          title: '删除整个对话',
          'aria-label': `删除对话「${c.title}」`,
          onclick: (e) => { e.stopPropagation(); deleteChat(c); },
        }, '✕')
      ));
    }
  };
  await refreshRail();

  /* ----------------------------------------------------------- head */
  const headSub = h('div.sb',
    h('span', { text: personaData.profile ? (p.relationship || '在线') : '尚未分析' }),
    h('span', { style: { color: 'var(--line)' }, text: '·' }),
    h('span', { text: `${p.importedMessages.toLocaleString()} 条记录` })
  );

  /* 「TA 怎么回你」：只发文字 / 只发语音。
     这不是"文字转语音"的开关 —— 它决定的是这条消息到底是打字还是开口说话，
     所以放在顶栏，和模仿强度并列，而不是藏在设置里。
     语音是否真的可用由服务端判定（没有 TTS 配置时自动退回文字），
     这里不再多拉一次 tts 列表 —— 少一次请求就是少一次首屏等待。 */
  const voiceModePick = h('div.mode-pick.voice-mode-pick', { title: '回复形态' },
    ...[
      ['text', '文字'],
      ['voice', '语音'],
    ].map(([k, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(voiceMode === k),
        onclick: async (e) => {
          voiceMode = k;
          for (const b of voiceModePick.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', 'true');
          // 记到人格上，下次进来还是这个设置
          api.patch(`/api/personas/${personaId}`, { voiceMode: k }).catch(() => {});
          if (k === 'voice') toast('之后每条回复都会直接发语音');
        },
      }, label))
  );

  const head = h('header.chat-head',
    // 这个按钮在宽屏隐藏、窄屏显示。对话页会把全局顶栏藏掉以便聊天区占满屏幕，
    // 所以手机上它同时也是「打开人格/设置菜单」的唯一入口 —— 少了它，
    // 移动端用户进了对话就再也回不到工作台。
    h('button.btn.btn-ghost.btn-icon', {
      type: 'button', 'aria-label': '打开菜单', id: 'rail-toggle',
      onclick: () => toggleRail(),
    }, svgIcon('icMenu')),
    avatar(p.name, p.avatarUrl, 34),
    h('div.who.grow',
      h('div.nm', { text: p.name }),
      headSub
    ),
    h('span.tiny.dim.hide-narrow', { text: '回复' }),
    voiceModePick,
    h('a.btn.btn-ghost.btn-icon', { href: `/app/personas/${personaId}`, 'aria-label': '人格设置' }, svgIcon('navSettings'))
  );

  /* --------------------------------------------------------- thread */
  const scroll = h('div.chat-scroll', { id: 'chat-scroll' });
  const flow = h('div.msg-flow');
  scroll.append(flow);

  const composerInput = h('textarea', {
    placeholder: `给 ${p.name} 发消息…`,
    rows: 1,
    oninput: (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 168)}px`;
      sendBtn.disabled = !e.target.value.trim() || streaming;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!streaming && composerInput.value.trim()) doSend();
      }
    },
  });

  const sendBtn = h('button.composer-send', {
    type: 'button', disabled: true, 'aria-label': '发送',
    onclick: () => (streaming ? stopStream() : doSend()),
  }, '↑');

  const modePick = h('div.mode-pick', { title: '模仿强度' },
    ...[['free', '自由'], ['natural', '自然'], ['high', '高仿']].map(([k, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(mode === k),
        onclick: async (e) => {
          mode = k;
          for (const b of modePick.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', 'true');
        },
      }, label))
  );

  const recallInfo = h('span.dim', { text: '' });

  const composer = h('div.composer',
    h('div.composer-box', composerInput, sendBtn),
    h('div.composer-foot',
      // 软键盘上没有 Shift+Enter，这条提示在手机上只会占地方
      h('span.kbd-hint', { text: 'Enter 发送 · Shift+Enter 换行' }),
      h('span.sep.kbd-hint', { text: '|' }),
      h('span', { text: '模仿强度' }),
      modePick,
      h('span.sep', { text: '|' }),
      recallInfo
    )
  );

  const main = h('div.chat-main', head, scroll, h('div.composer-wrap', composer));

  /* ------------------------------------------------------ rendering */
  function renderThread() {
    flow.replaceChildren();

    if (!messages.length) {
      flow.append(renderEmpty());
    } else {
      let lastDay = '';
      for (const m of messages) {
        const day = new Date(m.createdAt).toDateString();
        if (day !== lastDay) {
          lastDay = day;
          flow.append(h('div.sys-note', { text: dayLabel(m.createdAt) }));
        }
        flow.append(renderMessage(m));
      }
    }
    scrollBottom();
  }

  function renderEmpty() {
    const openers = ['最近怎么样？', '在忙吗', '今天有点想你', '跟你说个事'];
    return h('div', { style: { padding: '30px 10px 20px' } },
      h('div', { style: { textAlign: 'center', marginBottom: '24px' } },
        avatar(p.name, p.avatarUrl, 72),
        h('h2', { style: { fontSize: '1.25rem', marginTop: '14px', marginBottom: '6px' }, text: p.name }),
        h('p.small.muted', { style: { maxWidth: '42ch', margin: '0 auto' },
          text: personaData.profile?.summary || `和 ${p.name} 的 AI 人格聊聊。回复基于你导入的聊天记录与长期记忆。` })
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', maxWidth: '520px', margin: '0 auto' } },
        ...openers.map((o) => h('button.btn.btn-sm', {
          type: 'button',
          onclick: () => {
            composerInput.value = o;
            composerInput.dispatchEvent(new Event('input'));
            composerInput.focus();
          },
        }, o))
      ),
      h('div.sys-note.mt-24',
        h('span.badge', { text: '提示' }),
        h('span', { style: { marginLeft: '8px' }, text: '这个角色由你自己的大模型驱动，仅存在于这段对话里，请不要把它当成真人本人的意思表示。' })
      )
    );
  }

  function renderMessage(m) {
    const isMe = m.role === 'user';
    // 历史消息如果是语音发出的，就该画成语音气泡，而不是文字气泡 + 播放条。
    // 判断依据是「有没有已生成的音频」，不是消息类型 —— 文本内容照样存着，
    // 用来显示"转文字"。
    const asVoice = !isMe && !!m.audioUrl;
    const bubble = asVoice ? voiceBubble(m) : h('div.msg-bubble');
    if (!asVoice) {
      if (isMe) bubble.textContent = m.content;
      else bubble.innerHTML = md(m.content);
    }

    const body = h('div.body',
      h('div.msg-meta',
        h('span', { text: isMe ? '我' : p.name }),
        h('span', { text: fmtTime(m.createdAt) })
      ),
      bubble
    );

    const actions = h('div.msg-actions');
    if (!isMe) {
      /* 这里只留「转文字」，不再提供「把这条文字变成语音」。
       *
       * 理由：微信里一条消息要么是语音、要么是文字，不存在「把文字转成语音」
       * 这个动作 —— 那生成的是配音，不是这个人在说话。用户要的是「TA 这次
       * 是开口说的还是打字的」，由顶栏那三档（文字 / 语音 / 随机）在生成时决定，
       * 而不是事后拿一段文字去合成。语音消息上「转文字」是微信本来就有的功能，
       * 反方向没有。
       *
       * 想看某个人的语音效果，把顶栏切到「语音」再发一条即可 —— 那时模型会
       * 按 [语音转文字] 学到的口语习惯来写，再合成，这才是「像 TA 在说话」。 */
      if (asVoice) {
        actions.append(
          h('button.msg-act', { type: 'button', title: '转成文字', onclick: () => toggleTranscript(body) }, '转文字'),
        );
      }
      actions.append(
        h('button.msg-act', {
          type: 'button', title: '复制',
          onclick: () => { navigator.clipboard.writeText(m.content).then(() => toast('已复制')); },
        }, '复制'),
        h('button.msg-act', {
          type: 'button', title: '重新生成',
          onclick: () => regenerate(m),
        }, '重来'),
        h('button.msg-act', {
          type: 'button', title: '删除',
          onclick: async () => {
            await api.del(`/api/messages/${m.id}`);
            messages = messages.filter((x) => x.id !== m.id);
            renderThread();
          },
        }, '删除')
      );
    } else {
      actions.append(
        h('button.msg-act', {
          type: 'button', title: '编辑',
          onclick: () => editMessage(m),
        }, '编辑'),
        h('button.msg-act', {
          type: 'button', title: '删除',
          onclick: async () => {
            await api.del(`/api/messages/${m.id}`);
            messages = messages.filter((x) => x.id !== m.id);
            renderThread();
          },
        }, '删除')
      );
    }
    body.append(actions);

    if (m.mock) {
      body.append(h('div.msg-mock-note', { title: '该回复来自本地模拟上游，仅用于验证流程' }, '模拟回复'));
    }

    return h('div.msg-row' + (isMe ? '.me' : '.them'), { dataset: { id: m.id } },
      avatar(isMe ? (state.user?.displayName || '我') : p.name, isMe ? null : p.avatarUrl, 28),
      body
    );
  }

  /**
   * 微信式语音气泡。
   *
   * 微信里的语音消息本身就是个气泡：喇叭图标 + 时长，长短不同的语音
   * 气泡宽度也不同。点一下播放，播放时喇叭有波纹动画。
   * 这里按真实音频时长算宽度（越长约宽），而不是把所有语音画成同一个宽度。
   */
  /**
   * 记住「这条语音听过了」。
   *
   * 只挂在 DOM class 上是不够的：切到别的对话再回来、或者刷新页面，
   * 气泡是重建的，红点又全亮了 —— 用户看到的就是「听完了红点不消失」。
   * 所以按 messageId 落到 localStorage，渲染时先查这个表。
   */
  const HEARD_KEY = 'ep.voiceHeard.v1';
  const heardSet = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(HEARD_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch { return new Set(); }
  })();
  const markHeard = (id) => {
    if (!id) return;
    heardSet.add(id);
    // 只留最近 500 条，避免这份本地记录无限长大
    if (heardSet.size > 500) {
      const keep = [...heardSet].slice(-500);
      heardSet.clear();
      for (const k of keep) heardSet.add(k);
    }
    try { localStorage.setItem(HEARD_KEY, JSON.stringify([...heardSet])); } catch { /* 隐私模式 */ }
  };

  function voiceBubble(m) {
    const audioUrl = m.audioUrl || `/api/messages/${m.id}/audio`;
    const spk = h('span.voice-bubble-dot');
    const icon = svgIcon('voiceSpeaker');
    const dur = h('span.voice-bubble-dur', { text: m.audioSec ? `${m.audioSec}"` : '…' });

    const bubble = h('div.msg-bubble.is-voice', { role: 'button', tabindex: '0' },
      spk, icon, dur);
    // 之前听过就不要再亮红点
    if (heardSet.has(m.id)) bubble.classList.add('heard');

    const audio = new Audio();
    audio.preload = 'metadata';

    const applyWidth = (sec) => {
      // 微信的语音气泡宽度随秒数增长：短的很短，长的明显更宽。
      // 6" 以下 ≈ 96px 起步，每多 1 秒加约 6px，封顶 240px。
      const s = Math.max(1, Math.min(60, sec || 1));
      const w = Math.min(240, 92 + Math.round(s * 6));
      bubble.style.minWidth = `${w}px`;
      dur.textContent = `${Math.round(s)}"`;
    };

    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        applyWidth(audio.duration);
        // 同步回消息对象，切会话回来时不用重算
        m.audioSec = Math.round(audio.duration);
      }
    });

    /* 「听过」的判定。
     *
     * 微信的真实行为是：你点开一条语音，红点在开始播的那一刻就没了 ——
     * 不需要听完，也不需要「进度过半」。之前只挂 ended，于是
     * 「听到一半暂停」「长语音没听完」都会一直亮着，用户报的就是这个。
     * 所以：播放一开始就标记已听（play 事件），另外用 timeupdate/pause
     * 兜住「自动播放被浏览器拦下但用户确实点过」的情况。 */
    const settleHeard = () => {
      if (bubble.classList.contains('heard')) return;
      bubble.classList.add('heard');
      markHeard(m.id);
    };
    audio.addEventListener('play', settleHeard);
    audio.addEventListener('ended', () => {
      bubble.classList.remove('playing');
      settleHeard();
    });
    audio.addEventListener('pause', () => {
      bubble.classList.remove('playing');
      // 点过播放、哪怕只播了一点点，也算听过
      if ((audio.currentTime || 0) > 0.05) settleHeard();
    });
    audio.addEventListener('timeupdate', () => {
      if ((audio.currentTime || 0) > 0.05) settleHeard();
    });
    audio.addEventListener('error', () => {
      dur.textContent = '加载失败';
      bubble.classList.remove('playing');
    });

    /* 立刻挂上 src 但只 preload metadata：
     * 语音条一出现就该显示真实秒数（微信就是这样），
     * 如果等用户点击才设 src，条子会一直显示 "…"，不知道多长。
     * preload=metadata 只拉文件头，不会整段下载，也不会出声。 */
    audio.src = audioUrl;

    const toggle = () => {
      if (audio.paused) {
        // 同一时间只放一条：否则多条语音会叠在一起
        stopAllVoice(audio);
        audio.play().then(() => bubble.classList.add('playing'))
          .catch(() => toast('无法播放音频，请检查浏览器是否允许自动播放', 'err'));
      } else {
        audio.pause();
      }
    };
    bubble.addEventListener('click', toggle);
    bubble.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    // 记下 audio 元素，便于统一切换
    bubble._audio = () => audio;
    voicePlayers.add(audio);
    // 挂进 DOM（隐藏）：调试/自动化能验到"这条到底有没有音频可播"，
    // 也让浏览器把它当成活元素管理加载状态。
    audio.hidden = true;
    bubble.append(audio);

    if (m.audioSec) applyWidth(m.audioSec);
    return bubble;
  }

  // 全局只允许一条语音播放
  const voicePlayers = new Set();
  function stopAllVoice(except) {
    for (const a of voicePlayers) {
      if (a !== except && !a.paused) { a.pause(); a.currentTime = 0; }
    }
  }

  /** 「转文字」：语音气泡下面展开 TA 当时说的内容 */
  function toggleTranscript(body) {
    const existing = body.querySelector('.voice-transcript');
    if (existing) { existing.remove(); return; }
    const row = body.closest('.msg-row');
    const id = row?.dataset?.id;
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    body.insertBefore(h('div.voice-transcript', { text: m.content }), body.querySelector('.msg-actions'));
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return '今天';
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function scrollBottom(smooth = false) {
    requestAnimationFrame(() => {
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  /* ---------------------------------------------------------- send */
  async function doSend() {
    const text = composerInput.value.trim();
    if (!text || streaming) return;

    const localUser = { id: `tmp_u_${Date.now()}`, role: 'user', content: text, createdAt: Date.now() };
    messages.push(localUser);
    composerInput.value = '';
    composerInput.style.height = 'auto';
    sendBtn.disabled = true;
    renderThread();

    const assistantEl = h('div.msg-row.them',
      avatar(p.name, p.avatarUrl, 28),
      h('div.body',
        h('div.msg-meta',
          h('span', { text: p.name }),
          h('span', { text: '正在输入…' })
        ),
        h('div.msg-bubble', h('span.typing', h('i'), h('i'), h('i')))
      )
    );
    flow.append(assistantEl);
    scrollBottom(true);

    streaming = true;
    abortCtl = new AbortController();
    sendBtn.classList.add('stop');
    sendBtn.textContent = '■';
    sendBtn.disabled = false;

    let acc = '';
    const bubble = assistantEl.querySelector('.msg-bubble');
    const meta = assistantEl.querySelector('.msg-meta span:last-child');
    let firstChunk = true;
    /* 服务端会提前决定这条是打字还是发语音。如果是语音，它会
     * 一个字都不往前端流 —— 所以这边不能把"没有 delta"理解成卡住了，
     * 要靠 speaking 事件把气泡切换成"正在说话"的形态。 */
    let willSpeak = false;

    try {
      const res = await fetch(`/api/personas/${personaId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        signal: abortCtl.signal,
        body: JSON.stringify({ message: text, chatId: currentChatId, mode, voiceMode }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `请求失败（${res.status}）`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }

          if (ev.type === 'start') {
            currentChatId = ev.chatId;
            localUser.id = ev.userMessageId;
            const r = ev.recalled;
            /* 「召回了什么」只在真的召回时才说，而且要说人话。
             *
             * 以前固定挂一条「召回 0 条记忆 / 4 段对话」—— 0 条记忆这件事
             * 对用户没有任何意义，堆在每条回复上只会让人以为出错了。
             * 现在：
             *   · 什么都没召回 → 不显示（没有证据就别贴标签）
             *   · 只召回了旧对话 → 「参考了 4 段你们的旧对话」
             *   · 记忆和对话都有 → 一起说
             * 文案强调「参考了真实记录」，这正是用户想知道的那件事：
             * 这条回复是不是照着你们说过的话来的。 */
            const nm = Number(r?.memories) || 0;
            const nc = Number(r?.chunks) || 0;
            if (nm || nc) {
              const bits = [];
              if (nm) bits.push(`${nm} 条记忆`);
              if (nc) bits.push(`${nc} 段旧对话`);
              const chip = h('div.recall-chip', svgIcon('icSpark'),
                h('span', { text: `参考了${bits.join('、')}` }));
              chip.title = nm && nc
                ? '这条回复用到了从聊天记录里提炼的记忆，以及你导入的真实对话片段'
                : (nc ? '这条回复参考了你们真实聊过的片段，按当前话题挑出来的' : '这条回复用到了从聊天记录里提炼的记忆');
              assistantEl.querySelector('.body').insertBefore(chip, bubble);
            }

            /* 输入框下面那行小字原来写「召回 0 条记忆 / 4 段对话」——
             * 数字对上不上用户无从核对，而且每次都在，纯噪声。
             * 换成「这次照着她的多少句原话在写」：这是用户真正关心、
             * 也能在「人格档案 → 语料」里对照的确定事实。 */
            const s = ev.samples || {};
            const nLines = (Number(s.lines) || 0) + (Number(s.voice) || 0);
            const nPairs = Number(s.pairs) || 0;
            if (nLines || nPairs) {
              const parts = [];
              if (nPairs) parts.push(`${nPairs} 段真实问答`);
              if (nLines) parts.push(`${nLines} 句原话`);
              recallInfo.textContent = `本次参考 ${parts.join(' + ')}`;
              recallInfo.title = '这些都是从你导入的聊天记录里挑出来的，不是模型编的';
            }
          } else if (ev.type === 'delta') {
            if (firstChunk) {
              bubble.textContent = '';
              meta.textContent = fmtTime(Date.now());
              firstChunk = false;
            }
            acc += ev.text;
            /* 流式期间把 `|||` 显示成分行。
             * 它是服务端用的多条分隔符，不该让用户看到这三个竖线；
             * 而生成过程中还无法确定要不要拆，所以先按换行显示，
             * 收到 done 再重绘成真正的多个气泡。 */
            bubble.innerHTML = md(acc.replace(/\|{2,}\s*\|{0,}/g, '\n'));
            const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
            if (nearBottom) scrollBottom();
          } else if (ev.type === 'speaking') {
            /* 这条是语音。服务端整个生成过程不会吐一个字过来，
             * 所以这里要主动把"正在输入"的空气泡换成语音形态，
             * 否则用户会盯着一片空白以为卡死了。 */
            willSpeak = true;
            meta.textContent = fmtTime(Date.now());
            bubble.classList.add('is-voice', 'voice-pending');
            bubble.replaceChildren(
              h('span.voice-bubble-dot'),
              svgIcon('voiceSpeaker'),
              h('span.voice-bubble-dur', { text: '…' })
            );
            const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
            if (nearBottom) scrollBottom();
          } else if (ev.type === 'tts_failed') {
            // 合成失败就必须老实退回文字 —— 不能让用户以为"这条是语音"
            willSpeak = false;
            toast(`语音合成失败：${ev.message}`, 'err');
          } else if (ev.type === 'error') {
            throw new Error(ev.message);
          } else if (ev.type === 'done') {
            meta.textContent = fmtTime(Date.now());
            /* 多条气泡：服务端把回复拆好了，这里逐条 push，
             * 每条渲染成一个独立气泡 —— 刷新页面后仍然是几条，
             * 因为它们各自是独立的 messages 记录。 */
            if (Array.isArray(ev.bubbles) && ev.bubbles.length > 1) {
              for (const b of ev.bubbles) {
                messages.push({
                  id: b.id, role: 'persona', content: b.content,
                  createdAt: Date.now(), hasAudio: false, audioUrl: null, mock: !!ev.mock,
                });
              }
            } else {
              messages.push({
                id: ev.messageId, role: 'persona',
                // 语音消息的 content 是"转文字"要看的内容，服务端会一起给
                content: ev.content ?? acc,
                createdAt: Date.now(),
                hasAudio: !!ev.audioUrl,
                audioUrl: ev.audioUrl || null,
                mock: !!ev.mock,
              });
            }
            if (ev.aborted) toast('已停止生成');
            if (ev.mock) toast('当前为模拟上游返回的示例回复，非真实模型输出');
            renderThread();
            /* 这里**不要**自动播放。
             * 微信收到语音消息从不自己出声 —— 突然在会议室里响起来是灾难。
             * 语音条一挂载就会（只拉文件头）读到时长并显示秒数，
             * 什么时候听由用户点。 */
          } else if (ev.type === 'failed') {
            throw new Error(ev.error || '生成失败');
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        if (acc.trim()) {
          messages.push({ id: `tmp_${Date.now()}`, role: 'persona', content: acc, createdAt: Date.now() });
        }
        renderThread();
      } else {
        assistantEl.remove();
        messages = messages.filter((x) => x.id !== localUser.id || x.content !== text);
        toast(e.message, 'err');
        composerInput.value = text;
        composerInput.dispatchEvent(new Event('input'));
      }
    } finally {
      streaming = false;
      abortCtl = null;
      sendBtn.classList.remove('stop');
      sendBtn.textContent = '↑';
      sendBtn.disabled = !composerInput.value.trim();
      refreshRail();
      headSub.replaceChildren(
        h('span', { text: personaData.profile ? (p.relationship || '在线') : '尚未分析' }),
        h('span', { style: { color: 'var(--line)' }, text: '·' }),
        h('span', { text: `${p.importedMessages.toLocaleString()} 条记录` })
      );
    }
  }

  function stopStream() {
    abortCtl?.abort();
  }

  async function regenerate(m) {
    if (streaming) return;
    try {
      const r = await api.post(`/api/chats/${currentChatId}/regenerate`);
      messages = messages.filter((x) => x.id !== m.id);
      const lastUser = [...messages].reverse().find((x) => x.role === 'user');
      if (lastUser) messages = messages.filter((x) => x.id !== lastUser.id);
      renderThread();
      composerInput.value = r.message;
      composerInput.dispatchEvent(new Event('input'));
      doSend();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function editMessage(m) {
    const ta = h('textarea', { rows: 3, value: m.content });
    modal({
      title: '编辑消息',
      body: h('div.field', h('label', { text: '内容' }), ta,
        h('div.hint', { text: '编辑后不会自动重新生成回复，可以手动点击「重来」。' })),
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '保存', kind: 'primary',
          onClick: async () => {
            await api.patch(`/api/messages/${m.id}`, { content: ta.value.trim() });
            m.content = ta.value.trim();
            renderThread();
            toast('已保存');
          },
        },
      ],
    });
  }


  /* ------------------------------------------------- persona picker */
  function openPersonaPicker() {
    modal({
      title: '切换人格',
      body: h('div.col.gap-4',
        ...state.personas.map((pp) => h('button', {
          type: 'button',
          style: {
            display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 10px',
            border: '1px solid ' + (pp.id === personaId ? 'var(--copper)' : 'transparent'),
            background: pp.id === personaId ? 'var(--copper-tint)' : 'transparent',
            borderRadius: '9px', cursor: 'pointer', width: '100%', textAlign: 'left',
            fontFamily: 'var(--sans)',
          },
          onclick: () => navigate(`/app/chat/${pp.id}`),
        },
          avatar(pp.name, pp.avatarUrl, 34),
          h('div.grow',
            h('div', { style: { fontWeight: '600', fontSize: '0.9rem' }, text: pp.name }),
            h('div.tiny.dim', { text: pp.relationship || '未设置关系' })
          ),
          pp.analysisStatus === 'ready' ? h('span.badge.badge-sage', { text: '就绪' }) : h('span.badge', { text: '未分析' })
        )),
        h('a.btn.btn-sm.mt-16', { href: '/app/personas/new' }, '＋ 新建人格')
      ),
      actions: [{ label: '关闭', kind: 'ghost' }],
    });
  }

  /* ------------------------------------------------------ assemble */
  renderThread();

  /* 会话抽屉：手机上是全屏浮层，桌面上它就是常驻的一栏。
     以前这里只改 rail 的 inline display，既没有遮罩也没有锁滚动，
     收起来以后还得靠切宽度才恢复；现在统一按 body 的类来控制，
     和 CSS 里 @media (max-width:900px) 的规则对齐。 */
  const isNarrow = () => window.innerWidth <= 900;
  function openRail() {
    if (!isNarrow()) return;
    rail.classList.add('open');
    document.body.classList.add('rail-open');
  }
  function closeRail() {
    rail.classList.remove('open');
    document.body.classList.remove('rail-open');
  }
  function toggleRail() {
    if (rail.classList.contains('open')) closeRail();
    else openRail();
  }

  // 抽屉浮层点空白处收起
  rail.addEventListener('click', (e) => {
    if (e.target === rail) closeRail();
  });
  // 选了某个会话就自动收起，否则手机上永远停在列表页
  rail.addEventListener('click', (e) => {
    if (e.target.closest?.('.rail-chat, .rail-persona, .rail-close')) closeRail();
  });

  // 按钮只在窄屏出现。用 matchMedia 比 ResizeObserver 更省事，也不必轮询宽度。
  const mq = window.matchMedia('(max-width: 900px)');
  const syncRailToggle = () => {
    const btn = head.querySelector('#rail-toggle');
    if (btn) btn.style.display = mq.matches ? 'inline-flex' : 'none';
    if (!mq.matches) closeRail();
  };
  mq.addEventListener('change', syncRailToggle);
  syncRailToggle();

  const view = shell({
    active: `persona:${personaId}`, title: p.name, wide: true,
    content: h('div.chat-layout', rail, main),
  });

  /* 对话页要占满整屏：去掉 shell 给内容区加的内边距和顶栏。
   * 高度交给 CSS（body.chat-page + 100dvh），不要在这里写死 100vh ——
   * 移动端 100vh 含地址栏高度，键盘一弹输入框就跑到屏幕外了。 */
  document.body.classList.add('chat-page');
  setTimeout(() => {
    const contentEl = document.querySelector('.content');
    if (contentEl) {
      contentEl.style.padding = '0';
      contentEl.style.maxWidth = 'none';
    }
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.style.display = 'none';
    // 宽屏才自动聚焦：手机上抢焦点会直接把软键盘顶起来，
    // 用户还没看清历史消息就被键盘占掉半个屏幕。
    if (!isNarrow()) composerInput.focus();
  }, 0);

  /* 离开对话页时把锁滚动的类清掉，否则回到别的页面滚不动 */
  window.addEventListener('popstate', () => {
    document.body.classList.remove('rail-open');
    document.body.classList.remove('chat-page');
  });

  /* ------------------------------------------------- 软键盘适配
   *
   * 「输入框要在输入法上方」这件事在 iOS 上不是排版问题，是视口问题：
   * 键盘弹起时 visualViewport 变矮了，但布局视口（以及 100dvh）**不变**。
   * 于是输入框实际被键盘盖住，用户只看到聊天记录，打不了字。
   *
   * 解法是拿 visualViewport.height 当真实可用高度，写进 --app-h，
   * 让窄屏的 .chat-layout 跟着它变（见 CSS 里 --app-h 的用法）。
   *
   * 三条硬约束，任何一条破了都会把布局搞坏：
   *   1. 只信 visualViewport，绝不用元素自身高度反推。
   *      用 .chat-layout 的高度回写 --app-h 会形成正反馈：
   *      内容撑高 → 写入更大的 --app-h → 聊天区更高 → 内容更高，
   *      几帧之内就能把页面撑到几千像素（桌面实测过，3251px）。
   *   2. 只在明显变矮（键盘）时生效，地址栏收放那点抖动不参与。
   *   3. 桌面完全不动：--app-h 只在窄屏 CSS 里被读到，
   *      宽屏下写了也没有任何规则消费它。
   */
  const vv = window.visualViewport;
  let lastH = 0;
  const applyHeight = (h) => {
    if (!isNarrow()) {
      // 桌面：清掉可能残留的值，避免旋转窗口后带到下一次
      document.documentElement.style.removeProperty('--app-h');
      lastH = 0;
      return;
    }
    const vh = Math.round(h);
    if (!vh || vh === lastH) return;
    lastH = vh;
    document.documentElement.style.setProperty('--app-h', `${vh}px`);
    /* 键盘吃掉大半屏幕后，消息区如果还停在旧位置，用户刚打的字就在视野外，
     * 看起来像"输入框跳走了"。所以收缩之后要重新贴到底。 */
    requestAnimationFrame(() => scrollBottom());
  };

  const onVv = () => applyHeight(vv.height);
  if (vv) {
    vv.addEventListener('resize', onVv);
    // iOS 在某些情况下只触发 scroll 不触发 resize（比如切到浏览器全屏）
    vv.addEventListener('scroll', onVv);
    applyHeight(vv.height);
  }
  /* 横竖屏切换 / 桌面↔窄屏拖拽时 visualViewport 不一定会发事件，
   * 用 resize 兜一次 —— 但仍然只读 visualViewport，不读元素高度。 */
  const onWinResize = () => { if (vv) applyHeight(vv.height); else lastH = 0; };
  window.addEventListener('resize', onWinResize);

  const clearViewport = () => {
    document.documentElement.style.removeProperty('--app-h');
    if (vv) { vv.removeEventListener('resize', onVv); vv.removeEventListener('scroll', onVv); }
    window.removeEventListener('resize', onWinResize);
    lastH = 0;
  };
  window.addEventListener('popstate', clearViewport);

  return view;
}
