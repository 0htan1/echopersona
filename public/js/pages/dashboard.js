import {
  h, api, toast, avatar, navigate, fmtRelative, fmtDate, modal, $, emptyArt,
} from '../core.js';
import { state, shell, setTitle, loadPersonas, requireUser } from '../shell.js';

export async function dashboardPage() {
  if (!requireUser()) return;
  setTitle('工作台');

  /* 三个请求并行。
   * 之前是 await loadPersonas() 之后再串行等 configs —— 一次导航要多花
   * 两个来回（约 80~200ms），叠加在跳转上就是「点了以后要等一下才动」。
   * 这三个请求互不依赖，没有任何理由排队。 */
  const [, llmRes, ttsRes] = await Promise.all([
    loadPersonas(),
    api.get('/api/llm-configs').then((r) => r.configs).catch(() => []),
    api.get('/api/tts-configs').then((r) => r.configs).catch(() => []),
  ]);

  const personas = state.personas;
  const totalMsgs = personas.reduce((a, p) => a + (p.importedMessages || 0), 0);
  const totalMem = personas.reduce((a, p) => a + (p.memoryCount || 0), 0);
  const ready = personas.filter((p) => p.analysisStatus === 'ready').length;

  // setup checklist。云通道路由已下线，只剩自备 Key 这一条路。
  // 老库里可能残留 provider='workbuddy-cloud' 的行，它们不算「已配置」。
  const hasLlm = llmRes.some((c) => c.provider !== 'workbuddy-cloud');
  const hasTts = ttsRes.length > 0;
  const hasImport = personas.some((p) => p.importedMessages > 0);

  const steps = [
    { done: hasLlm, label: '配置大模型 API', hint: '填写你自己的 API Key，测试连接', href: '/app/settings/keys' },
    { done: personas.length > 0, label: '创建一个人格', hint: '填昵称、关系与人物描述', href: '/app/personas/new' },
    { done: hasImport, label: '导入聊天记录', hint: 'TXT / JSON / CSV / Markdown / ZIP', href: personas[0] ? `/app/personas/${personas[0].id}/import` : '/app/personas/new' },
    { done: ready > 0, label: '运行人格分析', hint: '生成语言风格档案与长期记忆', href: personas[0] ? `/app/personas/${personas[0].id}/analysis` : '/app/personas/new' },
    { done: hasTts, label: '配置语音服务（可选）', hint: 'BreezeTTS 服务地址与密钥', href: '/app/settings/keys' },
  ];
  const pending = steps.filter((s) => !s.done);

  const content = h('div',
    h('div.between.mb-24', { style: { alignItems: 'flex-end' } },
      h('div',
        h('h1', { style: { fontSize: '1.75rem', marginBottom: '4px' }, text: greeting() }),
        h('p.muted.small', { style: { margin: 0 }, text: '从这里管理你的人格、记忆与对话。' })
      ),
      h('div.row.gap-8',
        h('a.btn', { href: '/app/personas/new' }, '＋ 新建人格'),
        personas.length ? h('a.btn.btn-primary', { href: `/app/chat/${personas[0].id}` }, '开始对话') : null
      )
    ),

    // stats
    h('div.stat-row',
      stat('人格数量', personas.length, `${ready} 个已完成分析`),
      stat('已导入消息', totalMsgs.toLocaleString(), '来自你的聊天记录'),
      stat('长期记忆', totalMem.toLocaleString(), '条可检索的结构化记忆'),
      stat('对话数', personas.reduce((a, p) => a + (p.chatCount || 0), 0), '各人格会话总数')
    ),

    // onboarding
    pending.length
      ? h('div.card.mb-24', { style: { borderColor: '#e5d6c6', background: 'var(--copper-tint)' } },
          h('div.between.mb-16',
            h('div',
              h('h3', { style: { fontSize: '1.05rem', marginBottom: '3px' }, text: '还差几步就能开始对话' }),
              h('p.small.muted', { style: { margin: 0 }, text: `${steps.filter((s) => s.done).length} / ${steps.length} 已完成` })
            ),
            h('div.tiny.dim', { text: '所有密钥都只保存在你的账户里' })
          ),
          h('div.col.gap-8',
            ...steps.map((s) => h('a', {
              href: s.href,
              style: {
                display: 'flex', alignItems: 'center', gap: '11px', padding: '10px 13px',
                background: s.done ? 'transparent' : 'var(--card)',
                border: `1px solid ${s.done ? 'var(--line-2)' : 'var(--line)'}`,
                borderRadius: '9px', textDecoration: 'none', color: 'inherit',
                opacity: s.done ? '0.62' : '1',
              },
            },
              h('span', {
                style: {
                  width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
                  display: 'grid', placeItems: 'center', fontSize: '10px',
                  background: s.done ? 'var(--sage)' : 'transparent',
                  border: s.done ? 'none' : '1.5px solid #cfc3b4',
                  color: '#fff',
                },
                text: s.done ? '✓' : '',
              }),
              h('div.grow',
                h('div', { style: { fontSize: '0.875rem', fontWeight: '600', color: 'var(--ink)' }, text: s.label }),
                h('div.tiny.dim', { text: s.hint })
              ),
              h('span.dim', { text: s.done ? '' : '→' })
            ))
          )
        )
      : null,

    // personas
    h('div.between.mb-16',
      h('h2', { style: { fontSize: '1.15rem' }, text: '我的人格' }),
      personas.length ? h('a.small', { href: '/app/personas', text: '查看全部 →' }) : null
    ),
    personas.length
      ? h('div.persona-grid',
          ...personas.slice(0, 6).map(personaCard),
          h('button.new-card', { type: 'button', onclick: () => navigate('/app/personas/new') },
            h('div', h('span.plus', { text: '＋' }), '新建人格'))
        )
      : h('div.empty.empty-rich',
          emptyArt('noPersona'),
          h('h3', { text: '还没有人格' }),
          h('p', { text: '创建一个人格，导入你和 TA 的聊天记录，系统会自动分析出对方的说话方式。' }),
          h('a.btn.btn-copper', { href: '/app/personas/new' }, '创建第一个人格')
        )
  );

  return shell({ active: 'dashboard', title: '工作台', content });
}

function greeting() {
  const hr = new Date().getHours();
  const name = state.user?.displayName || '';
  const g = hr < 6 ? '还没睡' : hr < 11 ? '早上好' : hr < 14 ? '中午好' : hr < 18 ? '下午好' : hr < 23 ? '晚上好' : '夜深了';
  return name ? `${g}，${name}` : g;
}

function stat(k, v, d) {
  return h('div.stat',
    h('div.k', { text: k }),
    h('div.v', { text: String(v) }),
    h('div.d', { text: d })
  );
}

export function personaCard(p) {
  const statusBadge = {
    ready: h('span.badge.badge-sage.badge-dot', { text: '已就绪' }),
    running: h('span.badge.badge-amber.badge-dot', { text: '分析中' }),
    queued: h('span.badge.badge-amber.badge-dot', { text: '排队中' }),
    failed: h('span.badge.badge-danger.badge-dot', { text: '分析失败' }),
    none: h('span.badge', { text: '未分析' }),
  }[p.analysisStatus] || h('span.badge', { text: '未分析' });

  return h('a.persona-card', { href: `/app/personas/${p.id}` },
    h('div.top',
      avatar(p.name, p.avatarUrl, 52),
      h('div.grow', { style: { minWidth: 0 } },
        h('div.nm.truncate', { text: p.name }),
        h('div.rl.truncate', { text: p.relationship || '未设置关系' })
      ),
      statusBadge
    ),
    h('div.bio.clamp-3', {
      text: p.bio || p.description || (p.lastMessage ? `最近：「${p.lastMessage.content}」` : '还没有简介'),
    }),
    h('div.foot',
      h('span', h('b', { text: String(p.importedMessages || 0) }), ' 条记录'),
      h('span', { style: { color: 'var(--line)' }, text: '·' }),
      h('span', h('b', { text: String(p.memoryCount || 0) }), ' 条记忆'),
      h('span', { style: { color: 'var(--line)' }, text: '·' }),
      h('span', { text: p.lastMessage ? fmtRelative(p.lastMessage.at) : fmtDate(p.createdAt) })
    )
  );
}

/* --------------------------------------------------- personas list */
export async function personasPage() {
  if (!requireUser()) return;
  setTitle('我的人格');
  await loadPersonas();

  const content = h('div',
    h('div.between.mb-24',
      h('div',
        h('h1', { style: { fontSize: '1.6rem', marginBottom: '4px' }, text: '我的人格' }),
        h('p.muted.small', { style: { margin: 0 }, text: '每个人格拥有独立的聊天记录、记忆与语音配置。' })
      ),
      h('a.btn.btn-primary', { href: '/app/personas/new' }, '＋ 新建人格')
    ),
    state.personas.length
      ? h('div.persona-grid',
          ...state.personas.map(personaCard),
          h('button.new-card', { type: 'button', onclick: () => navigate('/app/personas/new') },
            h('div', h('span.plus', { text: '＋' }), '新建人格'))
        )
      : h('div.empty.empty-rich',
          emptyArt('noPersona'),
          h('h3', { text: '还没有人格' }),
          h('p', { text: '创建人格后导入聊天记录，系统就能提取对方的语言风格。' }),
          h('div.empty-steps',
            h('div.empty-step', h('span.n', { text: '1' }), h('span', { text: '填一个名字和关系' })),
            h('div.empty-step', h('span.n', { text: '2' }), h('span', { text: '导入聊天记录' })),
            h('div.empty-step', h('span.n', { text: '3' },), h('span', { text: '开始对话' })),
          ),
          h('a.btn.btn-copper', { href: '/app/personas/new' }, '创建人格')
        )
  );

  return shell({ active: 'personas', title: '人格', content });
}

/* ---------------------------------------------------- create page */
export async function newPersonaPage() {
  if (!requireUser()) return;
  setTitle('创建人格');

  const name = h('input', { type: 'text', required: true, placeholder: '例如：林小满', maxlength: 60 });
  const rel = h('input', { type: 'text', placeholder: '例如：多年好友 / 前任 / 家人 / 同事', maxlength: 100 });
  const bio = h('input', { type: 'text', placeholder: '一句话介绍（会显示在卡片上）', maxlength: 300 });
  const desc = h('textarea', {
    placeholder: '补充说明 TA 是谁、你们的相处方式、你希望复刻哪些方面。这段描述会作为分析时的参考上下文。',
    rows: 4, maxlength: 4000,
  });
  const lang = h('select', {},
    h('option', { value: 'zh' }, '中文'),
    h('option', { value: 'en' }, 'English'),
    h('option', { value: 'ja' }, '日本語')
  );
  const modeSel = h('select', {},
    h('option', { value: 'natural' }, '自然模仿（推荐）'),
    h('option', { value: 'high' }, '高度模仿'),
    h('option', { value: 'free' }, '自由模式')
  );
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });
  const btn = h('button.btn.btn-copper.btn-lg', { type: 'submit' }, '创建并继续');

  /* 先把表单画出来，模型列表稍后再填。
   *
   * 这里原本是 `const llms = await api.get(...)` —— 整个页面（包括输入框）
   * 都要等这一个接口回来才出现。而这个下拉框对"开始填写昵称"毫无帮助，
   * 却让首屏凭空多了 100~200ms 的白屏。现在只要一个占位就够，
   * 数据到了再替换选项。 */
  const llmSel = h('select', {}, h('option', { value: '' }, '加载中…'));
  /* 提示语对象单独留个引用：模型列表回来之后要按「有没有配过」改写文案。
   * 不这么做的话，新用户永远看不到「请先去配置 API Key」这句最关键的引导。 */
  const llmHint = h('div.hint', { text: '每个人格可以独立选择模型，例如分析用强模型、日常聊天用便宜模型。' });
  api.get('/api/llm-configs')
    .then((r) => r.configs)
    .catch(() => [])
    .then((llms) => {
      llmSel.replaceChildren(
        h('option', { value: '' }, llms.length ? '使用默认配置' : '（尚未配置大模型）'),
        ...llms.map((c) => h('option', { value: c.id }, `${c.label} · ${c.model}`))
      );
      if (!llms.length) {
        llmHint.textContent = '还没有配置大模型。可以先创建人格，之后到「API 配置」补充。';
      }
    });

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!name.value.trim()) { err.textContent = '请填写人物昵称'; return; }
      btn.disabled = true;
      btn.replaceChildren(h('span.spin'), ' 创建中');
      try {
        const r = await api.post('/api/personas', {
          name: name.value.trim(),
          relationship: rel.value.trim(),
          bio: bio.value.trim(),
          description: desc.value.trim(),
          language: lang.value,
          similarityMode: modeSel.value,
          llmConfigId: llmSel.value || null,
        });
        await loadPersonas();
        toast('人格已创建，接下来导入聊天记录');
        navigate(`/app/personas/${r.persona.id}/import`, { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = '创建并继续';
      }
    },
  },
    h('div.card.mb-16',
      h('div.card-title', { text: '基本信息' }),
      h('div.form-grid',
        h('div.field', h('label', '人物昵称 ', h('span.req', '*')), name),
        h('div.field', h('label', { text: '与你的关系' }), rel),
        h('div.field.full', h('label', { text: '一句话介绍' }), bio),
        h('div.field.full',
          h('label', { text: '人物描述' }), desc,
          h('div.hint', { text: '写清楚 TA 的年龄、职业、和你的相处模式，能让分析更准确。也可以留空，让系统纯靠聊天记录推断。' })
        )
      )
    ),
    h('div.card.mb-16',
      h('div.card-title', { text: '对话设置' }),
      h('div.form-grid',
        h('div.field',
          h('label', { text: '主要语言' }), lang,
          h('div.hint', { text: '影响 AI 回复语言与语音合成语言。' })
        ),
        h('div.field',
          h('label', { text: '默认模仿强度' }), modeSel,
          h('div.hint', { text: '自然模仿在还原语气与保持对话质量之间平衡；高度模仿更贴近原话，但可能不够灵活。' })
        ),
        h('div.field.full',
          h('label', { text: '使用的大模型' }), llmSel,
          llmHint
        )
      )
    ),
    err,
    h('div.row',
      h('a.btn', { href: '/app' }, '取消'),
      h('div.grow'),
      btn
    )
  );

  return shell({ active: 'personas', title: '新建人格', content: h('div', { style: { maxWidth: '660px' } },
    h('h1', { style: { fontSize: '1.55rem', marginBottom: '6px' }, text: '创建人格' }),
    h('p.muted.small.mb-24', { text: '先填写基础信息。导入聊天记录后才会有语言风格可分析。' }),
    form
  ) });
}
