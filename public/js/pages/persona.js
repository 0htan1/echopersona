import {
  h, api, toast, avatar, navigate, fmtBytes, fmtDate, fmtRelative,
  modal, confirmDialog, esc, emptyArt, svgIcon,
} from '../core.js';
import { state, shell, setTitle, requireUser, loadPersonas } from '../shell.js';

/* ================================================================== *
 * Persona detail (overview / imports / analysis / memories / settings)
 * ================================================================== */
export async function personaDetailPage(id, tab = 'overview') {
  if (!requireUser()) return;
  setTitle('人格详情');

  let data;
  try {
    data = await api.get(`/api/personas/${id}`);
  } catch (e) {
    return shell({
      active: 'personas', title: '人格', content: h('div.empty',
        h('h3', { text: '找不到这个人格' }),
        h('a.btn', { href: '/app/personas' }, '返回人格列表')
      ),
    });
  }
  const p = data.persona;

  const tabs = [
    ['overview', '概览'],
    ['import', `聊天记录${data.imports.length ? ` (${data.imports.length})` : ''}`],
    ['analysis', '人格分析'],
    ['memories', `长期记忆 (${p.memoryCount})`],
    ['settings', '设置'],
  ];

  const header = h('div.detail-head',
    avatar(p.name, p.avatarUrl, 72),
    h('div.info',
      h('h1', { text: p.name }),
      h('div.detail-meta',
        p.relationship ? h('span', { text: p.relationship }) : h('span.dim', { text: '未设置关系' }),
        h('span', { style: { color: 'var(--line)' }, text: '·' }),
        h('span', { text: `${p.importedMessages.toLocaleString()} 条记录` }),
        h('span', { style: { color: 'var(--line)' }, text: '·' }),
        h('span', { text: `${p.memoryCount} 条记忆` }),
        h('span', { style: { color: 'var(--line)' }, text: '·' }),
        h('span', { text: `${data.chunkCount} 个对话片段` }),
        analysisBadge(p.analysisStatus)
      )
    ),
    h('div.row.gap-8',
      h('a.btn', { href: `/app/personas/${id}/import` }, '导入记录'),
      p.analysisStatus === 'ready'
        ? h('a.btn.btn-primary', { href: `/app/chat/${id}` }, '开始对话')
        : h('button.btn.btn-primary', {
            type: 'button',
            onclick: () => navigate(`/app/personas/${id}/analysis`),
          }, '运行分析')
    )
  );

  const tabBar = h('div.pill-tabs.mb-24', { role: 'tablist' },
    ...tabs.map(([key, label]) => h('button', {
      type: 'button', role: 'tab',
      'aria-selected': String(tab === key),
      onclick: () => navigate(key === 'overview' ? `/app/personas/${id}` : `/app/personas/${id}/${key}`),
    }, label))
  );

  let body;
  if (tab === 'import') body = await renderImportTab(id, data);
  else if (tab === 'analysis') body = await renderAnalysisTab(id, data);
  else if (tab === 'memories') body = await renderMemoriesTab(id, data);
  else if (tab === 'settings') body = renderSettingsTab(id, data);
  else body = renderOverviewTab(id, data);

  return shell({
    active: `persona:${id}`, title: p.name,
    content: h('div', header, tabBar, body),
  });
}

function analysisBadge(s) {
  const map = {
    ready: ['badge-sage', '已完成分析'],
    running: ['badge-amber', '分析中'],
    queued: ['badge-amber', '排队中'],
    failed: ['badge-danger', '分析失败'],
    none: ['', '尚未分析'],
  };
  const [cls, label] = map[s] || map.none;
  return h(`span.badge.${cls || 'badge'}` + (cls ? '.badge-dot' : ''), { text: label });
}

/* ------------------------------------------------------- overview */
function renderOverviewTab(id, data) {
  const p = data.persona;
  const prof = data.profile;
  const stats = prof?._meta?.styleStats;

  const left = h('div.col.gap-16');

  if (!prof) {
    left.append(h('div.card.empty-rich', { style: { textAlign: 'center', padding: '38px 24px' } },
      emptyArt('noPersona', { size: 116 }),
      h('h3', { style: { margin: '14px 0 8px' }, text: '还没有人格档案' }),
      h('p.small.muted', { style: { maxWidth: '44ch', margin: '0 auto 18px' },
        text: p.importedMessages > 0
          ? '聊天记录已就位。运行分析后，系统会提取语言风格、性格特征与共同记忆。'
          : '先导入你和 TA 的聊天记录，系统才能分析出对方的表达习惯。' }),
      h('div.row.gap-8', { style: { justifyContent: 'center' } },
        p.importedMessages > 0
          ? h('a.btn.btn-copper', { href: `/app/personas/${id}/analysis` }, '运行人格分析')
          : h('a.btn.btn-copper', { href: `/app/personas/${id}/import` }, '导入聊天记录')
      )
    ));
  } else {
    left.append(h('div.card',
      h('div.card-title', { text: '人物画像' }),
      h('p', { style: { fontSize: '0.95rem', lineHeight: '1.72', color: 'var(--ink-2)' }, text: prof.summary || '（无摘要）' }),
      prof.caution_notes
        ? h('div', {
            style: {
              marginTop: '14px', padding: '10px 13px', background: 'var(--amber-soft)',
              borderRadius: '8px', fontSize: '0.8rem', color: 'var(--amber)', lineHeight: '1.6',
            },
          }, `分析局限：${prof.caution_notes}`)
        : null
    ));

    // style
    const ls = prof.language_style || {};
    left.append(h('div.card',
      h('div.card-title', { text: '语言风格' }),
      h('dl.kv',
        ls.tone ? [h('dt', { text: '语气' }), h('dd', { text: ls.tone })] : null,
        ls.sentence_pattern ? [h('dt', { text: '句式' }), h('dd', { text: ls.sentence_pattern })] : null,
        ls.punctuation_habit ? [h('dt', { text: '标点习惯' }), h('dd', { text: ls.punctuation_habit })] : null,
        ls.reply_rhythm ? [h('dt', { text: '回复节奏' }), h('dd', { text: ls.reply_rhythm })] : null,
        ls.initiative ? [h('dt', { text: '主动性' }), h('dd', { text: ls.initiative })] : null
      ),
      ls.catchphrases?.length
        ? h('div.mt-16',
            h('div.label.mb-8', { text: '口头禅' }),
            h('div.row-wrap.gap-8',
              ...ls.catchphrases.map((c) => h('span.badge.badge-copper', { text: c })))
          )
        : null,
      ls.favorite_words?.length
        ? h('div.mt-16',
            h('div.label.mb-8', { text: '常用词' }),
            h('div.row-wrap.gap-8',
              ...ls.favorite_words.map((c) => h('span.badge', { text: c })))
          )
        : null,
      stats ? h('div.mt-16',
        h('div.label.mb-8', { text: '客观统计' }),
        h('div.row-wrap.gap-16',
          statPill('平均句长', `${stats.avgLength} 字`),
          statPill('中位句长', `${stats.medianLength} 字`),
          statPill('短句占比', `${stats.shortRatio}%`),
          statPill('表情符号', `${stats.emojiRatio}%`),
          statPill('问句占比', `${stats.questionRatio}%`),
          statPill('句末无标点', `${stats.noEndPunctRatio}%`)
        )
      ) : null
    ));

    // personality
    const pe = prof.personality || {};
    left.append(h('div.card',
      h('div.card-title', { text: '性格与交流（基于文本的推测）' }),
      pe.traits?.length
        ? h('div.col.gap-8.mb-16',
            ...pe.traits.map((t) => h('div',
              { style: { display: 'flex', gap: '10px', alignItems: 'baseline' } },
              h('span.badge.badge-copper.nowrap', { text: t.trait }),
              h('span.small.muted.grow', { text: t.evidence || '（无具体证据）' }),
              h('span.tiny.dim.nowrap', { text: `${Math.round(t.confidence * 100)}%` })
            ))
          )
        : null,
      h('dl.kv',
        pe.humor ? [h('dt', { text: '幽默' }), h('dd', { text: pe.humor })] : null,
        pe.emotion_expression ? [h('dt', { text: '情绪表达' }), h('dd', { text: pe.emotion_expression })] : null,
        pe.communication_style ? [h('dt', { text: '交流方式' }), h('dd', { text: pe.communication_style })] : null,
        pe.with_familiar ? [h('dt', { text: '对熟人' }), h('dd', { text: pe.with_familiar })] : null
      ),
      pe.topic_reactions?.length
        ? h('div.mt-16',
            h('div.label.mb-8', { text: '话题反应' }),
            h('div.col.gap-4',
              ...pe.topic_reactions.map((t) => h('div.small',
                h('b', { text: t.topic }),
                h('span.muted', { text: ` — ${t.reaction}` })
              ))
            )
          )
        : null
    ));

    // relationship
    const rm = prof.relationship_memory || {};
    const relItems = [
      ...(rm.shared_experiences || []).map((x) => ['共同经历', x.content]),
      ...(rm.important_events || []).map((x) => ['重要事件', x.content]),
      ...(rm.preferences || []).map((x) => ['偏好', x.content]),
      ...(rm.agreements || []).map((x) => ['约定', x.content]),
      ...(rm.nicknames || []).map((x) => ['称呼', `${x.term}${x.context ? `（${x.context}）` : ''}`]),
    ];
    if (relItems.length || rm.common_topics?.length || rm.key_quotes?.length) {
      left.append(h('div.card',
        h('div.card-title', { text: '你们之间的历史' }),
        relItems.length
          ? h('div', ...relItems.slice(0, 30).map(([k, v]) => h('div.mem-item',
              h('span.kind', { text: k }),
              h('div.txt', { text: v })
            )))
          : null,
        rm.common_topics?.length
          ? h('div.mt-16',
              h('div.label.mb-8', { text: '常聊话题' }),
              h('div.row-wrap.gap-8', ...rm.common_topics.map((t) => h('span.badge', { text: t }))))
          : null,
        rm.key_quotes?.length
          ? h('div.mt-16',
              h('div.label.mb-8', { text: '原话样本' }),
              h('div.col.gap-4',
                ...rm.key_quotes.slice(0, 6).map((q) => h('div.small', {
                  style: { fontStyle: 'italic', color: 'var(--ink-2)', paddingLeft: '12px', borderLeft: '2px solid var(--line)' },
                  text: `「${q}」`,
                }))
              ))
          : null
      ));
    }
  }
  left.append(h('a.btn.btn-outline-copper', { href: `/app/personas/${id}/profile` }, '查看完整档案（可编辑）'));

  const right = h('div.col.gap-16',
    h('div.card.card-tight',
      h('div.card-title', { text: '状态' }),
      h('dl.kv',
        h('dt', { text: '分析' }), h('dd', analysisBadge(p.analysisStatus)),
        h('dt', { text: '更新时间' }), h('dd', { text: p.analyzedAt ? fmtRelative(p.analyzedAt) : '—' }),
        h('dt', { text: '记录区间' }),
        h('dd', { text: p.firstTs ? `${fmtDate(p.firstTs)} → ${fmtDate(p.lastTs)}` : '—' }),
        h('dt', { text: '模仿强度' }),
        h('dd', { text: { free: '自由模式', natural: '自然模仿', high: '高度模仿' }[p.similarityMode] || '自然模仿' })
      )
    ),
    h('div.card.card-tight',
      h('div.card-title', { text: '快捷操作' }),
      h('div.col.gap-8',
        h('a.btn.btn-sm', { href: `/app/personas/${id}/import` }, '管理聊天记录'),
        h('a.btn.btn-sm', { href: `/app/personas/${id}/analysis` }, p.analysisStatus === 'ready' ? '重新分析' : '运行分析'),
        h('a.btn.btn-sm', { href: `/app/personas/${id}/memories` }, '管理长期记忆'),
        h('a.btn.btn-sm', { href: `/app/chat/${id}` }, '打开对话'),
        h('a.btn.btn-sm', { href: `/app/personas/${id}/settings` }, '设置与删除')
      )
    ),
    p.description
      ? h('div.card.card-tight',
          h('div.card-title', { text: '你填写的描述' }),
          h('p.small.muted', { style: { whiteSpace: 'pre-wrap', margin: 0 }, text: p.description })
        )
      : null
  );

  return h('div.two-col', left, right);
}

function statPill(label, value) {
  return h('div', { style: { minWidth: '78px' } },
    h('div.tiny.dim', { text: label }),
    h('div', { style: { fontSize: '1.02rem', fontWeight: '650', fontFamily: 'var(--serif)' }, text: value })
  );
}

/* --------------------------------------------------------- import */
async function renderImportTab(id, data) {
  const wrap = h('div.col.gap-16');
  const safe = state.config.maxUploadMb || 50;

  const drop = h('div.drop',
    h('span.ic', { text: '⇪' }),
    h('h4', { text: '拖拽文件到这里，或点击选择' }),
    h('p', { text: `支持 TXT / JSON / CSV / Markdown / ZIP · 单次上限 ${safe}MB · 可多选` })
  );
  const input = h('input', {
    type: 'file', multiple: true, accept: '.txt,.log,.json,.csv,.tsv,.md,.markdown,.zip',
    style: { display: 'none' },
  });
  const fileList = h('div.col.gap-8');
  const resultBox = h('div');
  let pending = [];

  const renderFiles = () => {
    fileList.replaceChildren(...pending.map((f, i) => h('div.file-row',
      h('span', { style: { color: 'var(--copper)' }, text: '▤' }),
      h('span.nm', { text: f.name }),
      h('span.sz', { text: fmtBytes(f.size) }),
      h('button.btn.btn-ghost.btn-icon.btn-sm', {
        type: 'button', 'aria-label': '移除',
        onclick: () => { pending.splice(i, 1); renderFiles(); syncActionBar(); },
      }, '✕')
    )));
    // 选好文件后「导入」按钮才会出现。
    // 早期这里是 `pending.length ? h(...) : null`，在页面构建时求值一次，
    // 于是选了文件也不会长出按钮 —— 用户看到的就是「选了文件没反应」。
  };

  const addFiles = (files) => {
    for (const f of files) {
      if (pending.some((x) => x.name === f.name && x.size === f.size)) continue;
      if (f.size > safe * 1024 * 1024) { toast(`${f.name} 超过 ${safe}MB 限制`, 'err'); continue; }
      pending.push(f);
    }
    renderFiles();
    syncActionBar();
  };

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    addFiles([...e.dataTransfer.files]);
  });

  const progress = h('div.hidden', { style: { marginTop: '4px' } },
    h('div.progress-line', h('i', { style: { width: '0%' } })),
    h('div.tiny.dim.mt-8', { text: '' })
  );

  const personaSenderSel = h('select', {}, h('option', { value: '' }, '自动判断（选发言最多的一方）'));
  const previewBox = h('div');

  // 动作区（文件列表 + 预览/导入按钮）必须随 pending 变化而重绘。
  // 早期它写成 `pending.length ? <节点> : null`，只在页面构建那一刻求值，
  // 所以用户选完文件后按钮永远不出现，点无可点 —— 「导入没反应」的表象。
  const actionBar = h('div.col.gap-8.mt-16');

  const syncActionBar = () => {
    if (!pending.length) { actionBar.replaceChildren(); return; }
    actionBar.replaceChildren(
      fileList,
      h('div.row.gap-8',
        h('button.btn.btn-sm', { type: 'button', onclick: doPreview }, '先预览解析结果'),
        h('button.btn.btn-copper.btn-sm', { type: 'button', onclick: doImport }, `导入 ${pending.length} 个文件`)
      ),
      h('div.field.mt-16',
        h('label', { text: '复刻对象' }),
        personaSenderSel,
        h('div.hint', { text: '指定这份记录里哪一方是你想复刻的人。导入后也可以随时修改。' })
      ),
      progress
    );
  };

  const doPreview = async () => {
    if (!pending.length) { toast('请先选择文件', 'err'); return; }
    previewBox.replaceChildren(h('div.card', h('div.row', h('span.spin'), h('span.muted.small', { text: ' 正在解析预览…' }))));
    const fd = new FormData();
    for (const f of pending) fd.append('files', f, f.name);
    try {
      const r = await api.form(`/api/personas/${id}/imports/preview`, fd);
      previewBox.replaceChildren(previewResult(id, r, personaSenderSel, pending, () => {
        previewBox.replaceChildren();
        pending = [];
        renderFiles();
        syncActionBar();
        navigate(`/app/personas/${id}/import`);
      }));
      // populate sender selector
      const cur = personaSenderSel.value;
      personaSenderSel.replaceChildren(
        h('option', { value: '' }, '自动判断（选发言最多的一方）'),
        ...r.senders.map((s) => h('option', { value: s.name }, `${s.name} — ${s.count} 条`))
      );
      personaSenderSel.value = cur;
      previewBox.querySelector('.preview-result')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      previewBox.replaceChildren(h('div.card', { style: { borderColor: '#e4c3bb', background: 'var(--danger-soft)' } },
        h('div.small', { style: { color: 'var(--danger)' }, text: e.message })));
    }
  };

  // import list
  // 导入列表。字段名容错：后端历史上直接返回 snake_case，导致这里读到的
  // originalName / total / added 全是 undefined，页面上就只剩空字符串和 "null"。
  // 现在后端已改成 camelCase，这里再兜一层，任何一端漏改都不会把 undefined 印到界面上。
  const impName = (r) => r.originalName || r.original_name || '未命名文件';
  const impNum = (r, a, b) => {
    const v = r[a] !== undefined && r[a] !== null ? r[a] : r[b];
    return Number.isFinite(Number(v)) ? Number(v) : 0;
  };
  const impTime = (r) => r.createdAt ?? r.created_at ?? null;

  const importRows = data.imports.length
    ? h('div.card.card-tight',
        h('div.card-title', { text: `已导入文件（${data.imports.length}）` }),
        h('div.col.gap-4',
          ...data.imports.map((imp) => h('div.sender-row',
            h('span', { style: { color: imp.status === 'parsed' ? 'var(--sage)' : 'var(--danger)' }, text: imp.status === 'parsed' ? '✓' : '!' }),
            h('div.grow', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: '0.87rem', fontWeight: '550' }, text: impName(imp) }),
              h('div.tiny.dim', {
                text: [
                  impTime(imp) ? fmtDate(impTime(imp)) : null,
                  `${impNum(imp, 'total', 'message_total')} 条`,
                  `新增 ${impNum(imp, 'added', 'message_new')}`,
                  impNum(imp, 'duplicates', 'message_dup') ? `重复 ${impNum(imp, 'duplicates', 'message_dup')}` : null,
                  imp.error || null,
                ].filter(Boolean).join(' · '),
              })
            ),
            h('button.btn.btn-ghost.btn-icon.btn-sm', {
              type: 'button', 'aria-label': '删除',
              onclick: async () => {
                const withMsgs = await confirmDialog({
                  title: '删除这条导入记录？',
                  message: '仅删除记录本身（保留已导入的消息）。如果要连同消息一起删除，请使用下方的「清空聊天记录」。',
                  confirmLabel: '删除记录',
                });
                if (!withMsgs) return;
                await api.del(`/api/imports/${imp.id}`);
                toast('已删除');
                navigate(`/app/personas/${id}/import`);
              },
            }, '✕')
          ))
        )
      )
    : null;

  // sender mapping —— 发送者列表来自独立端点，人格详情接口不返回它
  const senders = await api.get(`/api/personas/${id}/senders`)
    .then((r) => (Array.isArray(r?.senders) ? r.senders : []))
    .catch(() => []);
  const senderCard = senders.length
    ? h('div.card.card-tight',
        h('div.card-title', { text: '发送者映射' }),
        h('p.tiny.dim.mb-16', { text: '把目标人物的发言标记为「复刻对象」。这是分析准确与否的关键一步。' }),
        h('div', ...senders.map((s) => h('div.sender-row',
          h('div.nm', { text: s.name }),
          h('span.cnt', { text: `${s.count} 条` }),
          h('div.btn-group',
            h('button.btn.btn-sm', {
              type: 'button', 'aria-pressed': String(s.role !== 'persona'),
              onclick: async (e) => {
                await api.post(`/api/personas/${id}/senders`, { mapping: { [s.name]: 'user' } });
                toast(`${s.name} 标记为我`);
                navigate(`/app/personas/${id}/import`);
              },
            }, '我'),
            h('button.btn.btn-sm', {
              type: 'button', 'aria-pressed': String(s.role === 'persona'),
              onclick: async () => {
                await api.post(`/api/personas/${id}/senders`, { mapping: { [s.name]: 'persona' } });
                toast(`${s.name} 标记为复刻对象`);
                navigate(`/app/personas/${id}/import`);
              },
            }, '复刻对象')
          )
        )))
      )
    : null;

  const doImport = async () => {
    if (!pending.length) { toast('请先选择文件', 'err'); return; }
    const fd = new FormData();
    for (const f of pending) fd.append('files', f, f.name);
    if (personaSenderSel.value) fd.append('personaSender', personaSenderSel.value);

    progress.classList.remove('hidden');
    const bar = progress.querySelector('i');
    const lbl = progress.querySelector('.tiny');
    lbl.textContent = '上传中…';

    let r;
    try {
      r = await api.form(`/api/personas/${id}/imports`, fd, {
        onProgress: (p) => {
          bar.style.width = `${Math.round(p * 60)}%`;
          lbl.textContent = `上传中 ${Math.round(p * 100)}%`;
        },
      });
    } catch (e) {
      progress.classList.add('hidden');
      toast(e.message, 'err');
      return;
    }

    /* 服务端现在立刻返回 202 + jobId，真正的解析与入库在后台跑。
     * 上传只占整个进度的前 60%，剩下 40% 用来展示服务端处理进度 ——
     * 因为上传完成不等于导入完成，把两者混成一条进度条会让人以为已经好了。 */
    if (!r.jobId) {
      // 兼容旧返回（同步完成）
      bar.style.width = '100%';
      lbl.textContent = r.message;
      toast(r.message, r.added > 0 ? 'ok' : '');
      setTimeout(() => navigate(`/app/personas/${id}/import`), 700);
      return;
    }

    const startedAt = Date.now();
    const TIMEOUT_MS = 15 * 60 * 1000;
    let fails = 0;
    let stopped = false;

    const stop = () => { stopped = true; clearInterval(poll); };

    const poll = setInterval(async () => {
      if (stopped) return;
      if (Date.now() - startedAt > TIMEOUT_MS) {
        stop();
        progress.classList.add('hidden');
        toast('导入超时，请稍后刷新页面查看结果', 'err');
        return;
      }
      try {
        const j = await api.get(`/api/jobs/${r.jobId}`);
        fails = 0;
        const job = j.job || {};
        const pct = 60 + Math.round((job.progress || 0) * 40);
        bar.style.width = `${Math.min(pct, 100)}%`;
        if (job.stage) lbl.textContent = job.stage;

        if (job.status === 'done') {
          stop();
          bar.style.width = '100%';
          const res = job.result || {};
          lbl.textContent = res.message || '导入完成';
          toast(res.message || '导入完成', (res.added || 0) > 0 ? 'ok' : '');
          setTimeout(() => navigate(`/app/personas/${id}/import`), 800);
        } else if (job.status === 'failed') {
          stop();
          progress.classList.add('hidden');
          toast(`导入失败：${job.error || '未知错误'}`, 'err');
        }
      } catch (e) {
        fails += 1;
        lbl.textContent = `读取进度失败（第 ${fails} 次），正在重试…`;
        if (fails >= 5) {
          stop();
          progress.classList.add('hidden');
          toast(`无法读取导入进度：${e.message}`, 'err');
        }
      }
    }, 1000);
  };

  // 用 h() 而不是原生 append()：原生 append() 会把 null/undefined 当成文本节点
  // 插进 DOM，页面上就出现字面量 "null"。h() 会跳过这些假值。
  // 这里 senderCard / importRows 在「没有发送者 / 没有导入记录」时都是 null，
  // 早期直接 wrap.append(...) 导致空人格的导入页上挂了三个 "null"。
  wrap.append(...[
    h('div.card',
      h('div.card-title', { text: '上传聊天记录' }),
      drop,
      input,
      actionBar,
      previewBox
    ),
    senderCard,
    importRows,
    h('div.card.card-tight',
      h('div.card-title', { text: '格式说明' }),
      h('p.small.muted.mb-8', { text: '每种格式的解析规则不同，导错格式会被误判。请对照下面的说明：' }),
      h('div.col.gap-8',
        fmtRow('TXT', '每行消息以日期时间开头，发送者在下一行或同一行冒号前。支持微信 PC 版、QQ 导出格式。'),
        fmtRow('JSON', '数组，或包含 messages / data / records / list 键的对象。每条需有 sender + content 字段（键名容错）。'),
        fmtRow('CSV', '需要有表头，至少包含 sender / content 两列；时间列可选。逗号、Tab、分号自动识别。'),
        fmtRow('Markdown', '支持 **昵称**: 内容 或 ## 昵称 分节两种写法。'),
        fmtRow('ZIP', '打包多个上述文件，安全解压后逐个解析。')
      ),
      h('div.divider'),
      h('p.tiny.dim.mb-8', { text: '不支持的情况，请先在原软件里转换：' }),
      h('ul.small.muted', { style: { paddingLeft: '18px', margin: '0' } },
        h('li', { text: '微信 .db / .dat 加密数据库 → 用 PC 版微信「导出聊天记录」保存为 TXT 再上传。' }),
        h('li', { text: 'QQ 的 .db → 用 QQ 消息管理器「导出为 txt/mht」。' }),
        h('li', { text: '截图或图片聊天记录 → 本系统不做 OCR，需要先转成文字。' })
      ),
      h('div.mt-16.row.gap-8',
        h('a.btn.btn-sm', { href: '/api/samples/txt', download: '' }, '下载 TXT 示例'),
        h('a.btn.btn-sm', { href: '/api/samples/json', download: '' }, '下载 JSON 示例'),
        h('a.btn.btn-sm', { href: '/api/samples/csv', download: '' }, '下载 CSV 示例')
      )
    ),
    data.imports.length
      ? h('div.card.card-tight',
          h('div.card-title', { text: '危险操作' }),
          h('div.between',
            h('div',
              h('div.small', { text: '清空全部导入的聊天记录' }),
              h('div.tiny.dim', { text: '删除该人格下所有导入消息与记忆。人格本身保留。' })
            ),
            h('button.btn.btn-danger.btn-sm', {
              type: 'button',
              onclick: async () => {
                if (!await confirmDialog({
                  title: '确定清空聊天记录？',
                  message: '将删除该人格下所有已导入的消息、对话片段索引与由分析生成的记忆。此操作不可撤销。',
                  confirmLabel: '清空',
                  danger: true,
                })) return;
                // delete via imports API with messages
                for (const imp of data.imports) {
                  await api.del(`/api/imports/${imp.id}?withMessages=1`).catch(() => {});
                }
                toast('已清空');
                navigate(`/app/personas/${id}/import`);
              },
            }, '清空记录')
          )
        )
      : null,
  ].filter(Boolean));

  return wrap;
}

function fmtRow(name, desc) {
  return h('div', { style: { display: 'flex', gap: '12px', alignItems: 'baseline' } },
    h('span.badge.nowrap', { text: name }),
    h('span.small.muted', { text: desc })
  );
}

function previewResult(id, r, senderSel, pending, onDone) {
  const okFiles = r.results.filter((x) => !x.error);
  const badFiles = r.results.filter((x) => x.error);

  return h('div.preview-result.card.mt-16', { style: { borderColor: '#d7c9ba', background: 'var(--paper-2)' } },
    h('div.card-title', { text: '解析预览（尚未保存）' }),
    h('div.row-wrap.gap-8.mb-16',
      h('span.badge.badge-sage', { text: `${okFiles.length} 个文件可解析` }),
      badFiles.length ? h('span.badge.badge-danger', { text: `${badFiles.length} 个文件失败` }) : null,
      h('span.badge', { text: `共 ${okFiles.reduce((a, x) => a + x.messages.length, 0)} 条消息` })
    ),
    badFiles.length
      ? h('div.col.gap-8.mb-16',
          ...badFiles.map((f) => h('div', {
            style: { padding: '9px 12px', background: 'var(--danger-soft)', borderRadius: '8px', fontSize: '0.82rem', color: 'var(--danger)' },
          }, h('b', { text: f.name }), h('div', { text: f.error })))
        )
      : null,
    okFiles.length
      ? h('div',
          h('div.label.mb-8', { text: '识别到的发送者' }),
          h('div.row-wrap.gap-8.mb-16',
            ...(r.senders || []).map((s) => h('span.badge.badge-copper', { text: `${s.name} · ${s.count}` }))
          ),
          h('div.label.mb-8', { text: '消息样例' }),
          h('div', { style: { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '9px', padding: '12px 14px', maxHeight: '260px', overflowY: 'auto' } },
            ...(r.preview || []).map((m) => h('div', { style: { marginBottom: '8px', fontSize: '0.83rem' } },
              h('b', { style: { color: 'var(--copper-deep)' }, text: `${m.sender || '未知'}：` }),
              h('span', { style: { color: 'var(--ink-2)' }, text: m.content }),
              m.ts ? h('span.tiny.dim', { text: ` · ${fmtDate(m.ts)}` }) : null
            ))
          ),
          h('div.row.gap-8.mt-16',
            h('button.btn.btn-copper', {
              type: 'button',
              onclick: async () => {
                const fd = new FormData();
                for (const f of pending) fd.append('files', f, f.name);
                if (senderSel.value) fd.append('personaSender', senderSel.value);
                /* 服务端改为异步 job：立刻返回 202 + jobId。
                 * 这里不阻塞等待入库完成，直接告诉用户「已开始」并跳到导入记录页，
                 * 那里能看到「解析中」状态，完成后自动变成完成 —— 用户不用盯着转圈。 */
                try {
                  const res = await api.form(`/api/personas/${id}/imports`, fd);
                  toast(res.async ? '已开始导入，可在列表中查看进度' : (res.message || '导入完成'), 'ok');
                  setTimeout(() => navigate(`/app/personas/${id}/import`), 600);
                } catch (e) { toast(e.message, 'err'); }
              },
            }, '确认导入'),
            h('button.btn', { type: 'button', onclick: () => document.querySelector('.preview-result')?.remove() }, '取消')
          )
        )
      : null
  );
}

/* ------------------------------------------------------- analysis */
async function renderAnalysisTab(id, data) {
  const wrap = h('div.col.gap-16');
  const p = data.persona;

  const statusCard = h('div.card');
  const runBox = h('div');

  const render = () => {
    const s = p.analysisStatus;
    // replaceChildren() 和 append() 一样是原生方法，会把 null 印成字面量 "null"。
    // 「上次分析失败」的提示块在没有错误信息时是 null，页面就多出一个 null。
    statusCard.replaceChildren(...[
      h('div.card-title', { text: '人格分析' }),
      h('div.between.mb-16',
        h('div',
          h('div', { style: { fontSize: '0.95rem', fontWeight: '600' }, text:
            { ready: '分析已完成', running: '正在分析…', queued: '排队中', failed: '上次分析失败', none: '尚未运行分析' }[s] }),
          h('div.tiny.dim', { text: p.analyzedAt ? `上次完成：${fmtRelative(p.analyzedAt)}` : '分析会调用你配置的大模型，产生相应费用' })
        ),
        analysisBadge(s)
      ),
      s === 'failed' && p.analysisError
        ? h('div.mb-16', {
            style: { padding: '10px 13px', background: 'var(--danger-soft)', borderRadius: '8px', fontSize: '0.82rem', color: 'var(--danger)' },
          }, p.analysisError)
        : null,
      h('div.row.gap-8',
        h('button.btn.btn-copper', {
          type: 'button',
          disabled: !p.importedMessages,
          onclick: () => runAnalysis(id, runBox, () => { navigate(`/app/personas/${id}/analysis`); }),
        }, s === 'ready' ? '重新分析' : '开始分析'),
        p.importedMessages ? null : h('span.tiny.dim', { text: '需要先导入聊天记录' })
      ),
    ].filter(Boolean));
  };
  render();

  // stats preview
  let statBlock = null;
  if (p.importedMessages > 0) {
    try {
      const st = await api.get(`/api/personas/${id}/style-stats`);
      if (st.stats) {
        statBlock = h('div.card',
          h('div.card-title', { text: '本地风格统计（不消耗 API）' }),
          h('p.small.muted.mb-16', { text: `${st.description}` }),
          h('div.row-wrap.gap-16',
            statPill('样本数', String(st.sampleCount)),
            statPill('平均句长', `${st.stats.avgLength} 字`),
            statPill('短句占比', `${st.stats.shortRatio}%`),
            statPill('表情比例', `${st.stats.emojiRatio}%`),
            statPill('问句比例', `${st.stats.questionRatio}%`),
            statPill('省略号', `${st.stats.ellipsisRatio}%`)
          ),
          st.stats.fillers?.length
            ? h('div.mt-16', h('div.label.mb-8', { text: '高频语气词' }),
                h('div.row-wrap.gap-8', ...st.stats.fillers.slice(0, 12).map((f) =>
                  h('span.badge', { text: `${f.word} · ${f.count}` }))))
            : null,
          st.stats.commonPhrases?.length
            ? h('div.mt-16', h('div.label.mb-8', { text: '高频短语' }),
                h('div.row-wrap.gap-8', ...st.stats.commonPhrases.slice(0, 14).map((f) =>
                  h('span.badge.badge-copper', { text: f.word }))))
            : null
        );
      }
    } catch { /* ignore */ }
  }

  const llmNote = h('div.card.card-tight', { style: { background: 'var(--paper-2)' } },
    h('div.card-title', { text: '分析会做什么' }),
    h('ol.small.muted', { style: { paddingLeft: '18px', margin: 0, lineHeight: '1.8' } },
      h('li', { text: '从聊天记录中分层抽样对方的发言（默认最多 160 条，覆盖整个时间线）。' }),
      h('li', { text: '本地先算出客观统计：句长、标点、语气词频率、emoji 比例。' }),
      h('li', { text: '把统计结果 + 原话样本 + 真实问答回合一起交给你的大模型。' }),
      h('li', { text: '模型输出严格 JSON 档案：语言风格、性格推测（带证据与可信度）、关系记忆。' }),
      h('li', { text: '档案中的记忆条目自动写入长期记忆库，并建立对话片段索引。' })
    ),
    h('div.divider'),
    h('p.tiny.dim', { style: { margin: 0 }, text: '样本不足时（少于 30 条对方发言），结果可信度会明显下降，系统会在档案里注明。' })
  );

  // 同上：statBlock 在没有导入消息时是 null，用原生 append() 会印出 "null"。
  wrap.append(...[statusCard, runBox, statBlock, llmNote].filter(Boolean));
  return wrap;
}

/**
 * 发起人格分析。
 *
 * 两条通道：
 *   A. 自备 Key：一次 POST，服务端自己调模型，前端轮询 job 进度。
 *   B. 云模型（免 Key）：服务端不能代调（会变成开放代理），所以走
 *      prepare（服务端组装并暂存提示词）→ 浏览器 SDK 直连生成 → commit 落库。
 *      浏览器只拿到 messages 和指纹，改不了提示词；服务端靠指纹校验。
 *
 * 以前只有 A，于是「只开了云模型」的账号会收到一句
 * 「请先在 API 配置中添加默认大模型」—— 而他其实已经开了云模型，
 * 只是那条路不需要 Key。这是本轮修掉的核心问题之一。
 */
async function runAnalysis(id, box, onDone) {
  const bar = h('i', { style: { width: '3%' } });
  const lbl = h('div.tiny.dim.mt-8', { text: '准备中…' });
  const pct = h('span.tiny.dim.mono', { text: '0%' });
  const setProg = (p, text) => {
    bar.style.width = `${Math.max(3, Math.round(p * 100))}%`;
    pct.textContent = `${Math.round(p * 100)}%`;
    if (text) lbl.textContent = text;
  };
  box.replaceChildren(h('div.card',
    h('div.between.mb-16',
      h('div.row', h('span.spin'), h('b', { style: { fontSize: '0.9rem' }, text: ' 正在分析…' })),
      pct
    ),
    h('div.progress-line', bar),
    lbl,
    h('div.tiny.dim.mt-8', { text: '分析会读取你导入的聊天记录，通常需要 20 秒到 2 分钟。可以留在本页，也可以稍后回来查看。' })
  ));

  let r;
  try {
    r = await api.post(`/api/personas/${id}/analyze`);
  } catch (e) {
    box.replaceChildren(h('div.card', { style: { borderColor: '#e4c3bb', background: 'var(--danger-soft)' } },
      h('div.small', { style: { color: 'var(--danger)' }, text: e.message || '分析启动失败' }),
      e.code === 'NO_LLM' || e.code === 'NO_API_KEY'
        ? h('a.btn.btn-sm.mt-8', { href: '/app/settings/keys' }, '去配置 API Key')
        : null));
    return;
  }

  // 轮询进度。历史上这里用的是 `catch { /* keep polling */ }`，
  // 一旦 /api/jobs/:id 出错就永远停在 5%，用户看到的就是「卡住了」。
  // 现在：连续失败会明确报出来，并且有总超时兜底。
  const startedAt = Date.now();
  const TIMEOUT_MS = 6 * 60 * 1000;
  let fails = 0;
  let stopped = false;

  const finish = (node) => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    box.replaceChildren(node);
  };

  const poll = setInterval(async () => {
    if (stopped) return;
    if (Date.now() - startedAt > TIMEOUT_MS) {
      finish(h('div.card', { style: { borderColor: '#e4c3bb', background: 'var(--danger-soft)' } },
        h('div.small', { style: { color: 'var(--danger)' }, text: '分析超时（超过 6 分钟）。可能是模型响应太慢，或网络不通。请稍后在「人格分析」页查看结果，或换个模型重试。' })));
      return;
    }
    try {
      const j = await api.get(`/api/jobs/${r.jobId}`);
      fails = 0;
      const job = j.job || {};
      setProg(job.progress || 0, job.stage);

      if (job.status === 'done') {
        toast('分析完成', 'ok');
        finish(h('div.card', h('div.row', h('b', { text: '✓ 分析完成' }))));
        onDone?.();
      } else if (job.status === 'failed') {
        finish(h('div.card', { style: { borderColor: '#e4c3bb', background: 'var(--danger-soft)' } },
          h('div.small', { style: { color: 'var(--danger)' }, text: `分析失败：${job.error || '未知错误'}` }),
          h('div.tiny.dim.mt-8', { text: '常见原因：模型名不存在、Key 无权限、余额不足。可到「API 配置」点「测试」确认连通性。' })));
      }
    } catch (e) {
      fails++;
      lbl.textContent = `读取进度失败（第 ${fails} 次），正在重试…`;
      if (fails >= 5) {
        finish(h('div.card', { style: { borderColor: '#e4c3bb', background: 'var(--danger-soft)' } },
          h('div.small', { style: { color: 'var(--danger)' }, text: `无法读取任务进度：${e.message}` })));
      }
    }
  }, 1200);
}


/* ------------------------------------------------------- memories */
async function renderMemoriesTab(id, data) {
  const wrap = h('div.col.gap-16');
  const listBox = h('div');
  const search = h('input', { type: 'search', placeholder: '搜索记忆内容…' });

  const kindLabels = {
    fact: '事实', event: '经历', topic: '话题', preference: '偏好',
    agreement: '约定', nickname: '称呼', quote: '口头禅', other: '其他',
  };

  let currentKind = '';

  const load = async () => {
    listBox.replaceChildren(h('div.card', h('div.row', h('span.spin'), h('span.small.muted', { text: ' 加载中…' }))));
    try {
      const r = await api.get(`/api/personas/${id}/memories`, {
        q: search.value.trim(), kind: currentKind, limit: 200,
      });
      if (!r.memories.length) {
        listBox.replaceChildren(h('div.empty.empty-rich',
          emptyArt('noImport'),
          h('h3', { text: search.value ? '没有匹配的记忆' : '还没有长期记忆' }),
          h('p', { text: search.value ? '换个关键词试试。' : '运行人格分析后会自动生成记忆，也可以手动添加。' })
        ));
        return;
      }
      listBox.replaceChildren(h('div.card.card-tight',
        h('div.tiny.dim.mb-16', { text: `共 ${r.total} 条，显示 ${r.memories.length} 条` }),
        ...r.memories.map((m) => h('div.mem-item',
          h('span.kind', { text: kindLabels[m.kind] || m.kind }),
          h('div.txt',
            m.content,
            h('span.salience', ...Array.from({ length: 5 }, (_, i) =>
              h('i' + (i < m.salience ? '.on' : '')))),
            m.confidence < 0.8
              ? h('span.tiny.dim', { text: ` 可信度 ${Math.round(m.confidence * 100)}%` })
              : null,
            m.sourceType === 'manual'
              ? h('span.badge', { style: { marginLeft: '8px' }, text: '手动' })
              : null
          ),
          h('div.side',
            h('button.btn.btn-ghost.btn-icon.btn-sm', {
              type: 'button', 'aria-label': '编辑',
              onclick: () => editMemory(id, m, load),
            }, '✎'),
            h('button.btn.btn-ghost.btn-icon.btn-sm', {
              type: 'button', 'aria-label': '删除',
              onclick: async () => {
                if (!await confirmDialog({ title: '删除这条记忆？', message: m.content, confirmLabel: '删除', danger: true })) return;
                await api.del(`/api/memories/${m.id}`);
                toast('已删除');
                load();
              },
            }, '✕')
          )
        ))
      ));
    } catch (e) {
      listBox.replaceChildren(h('div.card', { style: { color: 'var(--danger)' }, text: e.message }));
    }
  };

  search.addEventListener('input', debounceTimer(load, 350));

  const kindBar = h('div.pill-tabs',
    h('button', { type: 'button', 'aria-selected': 'true', onclick: (e) => { currentKind = ''; syncKinds(e); load(); } }, '全部'),
    ...Object.entries(kindLabels).map(([k, label]) => h('button', {
      type: 'button', 'aria-selected': 'false',
      onclick: (e) => { currentKind = k; syncKinds(e); load(); },
    }, label))
  );
  const syncKinds = (e) => {
    for (const b of kindBar.querySelectorAll('button')) b.setAttribute('aria-selected', 'false');
    e.currentTarget.setAttribute('aria-selected', 'true');
  };

  const addForm = h('div.card.card-tight',
    h('div.card-title', { text: '手动添加记忆' }),
    h('div.col.gap-8',
      (() => {
        const ta = h('textarea', { rows: 2, placeholder: '例如：她最讨厌别人说「随便」，因为觉得那是敷衍。' });
        const kindSel = h('select', { style: { maxWidth: '150px' } },
          ...Object.entries(kindLabels).map(([k, l]) => h('option', { value: k }, l)));
        const sal = h('input', { type: 'range', min: 1, max: 5, value: 3, style: { maxWidth: '140px' } });
        const addBtn = h('button.btn.btn-copper.btn-sm', {
          type: 'button',
          onclick: async () => {
            const content = ta.value.trim();
            if (!content) { toast('请填写内容', 'err'); return; }
            addBtn.disabled = true;
            try {
              await api.post(`/api/personas/${id}/memories`, { content, kind: kindSel.value, salience: +sal.value, confidence: 0.95 });
              ta.value = '';
              toast('已添加', 'ok');
              load();
            } catch (e) { toast(e.message, 'err'); }
            addBtn.disabled = false;
          },
        }, '添加');
        return [ta, h('div.row.gap-8',
          h('span.tiny.dim', { text: '类型' }), kindSel,
          h('span.tiny.dim', { text: '重要度' }), sal,
          h('div.grow'), addBtn)];
      })()
    )
  );

  wrap.append(
    h('div.card',
      h('div.card-title', { text: '长期记忆库' }),
      h('p.small.muted.mb-16', { text: '聊天时会根据当前话题召回相关记忆。重要度越高的记忆越容易被优先使用。' }),
      h('div.row.gap-8.mb-16', h('div.grow', search)),
      kindBar
    ),
    listBox,
    addForm
  );
  await load();
  return wrap;
}

function editMemory(personaId, m, reload) {
  const ta = h('textarea', { rows: 4, value: m.content });
  const sal = h('input', { type: 'range', min: 1, max: 5, value: m.salience, style: { maxWidth: '160px' } });
  const conf = h('input', { type: 'range', min: 0, max: 100, value: Math.round(m.confidence * 100), style: { maxWidth: '160px' } });
  modal({
    title: '编辑记忆',
    body: h('div.col.gap-16',
      h('div.field', h('label', { text: '内容' }), ta),
      h('div.field', h('label', { text: '重要度' }), sal),
      h('div.field', h('label', { text: '可信度' }), conf)
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          await api.patch(`/api/memories/${m.id}`, {
            content: ta.value.trim(), salience: +sal.value, confidence: +conf.value / 100,
          });
          toast('已保存');
          reload();
        },
      },
    ],
  });
}

function debounceTimer(fn, ms) {
  let t;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

/* ------------------------------------------------------- settings */
function renderSettingsTab(id, data) {
  const p = data.persona;
  const wrap = h('div.col.gap-16');

  const name = h('input', { type: 'text', value: p.name, maxlength: 60 });
  const rel = h('input', { type: 'text', value: p.relationship, maxlength: 100 });
  const bio = h('input', { type: 'text', value: p.bio, maxlength: 300 });
  const desc = h('textarea', { rows: 4, value: p.description, maxlength: 4000 });
  const lang = h('select', {},
    h('option', { value: 'zh', selected: p.language === 'zh' }, '中文'),
    h('option', { value: 'en', selected: p.language === 'en' }, 'English'),
    h('option', { value: 'ja', selected: p.language === 'ja' }, '日本語')
  );
  const mode = h('select', {},
    h('option', { value: 'free', selected: p.similarityMode === 'free' }, '自由模式'),
    h('option', { value: 'natural', selected: p.similarityMode === 'natural' }, '自然模仿'),
    h('option', { value: 'high', selected: p.similarityMode === 'high' }, '高度模仿')
  );
  // 回复形态：不是"要不要开 TTS"，而是"TA 平时是打字还是发语音"。
  // text 只打字 / voice 每条都发语音。曾有的第三档「随机」已删除：
  // 它按历史语音占比掷骰子，实测几乎总是落在文字上，用户体感是坏了。
  // 老数据里的 'mixed' 不再被选中（textarea 会落回第一项），保存时写回 text。
  const voiceMode = h('select', {},
    h('option', { value: 'text', selected: (p.voiceMode || 'text') !== 'voice' }, '只发文字'),
    h('option', { value: 'voice', selected: p.voiceMode === 'voice' }, '只发语音')
  );
  const autoSpeak = h('input', { type: 'checkbox', checked: p.autoSpeak });

  const avatarInput = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: { display: 'none' },
    onchange: async () => {
      const f = avatarInput.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        await api.form(`/api/personas/${id}/avatar`, fd);
        toast('头像已更新', 'ok');
        navigate(`/app/personas/${id}/settings`);
      } catch (e) { toast(e.message, 'err'); }
    },
  });

  wrap.append(
    h('div.card',
      h('div.card-title', { text: '基本信息' }),
      h('div.row.gap-16.mb-24',
        avatar(p.name, p.avatarUrl, 72),
        h('div',
          h('button.btn.btn-sm', { type: 'button', onclick: () => avatarInput.click() }, '更换头像'),
          avatarInput,
          h('div.tiny.dim.mt-8', { text: 'PNG / JPG / WEBP / GIF，最大 4MB' })
        )
      ),
      h('div.form-grid',
        h('div.field', h('label', { text: '昵称' }), name),
        h('div.field', h('label', { text: '关系' }), rel),
        h('div.field.full', h('label', { text: '一句话介绍' }), bio),
        h('div.field.full', h('label', { text: '人物描述' }), desc),
        h('div.field', h('label', { text: '语言' }), lang),
        h('div.field', h('label', { text: '默认模仿强度' }), mode),
        h('div.field', h('label', { text: '回复形态' }), voiceMode,
          h('div.hint', { text: '「随机」会按 TA 在聊天记录里真实的语音比例决定这一次是打字还是发语音。' }))
      ),
      h('div.mt-16',
        h('label.switch', autoSpeak, h('span.track'),
          h('span', { text: '发语音时自动播放（关掉则只显示语音条，点一下才听）' }))
      ),
      h('div.row.gap-8.mt-24',
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.patch(`/api/personas/${id}`, {
                name: name.value.trim(), relationship: rel.value.trim(), bio: bio.value.trim(),
                description: desc.value.trim(), language: lang.value, similarityMode: mode.value,
                autoSpeak: autoSpeak.checked, voiceMode: voiceMode.value,
              });
              await loadPersonas();
              toast('已保存', 'ok');
              navigate(`/app/personas/${id}/settings`);
            } catch (ex) { toast(ex.message, 'err'); }
            e.currentTarget.disabled = false;
          },
        }, '保存修改')
      )
    ),
    h('div.card',
      h('div.card-title', { text: '模型与语音绑定' }),
      h('div.col.gap-16',
        (() => {
          const box = h('div');
          (async () => {
            const [llms, ttss, voices] = await Promise.all([
              api.get('/api/llm-configs').then((r) => r.configs).catch(() => []),
              api.get('/api/tts-configs').then((r) => r.configs).catch(() => []),
              api.get('/api/voice-refs').then((r) => r.voices).catch(() => []),
            ]);
            const ls = h('select', {},
              h('option', { value: '' }, '使用账户默认'),
              ...llms.map((c) => h('option', { value: c.id, selected: p.llmConfigId === c.id }, `${c.label} · ${c.model}`))
            );
            const ts = h('select', {},
              h('option', { value: '' }, '使用账户默认'),
              ...ttss.map((c) => h('option', { value: c.id, selected: p.ttsConfigId === c.id }, `${c.label} · ${c.kind}`))
            );
            const vs = h('select', {},
              h('option', { value: '' }, '使用默认音色'),
              ...voices.map((c) => h('option', { value: c.id, selected: p.voiceRefId === c.id }, c.name))
            );
            box.replaceChildren(
              h('div.field', h('label', { text: '大模型' }), ls),
              h('div.field', h('label', { text: '语音服务' }), ts),
              h('div.field', h('label', { text: '音色' }), vs),
              h('button.btn.btn-sm', {
                type: 'button', style: { alignSelf: 'flex-start' },
                onclick: async () => {
                  await api.patch(`/api/personas/${id}`, {
                    llmConfigId: ls.value || null, ttsConfigId: ts.value || null, voiceRefId: vs.value || null,
                  });
                  toast('已保存', 'ok');
                },
              }, '保存绑定')
            );
          })();
          return box;
        })()
      )
    ),
    h('div.card',
      h('div.card-title', { text: '复制与导出' }),
      h('div.col.gap-8',
        h('div.between',
          h('div', h('div.small', { text: '复制这个人格' }),
            h('div.tiny.dim', { text: '包含聊天记录、记忆与档案，可用于试验不同模型配置。' })),
          h('button.btn.btn-sm', {
            type: 'button',
            onclick: async () => {
              const r = await api.post(`/api/personas/${id}/duplicate`);
              await loadPersonas();
              toast('已复制', 'ok');
              navigate(`/app/personas/${r.id}`);
            },
          }, '复制')
        ),
        h('div.between',
          h('div', h('div.small', { text: '导出人格数据' }),
            h('div.tiny.dim', { text: 'JSON 格式，包含档案、记忆与全部对话。不含密钥。' })),
          h('a.btn.btn-sm', { href: `/api/personas/${id}/export`, download: '' }, '导出')
        )
      )
    ),
    h('div.card', { style: { borderColor: '#e8d3cb' } },
      h('div.card-title', { text: '删除人格' }),
      h('p.small.muted.mb-16', { text: '将永久删除这个人格的所有聊天记录、记忆、档案与语音文件。此操作不可恢复。' }),
      h('button.btn.btn-danger', {
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: `删除「${p.name}」？`,
            message: '所有导入的聊天记录、长期记忆、人格档案和生成的语音文件都会被永久删除，无法恢复。',
            confirmLabel: '永久删除',
            danger: true,
          });
          if (!ok) return;
          await api.del(`/api/personas/${id}`);
          await loadPersonas();
          toast('已删除');
          navigate('/app/personas');
        },
      }, '删除人格')
    )
  );

  return wrap;
}

/* -------------------------------------------------- profile editor */
export async function profileEditorPage(id) {
  if (!requireUser()) return;
  setTitle('人格档案');
  const r = await api.get(`/api/personas/${id}/profile`);
  const p = (await api.get(`/api/personas/${id}`)).persona;

  if (!r.profile) {
    return shell({
      active: `persona:${id}`, title: '人格档案',
      content: h('div.empty',
        h('h3', { text: '还没有档案' }),
        h('a.btn.btn-copper', { href: `/app/personas/${id}/analysis` }, '去运行分析')
      ),
    });
  }

  const prof = r.profile;
  const summary = h('textarea', { rows: 3, value: prof.summary || '' });
  const catchphrases = h('input', { type: 'text', value: (prof.language_style?.catchphrases || []).join('、') });
  const favWords = h('input', { type: 'text', value: (prof.language_style?.favorite_words || []).join('、') });
  const saveBtn = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      saveBtn.disabled = true;
      try {
        await api.patch(`/api/personas/${id}/profile`, {
          profile: {
            summary: summary.value.trim(),
            language_style: {
              ...prof.language_style,
              catchphrases: catchphrases.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
              favorite_words: favWords.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
            },
          },
        });
        toast('已保存', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      saveBtn.disabled = false;
    },
  }, '保存修改');

  const content = h('div', { style: { maxWidth: '820px' } },
    h('div.between.mb-24',
      h('div',
        h('h1', { style: { fontSize: '1.5rem', marginBottom: '4px' }, text: `${p.name} · 人格档案` }),
        h('p.tiny.dim', {
          text: `版本 v${prof._version || 1} · 生成于 ${fmtDate(prof._createdAt)} · 样本 ${prof._meta?.sampleCount || 0} 条`,
        })
      ),
      h('div.row.gap-8',
        h('a.btn', { href: `/app/personas/${id}`, text: '返回' }),
        saveBtn
      )
    ),
    h('div.card.mb-16',
      h('div.card-title', { text: '整体画像' }),
      summary
    ),
    h('div.card.mb-16',
      h('div.card-title', { text: '语言风格（可编辑）' }),
      h('div.col.gap-16',
        h('div.field', h('label', { text: '口头禅（用、分隔）' }), catchphrases),
        h('div.field', h('label', { text: '常用词（用、分隔）' }), favWords)
      )
    ),
    // 原始 JSON 是排查用的，默认收起。
    // 普通用户看到一大片只读 JSON 只会觉得「这东西没做完」；
    // 真有需要（比如怀疑某个字段没学到）再展开看。
    h('details.card',
      h('summary', { style: { cursor: 'pointer', listStyle: 'none' } },
        h('div.card-title', { style: { marginBottom: 0, display: 'inline-block' }, text: '完整档案（原始数据，排查用）' })),
      h('pre.codeblock', { style: { maxHeight: '520px', overflow: 'auto', marginTop: '12px' }, text: JSON.stringify(
        { ...prof, _meta: prof._meta }, null, 2) })
    )
  );

  return shell({ active: `persona:${id}`, title: '人格档案', content });
}
