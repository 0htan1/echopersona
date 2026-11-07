import {
  h, api, toast, avatar, navigate, fmtBytes, fmtDate, fmtRelative, modal, confirmDialog,
} from '../core.js';
import { state, shell, setTitle, requireUser, loadPersonas, setUiTheme } from '../shell.js';

/* ================================================================== *
 * Settings hub
 * ================================================================== */
export async function settingsPage(tab = 'keys') {
  if (!requireUser()) return;
  setTitle('设置');

  const tabs = [
    ['keys', 'API 配置'],
    ['account', '账户与安全'],
  ];

  const bar = h('div.pill-tabs.mb-24',
    ...tabs.map(([k, label]) => h('button', {
      type: 'button', 'aria-selected': String(tab === k),
      onclick: () => navigate(k === 'keys' ? '/app/settings/keys' : '/app/settings/account'),
    }, label))
  );

  let body;
  if (tab === 'account') body = await accountTab();
  else body = await keysTab();

  return shell({
    active: 'settings', title: '设置',
    content: h('div', { style: { maxWidth: '860px' } },
      h('h1', { style: { fontSize: '1.55rem', marginBottom: '6px' }, text: '设置' }),
      h('p.muted.small.mb-24', { text: '管理你的 API 凭证与账户安全。所有密钥都在服务端加密存储。' }),
      bar, body
    ),
  });
}

/* ================================================================== *
 * Keys tab: LLM + TTS + voice refs
 * ================================================================== */
async function keysTab() {
  const wrap = h('div.col.gap-16');
  const [llm, tts] = await Promise.all([
    api.get('/api/llm-configs').then((r) => r.configs).catch(() => []),
    api.get('/api/tts-configs').then((r) => r.configs).catch(() => []),
  ]);

  /* ---------- LLM ---------- */
  // 云通道已下线，但老库里可能留着 provider='workbuddy-cloud' 的行 ——
  // 它们没有 Key、也调不通，显示在这里只会让人困惑，直接滤掉。
  const ownLlm = llm.filter((c) => c.provider !== 'workbuddy-cloud');
  wrap.append(h('div.card',
    h('div.between.mb-16',
      h('div',
        h('div.card-title', { style: { marginBottom: '4px' }, text: '大模型配置' }),
        h('p.tiny.dim', { style: { margin: 0 }, text: '支持任何 OpenAI 兼容接口：OpenAI、DeepSeek、通义、Moonshot、自建 vLLM 等。' })
      ),
      h('button.btn.btn-copper.btn-sm', { type: 'button', onclick: () => llmForm(null, ownLlm) }, '＋ 添加配置')
    ),
    ownLlm.length
      ? h('div.col.gap-8', ...ownLlm.map((c) => llmRow(c, ownLlm)))
      : h('div.empty', { style: { padding: '30px 16px' } },
          h('p.small.muted', { text: '还没有配置。聊天和分析都需要你自己的模型 API Key。' }),
          h('button.btn.btn-copper.btn-sm', { type: 'button', onclick: () => llmForm(null, ownLlm) }, '添加第一个配置'))
  ));

  /* ---------- TTS ---------- */
  wrap.append(h('div.card',
    h('div.between.mb-16',
      h('div',
        h('div.card-title', { style: { marginBottom: '4px' }, text: 'BreezeTTS 语音配置' }),
        h('p.tiny.dim', { style: { margin: 0 }, text: '支持 Breeze Blue 托管版（xi-api-key）与自托管 breeze-tts-2（参考音频）。' })
      ),
      h('button.btn.btn-copper.btn-sm', { type: 'button', onclick: () => ttsForm(null, tts) }, '＋ 添加配置')
    ),
    tts.length
      ? h('div.col.gap-8', ...tts.map((c) => ttsRow(c, tts)))
      : h('div.empty', { style: { padding: '30px 16px' } },
          h('p.small.muted', { text: '还没有配置。语音是可选功能，不配置也能正常文字聊天。' }),
          h('button.btn.btn-copper.btn-sm', { type: 'button', onclick: () => ttsForm(null, tts) }, '添加语音服务'))
  ));

  /* ---------- 音色去向提示 ----------
   * 音色列表只放在「语音」页一处管理。
   * 之前这里和语音页各渲染一份，结果是：在设置页删了音色，语音页不会变；
   * 语音页没有删除按钮，用户在两个地方看到的按钮还不一样 —— 典型的
   * 「改一处忘另一处」。设置页只负责服务 Key，音色归语音页。 */
  wrap.append(h('div.card.card-tight', { style: { background: 'var(--paper-2)' } },
    h('div.between',
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { fontWeight: '600', marginBottom: '3px' }, text: '参考音色在「语音」页管理' }),
        h('div.small.muted', { text: '可以选服务商现成的音色 ID，或上传音频克隆。这里只配服务凭证。' })),
      h('a.btn.btn-sm', { href: '/app/voice' }, '去语音页')
    )
  ));

  /* ---------- embedding / memory note ---------- */
  wrap.append(h('div.card.card-tight', { style: { background: 'var(--paper-2)' } },
    h('div.card-title', { text: '关于 Embedding 模型' }),
    h('p.small.muted.mb-8', { text:
      '长期记忆的向量检索需要一个 embedding 模型。在模型配置的「高级参数」里填写 embeddingModel 后，'
      + '系统会在分析时自动为记忆和对话片段生成向量，实现语义召回。' }),
    h('p.tiny.dim', { style: { margin: 0 }, text:
      '不填写也可以工作：系统会退化为关键词检索（FTS5 + 中文 bigram 分词），对聊天这类短文本效果依然可靠。' })
  ));

  return wrap;
}

/**
 * 聊天界面外观选择。
 *
 * 两个选项都给一张**真的画出来的预览**，而不是两个单词按钮 ——
 * "经典 / 微信"这种名字光看字没人知道长什么样，选完再退回来看很烦。
 * 预览是用 div 堆的缩略气泡，不是截图，所以永远和真实样式同步。
 */
function themeCard() {
  const cur = state.user?.uiTheme === 'wechat' ? 'wechat' : 'classic';

  const preview = (kind) => {
    const wechat = kind === 'wechat';
    const bg = wechat ? '#ededed' : 'var(--paper)';
    const themBg = wechat ? '#ffffff' : '#f2ede7';
    const meBg = wechat ? '#95ec69' : 'var(--ink)';
    const meFg = wechat ? '#191919' : '#fbf9f5';
    const radius = wechat ? '4px' : '14px';
    return h('div', {
      style: {
        background: bg, borderRadius: '8px', padding: '10px 11px',
        display: 'flex', flexDirection: 'column', gap: '7px',
        border: '1px solid var(--line-2)', height: '96px', justifyContent: 'center',
      },
    },
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        h('div', {
          style: {
            width: '16px', height: '16px', borderRadius: '3px', flexShrink: '0',
            background: wechat ? '#c8c8c8' : 'var(--copper-tint)',
          },
        }),
        h('div', {
          style: {
            background: themBg, color: wechat ? '#191919' : 'var(--ink)',
            borderRadius: radius, padding: '5px 9px', fontSize: '0.66rem',
            maxWidth: '70%', lineHeight: '1.3',
          },
        }, '在吗')
      ),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start', justifyContent: 'flex-end' } },
        h('div', {
          style: {
            background: meBg, color: meFg,
            borderRadius: radius, padding: '5px 9px', fontSize: '0.66rem',
            maxWidth: '70%', lineHeight: '1.3',
          },
        }, '在的'),
        h('div', {
          style: {
            width: '16px', height: '16px', borderRadius: '3px', flexShrink: '0',
            background: wechat ? '#c8c8c8' : 'var(--copper-tint)',
          },
        })
      )
    );
  };

  const option = (kind, name, desc) => {
    const selected = cur === kind;
    const btn = h('button', {
      type: 'button',
      style: {
        flex: '1 1 200px', textAlign: 'left', cursor: 'pointer',
        background: 'var(--card)', fontFamily: 'var(--sans)',
        border: `1px solid ${selected ? 'var(--copper)' : 'var(--line)'}`,
        boxShadow: selected ? '0 0 0 3px var(--copper-tint)' : 'none',
        borderRadius: '11px', padding: '11px',
        transition: 'border-color .15s, box-shadow .15s',
      },
      onclick: async () => {
        if (kind === cur) return;
        await setUiTheme(kind);
        toast(kind === 'wechat' ? '已切换为微信风格' : '已切换为经典风格', 'ok');
        // 重渲染本页，让选中态和预览高亮跟上
        navigate('/app/settings/account');
      },
    },
      preview(kind),
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '7px', marginTop: '9px',
        },
      },
        h('span', { style: { fontSize: '0.86rem', fontWeight: '600', color: 'var(--ink)' }, text: name }),
        selected
          ? h('span.badge', { style: { fontSize: '0.66rem' }, text: '使用中' })
          : null
      ),
      h('div.tiny.dim', { style: { marginTop: '3px', lineHeight: '1.45' }, text: desc })
    );
    return btn;
  };

  return h('div.card',
    h('div.card-title', { text: '聊天界面' }),
    h('p.tiny.dim', { style: { marginTop: '-6px', marginBottom: '13px' }, text:
      '只影响对话页的外观，其它页面不变。选择会跟着账号走，换设备也是这个样式。' }),
    h('div.row.gap-12', { style: { flexWrap: 'wrap' } },
      option('classic', '经典', '本站原来的样子：纸色背景、大圆角气泡，时间与发言人一直在。'),
      option('wechat', '微信风格', '复刻微信：浅灰背景、绿色气泡、气泡尖角、语音条横排。')
    )
  );
}

function llmRow(c, all) {
  const testBox = h('span.tiny.dim', { text: '' });
  return h('div', {
    style: {
      padding: '13px 15px', border: '1px solid var(--line)', borderRadius: '10px',
      background: c.isDefault ? 'var(--copper-tint)' : 'var(--card)',
    },
  },
    h('div.between',
      h('div', { style: { minWidth: 0 } },
        h('div.row.gap-8',
          h('b', { style: { fontSize: '0.9rem' }, text: c.label }),
          c.isDefault ? h('span.badge.badge-copper', { text: '默认' }) : null,
          c.lastTestOk === 0 ? h('span.badge.badge-danger', { text: '上次测试失败' }) : null,
          c.lastTestOk === 1 ? h('span.badge.badge-sage', { text: '连接正常' }) : null
        ),
        h('div.tiny.dim.mono', { style: { marginTop: '3px' }, text: `${c.baseUrl} · ${c.model}` }),
        h('div.tiny.dim', { text: c.hasKey ? `Key: ${c.keyHint}` : 'Key 未保存（临时模式，重启后失效）' })
      ),
      h('div.row.gap-4',
        testBox,
        h('button.btn.btn-sm', {
          type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.replaceChildren(h('span.spin'));
            try {
              const r = await api.post(`/api/llm-configs/${c.id}/test-chat`, { prompt: '用一句中文回答：你现在能正常工作吗？' });
              testBox.style.color = 'var(--sage)';
              testBox.textContent = `${r.latencyMs}ms · ${r.reply.slice(0, 40)}`;
              toast('模型回复正常', 'ok');
            } catch (ex) {
              testBox.style.color = 'var(--danger)';
              testBox.textContent = ex.message.slice(0, 60);
              toast(ex.message, 'err');
            }
            btn.disabled = false; btn.textContent = '测试';
          },
        }, '测试'),
        !c.isDefault
          ? h('button.btn.btn-sm', {
              type: 'button',
              onclick: async () => {
                await api.post(`/api/llm-configs/${c.id}/default`);
                toast('已设为默认');
                navigate('/app/settings/keys');
              },
            }, '设为默认')
          : null,
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          type: 'button', 'aria-label': '编辑',
          onclick: () => llmForm(c, all),
        }, '✎'),
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          type: 'button', 'aria-label': '删除',
          onclick: async () => {
            if (!await confirmDialog({ title: '删除这个模型配置？', message: c.label, confirmLabel: '删除', danger: true })) return;
            await api.del(`/api/llm-configs/${c.id}`);
            toast('已删除');
            navigate('/app/settings/keys');
          },
        }, '✕')
      )
    )
  );
}

function llmForm(existing, all) {
  const isEdit = !!existing;
  const label = h('input', { type: 'text', value: existing?.label || '', placeholder: '例如：DeepSeek 主力模型' });
  const baseUrl = h('input', { type: 'text', value: existing?.baseUrl || 'https://api.deepseek.com', placeholder: 'https://api.openai.com' });
  const apiKey = h('input', {
    type: 'password', placeholder: existing?.hasKey ? '留空则不修改已保存的 Key' : 'sk-...',
    autocomplete: 'off',
  });
  const model = h('input', { type: 'text', value: existing?.model || '', placeholder: '例如：deepseek-chat' });
  const embModel = h('input', {
    type: 'text', value: existing?.params?.embeddingModel || '',
    placeholder: '例如：text-embedding-3-small（可留空）',
  });
  const temp = h('input', { type: 'range', min: 0, max: 200, value: Math.round((existing?.params?.temperature ?? 0.8) * 100) });
  const tempVal = h('span.mono.tiny', { text: String(existing?.params?.temperature ?? 0.8) });
  const maxTok = h('input', { type: 'number', value: existing?.params?.max_tokens ?? 1024, min: 64, max: 32000 });
  const saveKey = h('input', { type: 'checkbox', checked: true });
  const asDefault = h('input', { type: 'checkbox', checked: existing?.isDefault || all.length === 0 });
  const modelsBox = h('div.tiny.dim');
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });

  temp.addEventListener('input', () => { tempVal.textContent = (temp.value / 100).toFixed(2); });

  const fetchModels = async (btn) => {
    btn.disabled = true;
    modelsBox.textContent = '正在读取模型列表…';
    try {
      let targetId = existing?.id;
      if (!targetId) {
        if (!baseUrl.value.trim() || !apiKey.value.trim()) throw new Error('请先填写 Base URL 与 API Key');
        /* 新配置第一次点「读取可用模型」，旧实现每次都会 POST 一条新配置，
         * 于是点三次就多出三张一模一样的卡片 —— 用户以为按钮坏了。
         *
         * 改成「探测」：只发一次性感的请求验证连通性并拿模型列表，
         * 不落库。配置在点「添加」时才真正创建。
         * 这样无论点几次，库里不会多出任何东西。 */
        const probe = await api.post('/api/llm-configs/probe', {
          baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim(),
        });
        showModels(probe.models || []);
        return;
      }
      const r = await api.post(`/api/llm-configs/${targetId}/test`, {});
      showModels(r.models || []);
    } catch (e) {
      modelsBox.style.color = 'var(--danger)';
      modelsBox.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };

  function showModels(models) {
    modelsBox.style.color = 'var(--ink-3)';
    modelsBox.replaceChildren(
      h('div', { text: `发现 ${models.length} 个模型，点击填入：` }),
      h('div.row-wrap.gap-4.mt-8',
        ...models.slice(0, 24).map((m) => h('button.btn.btn-sm', {
          type: 'button', onclick: () => { model.value = m; },
        }, m)))
    );
  }

  const fetchBtn = h('button.btn.btn-sm', { type: 'button', onclick: (e) => fetchModels(e.currentTarget) }, '读取可用模型');

  modal({
    title: isEdit ? '编辑模型配置' : '添加大模型配置',
    wide: true,
    body: h('div.col.gap-16',
      h('div.form-grid',
        h('div.field', h('label', { text: '配置名称' }), label),
        h('div.field', h('label', { text: '模型名称' }), model),
        h('div.field.full',
          h('label', { text: 'API Base URL' }), baseUrl,
          h('div.hint', { text: '填到域名或 /v1 都可以，系统会自动补全 /chat/completions。内网地址会被拒绝。' })
        ),
        h('div.field.full',
          h('label', { text: 'API Key' }), apiKey,
          h('div.hint', { text: '密钥只在服务端使用，加密存储，浏览器永远拿不到明文。' })
        ),
        h('div.field.full',
          h('label', { text: 'Embedding 模型（可选）' }), embModel,
          h('div.hint', { text: '填写后启用向量检索；留空则使用关键词检索。' })
        )
      ),
      h('div.row.gap-8', fetchBtn, modelsBox),
      h('div.form-grid',
        h('div.field',
          h('label', 'Temperature', tempVal),
          h('div.range-row', temp),
          h('div.hint', { text: '越高越随机。人格聊天建议 0.7-0.95。' })
        ),
        h('div.field', h('label', { text: 'Max tokens' }), maxTok)
      ),
      h('div.col.gap-8',
        h('label.checkbox', saveKey, h('span', { text: '保存 API Key（加密存储）。不勾选则仅在本次服务运行期间有效。' })),
        h('label.checkbox', asDefault, h('span', { text: '设为默认模型' }))
      ),
      err
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: isEdit ? '保存' : '添加', kind: 'copper',
        onClick: async () => {
          err.textContent = '';
          if (!label.value.trim() || !baseUrl.value.trim() || !model.value.trim()) {
            err.textContent = '请填写配置名称、Base URL 与模型名称';
            return false;
          }
          if (!isEdit && !apiKey.value.trim()) { err.textContent = '请填写 API Key'; return false; }
          const params = {
            temperature: temp.value / 100,
            max_tokens: Number(maxTok.value) || 1024,
            ...(embModel.value.trim() ? { embeddingModel: embModel.value.trim() } : {}),
          };
          try {
            if (isEdit) {
              await api.patch(`/api/llm-configs/${existing.id}`, {
                label: label.value.trim(), baseUrl: baseUrl.value.trim(), model: model.value.trim(),
                params, ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim(), saveKey: saveKey.checked } : {}),
              });
              if (asDefault.checked && !existing.isDefault) await api.post(`/api/llm-configs/${existing.id}/default`);
            } else {
              await api.post('/api/llm-configs', {
                label: label.value.trim(), baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim(),
                model: model.value.trim(), params, isDefault: asDefault.checked, saveKey: saveKey.checked,
              });
            }
            toast('已保存', 'ok');
            navigate('/app/settings/keys');
          } catch (e) {
            err.textContent = e.message;
            return false;
          }
        },
      },
    ],
  });
}

function ttsRow(c, all) {
  const res = h('span.tiny.dim');
  return h('div', {
    style: {
      padding: '13px 15px', border: '1px solid var(--line)', borderRadius: '10px',
      background: c.isDefault ? 'var(--copper-tint)' : 'var(--card)',
    },
  },
    h('div.between',
      h('div', { style: { minWidth: 0 } },
        h('div.row.gap-8',
          h('b', { style: { fontSize: '0.9rem' }, text: c.label }),
          h('span.badge', { text: c.kind === 'breeze_local' ? '自托管' : c.kind === 'breezeblue' ? 'Breeze Blue' : '未识别' }),
          c.isDefault ? h('span.badge.badge-copper', { text: '默认' }) : null,
          c.lastTestOk === 0 ? h('span.badge.badge-danger', { text: '测试失败' }) : null
        ),
        h('div.tiny.dim.mono', { style: { marginTop: '3px' }, text: `${c.baseUrl}${c.model ? ` · ${c.model}` : ''}` }),
        h('div.tiny.dim', { text: c.hasKey ? `Key: ${c.keyHint}` : '未保存 Key' })
      ),
      h('div.row.gap-4',
        res,
        h('button.btn.btn-sm', {
          type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.replaceChildren(h('span.spin'));
            try {
              const r = await api.post(`/api/tts-configs/${c.id}/test`);
              res.style.color = 'var(--sage)';
              res.textContent = `${r.voices?.length || 0} 个音色`;
              toast(`连接正常（${r.kind}）`, 'ok');
            } catch (ex) {
              res.style.color = 'var(--danger)';
              res.textContent = ex.message.slice(0, 50);
              toast(ex.message, 'err');
            }
            btn.disabled = false; btn.textContent = '测试';
          },
        }, '测试'),
        !c.isDefault
          ? h('button.btn.btn-sm', {
              type: 'button',
              onclick: async () => {
                await api.post(`/api/tts-configs/${c.id}/default`);
                toast('已设为默认');
                navigate('/app/settings/keys');
              },
            }, '设为默认')
          : null,
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          type: 'button', 'aria-label': '编辑', onclick: () => ttsForm(c, all),
        }, '✎'),
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          type: 'button', 'aria-label': '删除',
          onclick: async () => {
            if (!await confirmDialog({ title: '删除这个语音配置？', message: c.label, confirmLabel: '删除', danger: true })) return;
            await api.del(`/api/tts-configs/${c.id}`);
            toast('已删除');
            navigate('/app/settings/keys');
          },
        }, '✕')
      )
    )
  );
}

function ttsForm(existing, all) {
  const isEdit = !!existing;
  const label = h('input', { type: 'text', value: existing?.label || '', placeholder: '例如：Breeze 生产环境' });
  const kind = h('select', {},
    h('option', { value: 'auto', selected: !existing || existing.kind === 'auto' }, '自动识别'),
    h('option', { value: 'breezeblue', selected: existing?.kind === 'breezeblue' }, 'Breeze Blue 托管版（xi-api-key）'),
    h('option', { value: 'breeze_local', selected: existing?.kind === 'breeze_local' }, '自托管 breeze-tts-2（参考音频）')
  );
  const baseUrl = h('input', {
    type: 'text',
    value: existing?.baseUrl || 'https://api.breeze.blue',
    placeholder: 'https://api.breeze.blue 或 http://你的服务器:7860',
  });
  const apiKey = h('input', {
    type: 'password', placeholder: existing?.hasKey ? '留空则不修改' : 'brz_...', autocomplete: 'off',
  });
  const model = h('input', { type: 'text', value: existing?.model || '', placeholder: '例如：breeze-tts-2（可留空）' });
  const speed = h('input', { type: 'range', min: 50, max: 200, value: Math.round((existing?.settings?.speed ?? 1) * 100) });
  const speedVal = h('span.tiny.mono', { text: String(existing?.settings?.speed ?? 1) });
  const volume = h('input', { type: 'range', min: 1, max: 200, value: Math.round((existing?.settings?.volume ?? 1) * 100) });
  const volVal = h('span.tiny.mono', { text: String(existing?.settings?.volume ?? 1) });
  const instr = h('textarea', {
    rows: 2, value: existing?.settings?.instructions || '',
    placeholder: '例如：语速偏慢，语气温柔但有点疲惫',
  });
  const saveKey = h('input', { type: 'checkbox', checked: true });
  const asDefault = h('input', { type: 'checkbox', checked: existing?.isDefault });
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });

  speed.addEventListener('input', () => { speedVal.textContent = (speed.value / 100).toFixed(2); });
  volume.addEventListener('input', () => { volVal.textContent = (volume.value / 100).toFixed(2); });

  modal({
    title: isEdit ? '编辑语音配置' : '添加语音配置',
    wide: true,
    body: h('div.col.gap-16',
      h('div.form-grid',
        h('div.field', h('label', { text: '配置名称' }), label),
        h('div.field', h('label', { text: '接口类型' }), kind),
        h('div.field.full',
          h('label', { text: '服务地址' }), baseUrl,
          h('div.hint', {
            text: '托管版填 https://api.breeze.blue（填成文档里的 https://api.breeze.blue/v1 也可以，'
              + '系统会自动归一化）。自托管填你的服务根地址。系统会探测真实接口，不会猜测路径。',
          })
        ),
        h('div.field', h('label', { text: 'API Key' }), apiKey),
        h('div.field', h('label', { text: '模型名称' }), model)
      ),
      h('div.form-grid',
        h('div.field', h('label', {}, '语速 ', speedVal), h('div.range-row', speed)),
        h('div.field', h('label', {}, '音量 ', volVal), h('div.range-row', volume))
      ),
      h('div.field',
        h('label', { text: '情绪/表演指令（托管版 instructions）' }),
        instr,
        h('div.hint', { text: '用自然语言描述语气。自托管模式会作为 instruction 字段传给服务。' })
      ),
      h('div.col.gap-8',
        h('label.checkbox', saveKey, h('span', { text: '保存 API Key（加密存储）' })),
        h('label.checkbox', asDefault, h('span', { text: '设为默认语音服务' }))
      ),
      h('div', {
        style: { padding: '11px 13px', background: 'var(--amber-soft)', borderRadius: '8px', fontSize: '0.8rem', color: 'var(--amber)', lineHeight: '1.6' },
      }, '声音克隆必须获得声音所有者的明确授权。未经授权克隆他人声音可能违反法律，账户将被停用。'),
      err
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: isEdit ? '保存' : '添加', kind: 'copper',
        onClick: async () => {
          err.textContent = '';
          if (!label.value.trim() || !baseUrl.value.trim()) { err.textContent = '请填写名称与服务地址'; return false; }
          const settings = {
            speed: speed.value / 100, volume: volume.value / 100, instructions: instr.value.trim(),
          };
          try {
            if (isEdit) {
              await api.patch(`/api/tts-configs/${existing.id}`, {
                label: label.value.trim(), baseUrl: baseUrl.value.trim(), kind: kind.value,
                model: model.value.trim(), settings,
                ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim(), saveKey: saveKey.checked } : {}),
              });
              if (asDefault.checked && !existing.isDefault) await api.post(`/api/tts-configs/${existing.id}/default`);
            } else {
              await api.post('/api/tts-configs', {
                label: label.value.trim(), baseUrl: baseUrl.value.trim(), kind: kind.value,
                apiKey: apiKey.value.trim(), model: model.value.trim(), settings,
                isDefault: asDefault.checked, saveKey: saveKey.checked,
              });
            }
            toast('已保存', 'ok');
            navigate('/app/settings/keys');
          } catch (e) { err.textContent = e.message; return false; }
        },
      },
    ],
  });
}


/* 音色库选择器：拉账号里已有的上游音色，点一条就选中。
 *
 * 抽成函数是因为「新建」和「编辑」两个弹窗都要用 —— 之前只有编辑弹窗
 * 有这段代码，新建时用户只能上传音频，看起来就像「只能克隆」。
 * onPick 收到整条音色对象（含 name），让调用方能顺手把名称填好。 */
function voicePicker({ onPick }) {
  const search = h('input', { type: 'text', placeholder: '搜索音色名称或描述…' });
  const listBox = h('div.col.gap-8', { style: { maxHeight: '240px', overflowY: 'auto' } });
  const status = h('div.tiny.dim');
  let selectedId = null;

  const renderList = (voices) => {
    if (!voices.length) {
      listBox.replaceChildren(h('div.tiny.dim', { style: { padding: '10px 0' }, text: '没有匹配的音色' }));
      return;
    }
    listBox.replaceChildren(...voices.map((x) => {
      const row = h('div', {
        style: {
          padding: '9px 11px', border: '1px solid var(--line)', borderRadius: '9px',
          cursor: 'pointer', transition: 'border-color .13s, background .13s',
        },
        onclick: () => {
          selectedId = x.voiceId;
          for (const el of listBox.children) el.style.borderColor = 'var(--line)';
          row.style.borderColor = 'var(--accent, var(--copper))';
          onPick?.(x);
        },
      },
        h('div.row.gap-8', { style: { alignItems: 'baseline' } },
          h('b', { style: { fontSize: '0.85rem' }, text: x.name || x.voiceId }),
          x.gender ? h('span.badge', { text: x.gender === 'female' ? '女' : x.gender === 'male' ? '男' : x.gender }) : null,
          x.language ? h('span.badge', { text: x.language }) : null
        ),
        h('div.tiny.dim.mono', { text: x.voiceId }),
        x.description ? h('div.tiny.dim', { style: { marginTop: '2px' }, text: x.description }) : null
      );
      return row;
    }));
  };

  const load = async (q = '') => {
    status.textContent = '正在读取账号音色…';
    try {
      const r = await api.get(`/api/voice-refs/remote-voices?q=${encodeURIComponent(q)}&limit=40`);
      status.textContent = `共 ${r.total} 个音色${q ? `，匹配 ${r.voices.length} 个` : ''}`;
      renderList(r.voices);
    } catch (e) {
      // 「还没有 TTS 配置」不是错误，是还没走到这一步。
      // 只甩一句「读取失败：xxx」会让用户以为功能坏了 —— 要给下一步动作。
      const noCfg = /还没有 TTS 配置|没有.*配置/.test(e.message || '');
      if (noCfg) {
        status.replaceChildren(h('div', { style: { color: 'var(--ink-2)' } },
          h('div', { style: { marginBottom: '6px' }, text: '要列出现成音色，得先配一个语音服务。' }),
          h('a.btn.btn-sm', { href: '/app/settings/keys' }, '去配置语音服务')
        ));
        listBox.replaceChildren(h('div.tiny.dim', { style: { padding: '10px 0' },
          text: '也可以直接关掉这个窗口，先用「上传音频克隆」建一个本地音色。' }));
      } else {
        status.textContent = `读取失败：${e.message}`;
        listBox.replaceChildren(h('div.tiny.dim', { style: { padding: '10px 0' },
          text: '音色 ID 仍可手动填写，不影响保存。' }));
      }
    }
  };

  search.addEventListener('input', () => {
    clearTimeout(search._t);
    search._t = setTimeout(() => load(search.value.trim()), 300);
  });

  // 一打开就读，省掉一次「读取列表」的点击 —— 用户点开就想挑东西
  load('');

  return {
    node: h('div.field',
      h('div.between.mb-8',
        h('label', { text: '可选音色' }),
        h('span.tiny.dim', { text: '点一条即选中' })
      ),
      search, h('div.mt-8'), status, h('div.mt-8'), listBox
    ),
    getSelected: () => selectedId,
  };
}

/* 新建音色：两种方式二选一。
 * 「直接选音色 ID」是默认方式 —— 大多数用户手上已经有服务商的音色，
 * 让他再去录一段音频纯属多余；只有想克隆自己的声音时才用上传。 */
function voiceUploadForm() {
  let mode = 'pick'; // pick = 从音色库选；upload = 上传克隆

  const seg = h('div.pill-tabs');
  const mkSeg = (k, label) => h('button', {
    type: 'button', 'aria-selected': String(mode === k),
    onclick: () => { mode = k; syncMode(); },
  }, label);
  const segPick = mkSeg('pick', '从音色库选择');
  const segUpload = mkSeg('upload', '上传音频克隆');
  seg.append(segPick, segUpload);

  const name = h('input', { type: 'text', placeholder: '音色名称，例如：她的声音' });
  const remoteId = h('input', { type: 'text', placeholder: '也可粘贴 voice_id，例如 voc_xxxx' });
  const file = h('input', { type: 'file', accept: 'audio/*' });
  const refText = h('textarea', {
    rows: 3, placeholder: '这段音频里说的原话。必须是准确逐字文本，否则音色对齐会失败。',
  });
  const consent = h('input', { type: 'checkbox' });
  const err = h('div.tiny', { style: { color: 'var(--danger)', minHeight: '1.2em' } });

  const picker = voicePicker({
    onPick: (v) => {
      remoteId.value = v.voiceId;
      if (!name.value.trim()) name.value = v.name || v.voiceId;
    },
  });

  // 名称对两种模式都要，所以放在分流之外，只渲染一次
  const nameField = h('div.field', h('label', { text: '名称' }), name,
    h('div.hint', { text: '用户在这一栏看到的音色名，选完可以改。' }));

  const pickBox = h('div.col.gap-16',
    h('div.field', h('label', { text: '音色 ID' }), remoteId,
      h('div.hint', { text: '不填也行，从下面列表里点一条会自动填入。' })),
    picker.node
  );

  const uploadBox = h('div.col.gap-16',
    h('div.field',
      h('label', { text: '音频文件' }), file,
      h('div.hint', { text: 'WAV / MP3 / M4A / FLAC / OGG。建议 5-30 秒、单人、无背景音乐。托管版上限 5MB / 最短 3 秒。' })
    ),
    h('div.field',
      h('label', { text: '参考文本' }), refText,
      h('div.hint', { text: '自托管 breeze-tts-2 必须填写；托管版由服务自动转写，可不填。' })
    ),
    h('label.checkbox', consent,
      h('span', { text: '我确认已获得该声音所有者的明确授权，仅用于个人回顾用途，不用于冒充、诈骗或任何违法场景。' }))
  );

  const syncMode = () => {
    segPick.setAttribute('aria-selected', String(mode === 'pick'));
    segUpload.setAttribute('aria-selected', String(mode === 'upload'));
    err.textContent = '';
    pickBox.style.display = mode === 'pick' ? '' : 'none';
    uploadBox.style.display = mode === 'upload' ? '' : 'none';
  };
  syncMode();

  modal({
    title: '添加音色',
    body: h('div.col.gap-16', seg, nameField, pickBox, uploadBox, err),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '添加', kind: 'copper',
        onClick: async () => {
          err.textContent = '';
          const vid = remoteId.value.trim() || picker.getSelected() || '';
          if (mode === 'pick') {
            if (!name.value.trim()) { err.textContent = '请填写音色名称'; return false; }
            if (!vid) { err.textContent = '请从列表里选一个音色，或直接填写音色 ID'; return false; }
            try {
              await api.post('/api/voice-refs', { name: name.value.trim(), remoteVoiceId: vid });
              toast('已添加', 'ok');
              navigate('/app/settings/keys');
            } catch (e) {
              if (e.code === 'DUPLICATE') { err.textContent = '这个音色已经添加过了'; return false; }
              err.textContent = e.message; return false;
            }
            return;
          }
          if (!name.value.trim()) { err.textContent = '请填写名称'; return false; }
          if (!file.files[0]) { err.textContent = '请选择音频文件'; return false; }
          if (!consent.checked) { err.textContent = '必须确认已获授权'; return false; }
          const fd = new FormData();
          fd.append('name', name.value.trim());
          fd.append('audio', file.files[0], file.files[0].name);
          fd.append('refText', refText.value.trim());
          fd.append('consent', 'true');
          try {
            await api.form('/api/voice-refs', fd);
            toast('已上传', 'ok');
            navigate('/app/settings/keys');
          } catch (e) { err.textContent = e.message; return false; }
        },
      },
    ],
  });
}

function voiceEditForm(v) {
  const name = h('input', { type: 'text', value: v.name });
  const refText = h('textarea', { rows: 3, value: v.refText || '' });
  const remote = h('input', { type: 'text', value: v.remoteVoiceId || '', placeholder: '例如 voc_xxxx（也可用下面的列表挑）' });

  const picker = voicePicker({
    onPick: (x) => { remote.value = x.voiceId; toast('已填入 voice_id：' + x.voiceId, 'ok'); },
  });

  modal({
    title: '编辑音色',
    body: h('div.col.gap-16',
      h('div.field', h('label', { text: '名称' }), name),
      h('div.field', h('label', { text: '参考文本' }), refText),
      h('div.field', h('label', { text: '远端 voice_id' }), remote,
        h('div.hint', { text: '留空就用你上传的参考音频克隆；想直接复用账号里已有的音色，从下面挑一个。' })),
      picker.node
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          await api.patch(`/api/voice-refs/${v.id}`, {
            name: name.value.trim(), refText: refText.value.trim(), remoteVoiceId: remote.value.trim(),
          });
          toast('已保存');
          navigate('/app/settings/keys');
        },
      },
    ],
  });
}

/* ================================================================== *
 * Account tab
 * ================================================================== */
async function accountTab() {
  const u = state.user;
  const wrap = h('div.col.gap-16');
  const avatarInput = h('input', {
    type: 'file', accept: 'image/*', style: { display: 'none' },
    onchange: async () => {
      const f = avatarInput.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        await api.form('/api/me/avatar', fd);
        toast('头像已更新', 'ok');
        const s = await api.get('/api/auth/session');
        state.user = s.user;
        navigate('/app/settings/account');
      } catch (e) { toast(e.message, 'err'); }
    },
  });

  /* 聊天界面外观 —— 两套可选。
   * 这是"聊天页长什么样"，不是全站换肤：其它页面在这个开关下完全不变。
   * 选择存在账号上（users.ui_theme），所以换设备、换浏览器都是一致的。 */
  wrap.append(themeCard());

  /* profile */
  const nameInput = h('input', { type: 'text', value: u.displayName || '', maxlength: 60 });
  wrap.append(h('div.card',
    h('div.card-title', { text: '个人资料' }),
    h('div.row.gap-16.mb-16',
      avatar(u.displayName || u.email, u.avatarPath ? `/api/avatar/${u.avatarPath}` : null, 72),
      h('div',
        h('button.btn.btn-sm', { type: 'button', onclick: () => avatarInput.click() }, '更换头像'),
        avatarInput,
        h('div.tiny.dim.mt-8', { text: 'PNG / JPG / WEBP / GIF，最大 4MB' })
      )
    ),
    h('div.form-grid',
      h('div.field', h('label', { text: '昵称' }), nameInput),
      h('div.field', h('label', { text: '邮箱' }),
        h('input', { type: 'email', value: u.email, disabled: true }),
        h('div.hint', { text: '修改邮箱请使用下方的「修改邮箱」功能。' })
      )
    ),
    h('button.btn.btn-primary.btn-sm.mt-16', {
      type: 'button',
      onclick: async () => {
        await api.patch('/api/me', { displayName: nameInput.value.trim() });
        const s = await api.get('/api/auth/session');
        state.user = s.user;
        toast('已保存', 'ok');
      },
    }, '保存资料')
  ));

  /* password
   *
   * 微信/手机号登录建的账号**没有密码**（服务端存的是哨兵哈希）。
   * 这时候如果还显示「当前密码 + 新密码」，「当前密码」这一格他永远填不对——
   * 于是页面看起来像坏了。所以这里按 hasPassword 分成两种表单：
   *   有密码 → 改密码（必须验旧密码）
   *   没密码 → 设密码（同时允许填真实邮箱，否则以后没法用邮箱登录）
   */
  const noPassword = u.hasPassword === false;
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const curPw = noPassword ? null : h('input', { type: 'password', autocomplete: 'current-password' });
  const setEmail = noPassword
    ? h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' })
    : null;

  wrap.append(h('div.card',
    h('div.card-title', { text: noPassword ? '设置密码' : '修改密码' }),
    noPassword
      ? h('div.hint.mb-16', {
        text: '你是用微信/手机号登录的，目前没有密码。设置一个之后，就可以用邮箱密码登录了。',
      })
      : null,
    h('div.form-grid',
      noPassword ? null : h('div.field', h('label', { text: '当前密码' }), curPw),
      h('div.field', h('label', { text: '新密码' }), newPw, h('div.hint', { text: '至少 8 位，含字母和数字' })),
      noPassword
        ? h('div.field', h('label', { text: '邮箱（可选）' }), setEmail,
          h('div.hint', { text: '填了之后可以用邮箱登录；不填就只能用微信/手机号进。' }))
        : null
    ),
    h('button.btn.btn-sm.mt-16', {
      type: 'button',
      onclick: async () => {
        try {
          if (noPassword) {
            await api.post('/api/me/password/first', {
              newPassword: newPw.value,
              ...(setEmail.value.trim() ? { email: setEmail.value.trim() } : {}),
            });
            const s = await api.get('/api/auth/session');
            state.user = s.user;
            toast('密码已设置，现在可以用邮箱登录了', 'ok');
            navigate('/app/settings/account');
            return;
          }
          await api.post('/api/me/password', { currentPassword: curPw.value, newPassword: newPw.value });
          curPw.value = ''; newPw.value = '';
          toast('密码已修改，其他设备已退出登录', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      },
    }, noPassword ? '设置密码' : '修改密码')
  ));

  /* email
   *
   * 无密码账号不显示这张卡：它要求「当前密码」才能改邮箱，
   * 而这类账号根本没有密码。给他一张填不出来的表单只会让人以为坏了。
   * 补设密码那个卡片里已经带了「邮箱（可选）」，能一次性解决。
   */
  if (!noPassword) {
    const newEmail = h('input', { type: 'email' });
    const emailPw = h('input', { type: 'password', autocomplete: 'current-password' });
    wrap.append(h('div.card',
      h('div.card-title', { text: '修改邮箱' }),
      h('div.form-grid',
        h('div.field', h('label', { text: '新邮箱' }), newEmail),
        h('div.field', h('label', { text: '当前密码' }), emailPw)
      ),
      h('button.btn.btn-sm.mt-16', {
        type: 'button',
        onclick: async () => {
          try {
            await api.post('/api/me/email', { email: newEmail.value.trim(), password: emailPw.value });
            const s = await api.get('/api/auth/session');
            state.user = s.user;
            newEmail.value = ''; emailPw.value = '';
            toast('邮箱已更新', 'ok');
            navigate('/app/settings/account');
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '更新邮箱')
    ));
  }

  /* 登录方式：邮箱 + 已绑定的微信/手机号
   *
   * 这张卡是「用户能自己救自己」的入口：
   *   • 看到自己绑了什么 → 不会出现「我明明绑过微信，怎么不见了」
   *   • 能解绑 → 但服务端会在「解绑后一个都不剩」时拒绝（防锁死）
   */
  const idr = await api.get('/api/me/identities').catch(() => null);
  const providerLabel = { wechat: '微信', phone: '手机号' };
  wrap.append(h('div.card',
    h('div.card-title', { text: '登录方式' }),
    h('div.sender-row',
      h('span.dot-ok', { text: '●' }),
      h('div.grow',
        h('div.small', { text: '邮箱 + 密码' }),
        h('div.tiny.dim', {
          text: u.placeholderEmail
            ? '尚未设置（你还没设过密码，所以目前不能用邮箱登录）'
            : u.email,
        })
      )
    ),
    ...((idr?.identities || []).map((x) => h('div.sender-row',
      h('span.dot-ok', { text: '●' }),
      h('div.grow',
        h('div.small', { text: providerLabel[x.provider] || x.provider }),
        h('div.tiny.dim', { text: x.subject })
      ),
      h('button.btn.btn-sm.btn-ghost', {
        type: 'button',
        onclick: async () => {
          try {
            await api.del(`/api/me/identities/${x.provider}`);
            toast(`已解绑${providerLabel[x.provider] || x.provider}`, 'ok');
            navigate('/app/settings/account');
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '解绑')
    ))),
    (idr?.identities || []).length === 0
      ? h('div.tiny.dim.mt-8', { text: '还没有绑定微信或手机号。在登录页用它们登录一次，即可自动绑定。' })
      : null,
    // 只剩一种登录方式且无密码时，解绑按钮点了必然被拒 —— 提前说清楚
    idr && idr.canUnbind === false
      ? h('div.hint.mt-8', { text: '你还没有设置密码，所以现在不能解绑唯一的登录方式，否则会进不来。' })
      : null
  ));

  /* sessions */
  const sess = await api.get('/api/me/sessions').then((r) => r.sessions).catch(() => []);
  wrap.append(h('div.card',
    h('div.between.mb-16',
      h('div.card-title', { style: { marginBottom: 0 }, text: '登录设备' }),
      h('button.btn.btn-sm', {
        type: 'button',
        onclick: async () => {
          await api.post('/api/me/sessions/revoke-others');
          toast('其他设备已退出', 'ok');
          navigate('/app/settings/account');
        },
      }, '退出其他设备')
    ),
    h('div', ...sess.map((s) => h('div.sender-row',
      h('span', { style: { color: s.current ? 'var(--sage)' : 'var(--ink-4)' }, text: s.current ? '●' : '○' }),
      h('div.grow', { style: { minWidth: 0 } },
        h('div.small', { text: s.current ? '当前设备' : (s.userAgent || '未知设备').slice(0, 58) }),
        h('div.tiny.dim', { text: `${s.ip || '—'} · 最近活跃 ${fmtRelative(s.lastSeen)}` })
      )
    )))
  ));

  /* data */
  wrap.append(h('div.card',
    h('div.card-title', { text: '数据与隐私' }),
    h('div.col.gap-8',
      h('div.between',
        h('div', h('div.small', { text: '导出我的全部数据' }),
          h('div.tiny.dim', { text: 'JSON 格式：人格、档案、记忆、对话与导入记录。不含密钥。' })),
        h('a.btn.btn-sm', { href: '/api/me/export', download: '' }, '下载')
      ),
      h('div.between',
        h('div', h('div.small', { text: '删除全部数据并注销账户' }),
          h('div.tiny.dim', { text: '永久删除所有聊天记录、人格、记忆与音频。操作不可恢复。' })),
        h('button.btn.btn-danger.btn-sm', {
          type: 'button',
          onclick: () => deleteAccountFlow(),
        }, '注销账户')
      )
    ),
    h('div.divider'),
    h('div.tiny.dim',
      h('p', { style: { margin: '0 0 6px' }, text: '你的数据如何被使用：' }),
      h('ul', { style: { margin: 0, paddingLeft: '18px', lineHeight: '1.8' } },
        h('li', { text: '聊天记录仅用于为你本人构建人格与记忆，不会用于训练任何模型。' }),
        h('li', { text: '调用大模型与语音服务时，相关文本会发送到你自己配置的服务商。' }),
        h('li', { text: 'API Key 使用 AES-256-GCM 加密存储，密钥来自服务器环境变量，数据库泄露也无法直接解密。' }),
        h('li', { text: '管理员只能看到账户数量与系统运行状态，看不到你的聊天内容和密钥。' })
      )
    )
  ));

  return wrap;
}

function deleteAccountFlow() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const confirm = h('input', { type: 'text', placeholder: '输入 DELETE' });
  const err = h('div.tiny', { style: { color: 'var(--danger)' } });
  modal({
    title: '注销账户',
    body: h('div.col.gap-16',
      h('div', {
        style: { padding: '12px 14px', background: 'var(--danger-soft)', borderRadius: '8px', fontSize: '0.83rem', color: 'var(--danger)', lineHeight: '1.65' },
      }, '此操作会永久删除：所有人格、聊天记录、长期记忆、人格档案、生成的语音文件、API 配置。删除后无法恢复，也无法找回。'),
      h('div.field', h('label', { text: '当前密码' }), pw),
      h('div.field', h('label', { text: '确认文字' }), confirm, h('div.hint', { text: '请输入大写 DELETE' })),
      err
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '永久删除', kind: 'danger',
        onClick: async () => {
          if (confirm.value !== 'DELETE') { err.textContent = '确认文字不正确'; return false; }
          try {
            await api.del('/api/me', { password: pw.value, confirm: 'DELETE' });
          } catch (e) {
            // api.del has no body; do a manual fetch
            const r = await fetch('/api/me', {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ password: pw.value, confirm: 'DELETE' }),
            });
            if (!r.ok) {
              const b = await r.json().catch(() => ({}));
              err.textContent = b.error || '删除失败';
              return false;
            }
          }
          state.user = null;
          state.personas = [];
          toast('账户已删除');
          navigate('/');
        },
      },
    ],
  });
}

/* ================================================================== *
 * Voice library page
 * ================================================================== */
/* 语音页曾经和设置页大面积重叠：
 *   「语音」里能配 TTS、能管理音色；「设置 → API 配置」里也能配 TTS、管音色；
 *   两边各写了一套表单，改一处忘另一处就会出现「在这边改了那边没生效」。
 * 现在语音页只做三件设置页不该管的事：听效果、管音色、看生成历史。
 * 服务配置统一收在「设置 → 模型与语音」，语音页只留一个跳转提示。
 */
export async function voicePage() {
  if (!requireUser()) return;
  setTitle('语音');

  /* 这里刻意**不**列历史生成的音频。
   *
   * 语音是对话的副产品：聊几十轮就攒下几十条，页面被一堆「播放/下载」
   * 淹没，真正要管理的参考音色被挤到屏幕外面。而且那些音频在对话里
   * 本来就是原地播的，再做一个总列表没有新增任何能力。
   *
   * 需要清理时按消息走（对话里删消息会带走它的音频），或者用
   * TTS_CACHE_DAYS 让服务端自动过期。 */
  const [ttss, voices] = await Promise.all([
    api.get('/api/tts-configs').then((r) => r.configs).catch(() => []),
    api.get('/api/voice-refs').then((r) => r.voices).catch(() => []),
  ]);

  const content = h('div',
    h('div.between.mb-24',
      h('div',
        h('h1', { style: { fontSize: '1.55rem', marginBottom: '4px' }, text: '语音' }),
        h('p.muted.small', { style: { margin: 0 }, text: '管理 TA 说话用的参考音色。' })
      ),
      h('a.btn', { href: '/app/settings/keys' }, '配置语音服务')
    ),
    !ttss.length
      ? h('div.card.mb-16', { style: { borderColor: '#e5d6c6', background: 'var(--copper-tint)' } },
          h('div.between',
            h('div',
              h('div', { style: { fontWeight: '600', marginBottom: '3px' }, text: '还没有配置语音服务' }),
              h('div.small.muted', { text: '语音是可选功能。配置 BreezeTTS 后，TA 可以像微信里那样直接给你发语音。' })
            ),
            h('a.btn.btn-copper.btn-sm', { href: '/app/settings/keys' }, '去配置')
          ))
      : null,
    h('div.card',
      h('div.between.mb-16',
        h('div.card-title', { style: { marginBottom: 0 }, text: `参考音色（${voices.length}）` }),
        h('button.btn.btn-sm', { type: 'button', onclick: () => voiceUploadForm() }, '＋ 添加音色')
      ),
      voices.length
        ? h('div.col.gap-8', ...voices.map((v) => h('div', {
            style: { padding: '11px 14px', border: '1px solid var(--line)', borderRadius: '10px' },
          },
            h('div.between',
              h('div', { style: { minWidth: 0 } },
                h('div.row.gap-8',
                  h('b', { style: { fontSize: '0.88rem' }, text: v.name }),
                  v.isDefault ? h('span.badge.badge-copper', { text: '默认' }) : null,
                  v.remoteVoiceId ? h('span.badge.badge-sage', { text: '已绑定 ID' }) : h('span.badge', { text: '仅本地' })
                ),
                h('div.tiny.dim', { text: v.remoteVoiceId ? v.remoteVoiceId : (v.refText || '未填参考文本') })
              ),
              h('div.row.gap-4',
                v.hasAudio ? h('button.btn.btn-sm', {
                  type: 'button',
                  onclick: () => new Audio(v.audioUrl).play().catch(() => toast('播放失败', 'err')),
                }, '试听') : null,
                (!v.remoteVoiceId && ttss.some((t) => t.kind !== 'breeze_local'))
                  ? h('button.btn.btn-sm', {
                      type: 'button',
                      onclick: async (e) => {
                        const btn = e.currentTarget;
                        btn.disabled = true; btn.replaceChildren(h('span.spin'));
                        try {
                          await api.post(`/api/voice-refs/${v.id}/clone`, { language: 'zh' });
                          toast('克隆完成', 'ok');
                          navigate('/app/voice');
                        } catch (ex) { toast(ex.message, 'err'); }
                        btn.disabled = false; btn.textContent = '克隆';
                      },
                    }, '克隆到 Breeze')
                  : null,
                !v.isDefault ? h('button.btn.btn-sm', {
                  type: 'button',
                  onclick: async () => {
                    await api.post(`/api/voice-refs/${v.id}/default`);
                    navigate('/app/voice');
                  },
                }, '设为默认') : null,
                h('button.btn.btn-ghost.btn-icon.btn-sm', {
                  type: 'button', 'aria-label': '编辑',
                  onclick: () => voiceEditForm(v),
                }, '✎'),
                h('button.btn.btn-ghost.btn-icon.btn-sm', {
                  type: 'button', 'aria-label': '删除',
                  onclick: async () => {
                    if (!await confirmDialog({
                      title: '删除音色？',
                      message: `「${v.name}」的参考音频与远端克隆都会被删除。`,
                      confirmLabel: '删除', danger: true,
                    })) return;
                    await api.del(`/api/voice-refs/${v.id}`);
                    toast('已删除');
                    navigate('/app/voice');
                  },
                }, '✕')
              )
            )
          )))
        : h('div.empty', { style: { padding: '28px 16px' } },
            h('p.small.muted', { text: '直接选一个服务商现成的音色 ID，或上传一段已获授权的参考音频克隆。' }),
            h('button.btn.btn-copper.btn-sm', { type: 'button', onclick: () => voiceUploadForm() }, '添加音色'))
    )
  );

  return shell({ active: 'voice', title: '语音', content: h('div', { style: { maxWidth: '860px' } }, content) });
}

/* ================================================================== *
 * Admin
 * ================================================================== */
export async function adminPage(tab = 'overview') {
  if (!requireUser()) return;
  if (!state.user?.isAdmin) {
    return shell({ active: 'dashboard', title: '管理', content: h('div.empty', h('h3', { text: '无权访问' })) });
  }
  setTitle('管理后台');

  const ov = await api.get('/api/admin/overview').catch(() => null);
  const sys = await api.get('/api/admin/system').catch(() => null);
  const users = await api.get('/api/admin/users').catch(() => ({ users: [] }));
  const jobs = await api.get('/api/admin/jobs').catch(() => ({ jobs: [] }));
  const backups = await api.get('/api/admin/backups').catch(() => ({ backups: [] }));

  const content = h('div',
    h('div.between.mb-24',
      h('div',
        h('h1', { style: { fontSize: '1.55rem', marginBottom: '4px' }, text: '管理后台' }),
        h('p.muted.small', { style: { margin: 0 }, text: '系统运行状态与容量。这里看不到任何用户的聊天内容或密钥。' })
      ),
      h('button.btn.btn-sm', {
        type: 'button',
        onclick: async () => {
          try {
            const r = await api.post('/api/admin/backup');
            toast(`备份完成：${r.file}（${fmtBytes(r.bytes)}）`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        },
      }, '立即备份')
    ),

    ov ? h('div.stat-row',
      adminStat('用户', ov.users, `${ov.newUsers7} 个新用户 / 7天`),
      adminStat('人格', ov.personas, `${ov.memories} 条记忆`),
      adminStat('消息', ov.messages.toLocaleString(), `${ov.imports} 次导入`),
      adminStat('运行时长', `${Math.floor(ov.uptimeSec / 3600)}h`, `${ov.activeSessions} 个活跃会话`)
    ) : null,

    h('div.two-col',
      h('div.col.gap-16',
        h('div.card.card-tight',
          h('div.card-title', { text: `用户（最近 ${users.users.length}）` }),
          users.users.length
            ? h('div', ...users.users.map((u) => h('div.sender-row',
                avatar(u.displayName || u.email, null, 28),
                h('div.grow', { style: { minWidth: 0 } },
                  h('div.small', { text: u.displayName || '—' }),
                  h('div.tiny.dim', { text: `${u.email} · 注册 ${fmtDate(u.createdAt)}` })
                ),
                h('span.badge', { text: `${u.personaCount} 人格` }),
                u.role === 'admin' ? h('span.badge.badge-copper', { text: '管理员' }) : null,
                u.status === 'suspended' ? h('span.badge.badge-danger', { text: '已停用' }) : null,
                u.role !== 'admin' ? h('button.btn.btn-ghost.btn-icon.btn-sm', {
                  type: 'button', title: u.status === 'suspended' ? '恢复' : '停用',
                  onclick: async () => {
                    const next = u.status === 'suspended' ? 'active' : 'suspended';
                    if (next === 'suspended' && !await confirmDialog({
                      title: '停用该账户？', message: `${u.email} 将立即被登出且无法登录。`, confirmLabel: '停用', danger: true,
                    })) return;
                    await api.post(`/api/admin/users/${u.id}/status`, { status: next });
                    toast('已更新');
                    navigate('/app/admin');
                  },
                }, u.status === 'suspended' ? '↺' : '⊘') : null
              )))
            : h('p.small.muted', { text: '暂无用户' })
        ),
        h('div.card.card-tight',
          h('div.card-title', { text: '任务队列' }),
          jobs.jobs.length
            ? h('div', ...jobs.jobs.slice(0, 12).map((j) => h('div.sender-row',
                h('span', {
                  style: { color: j.status === 'done' ? 'var(--sage)' : j.status === 'failed' ? 'var(--danger)' : 'var(--amber)' },
                  text: j.status === 'done' ? '✓' : j.status === 'failed' ? '!' : '◌',
                }),
                h('div.grow', { style: { minWidth: 0 } },
                  h('div.small', { text: `${j.type} · ${j.email || '—'}` }),
                  h('div.tiny.dim', { text: `${j.stage || ''} ${Math.round((j.progress || 0) * 100)}% · ${fmtRelative(j.createdAt)}` })
                ),
                j.error ? h('span.badge.badge-danger', { text: '失败' }) : null
              )))
            : h('p.small.muted', { text: '没有任务' })
        )
      ),
      h('div.col.gap-16',
        sys ? h('div.card.card-tight',
          h('div.card-title', { text: '系统资源' }),
          h('dl.kv',
            h('dt', { text: '内存' }), h('dd', {
              text: `${fmtBytes(sys.memory.rss)} / ${fmtBytes(sys.system.totalMem)}`,
            }),
            h('dt', { text: 'CPU' }), h('dd', { text: `${sys.system.cpus} 核 · load ${sys.system.load1.toFixed(2)}` }),
            h('dt', { text: 'Node' }), h('dd', { text: `${ov?.node || ''} · ${ov?.env || ''}` }),
            h('dt', { text: '运行时长' }), h('dd', { text: `${Math.floor(sys.uptimeSec / 3600)}h ${Math.floor((sys.uptimeSec % 3600) / 60)}m` })
          ),
          h('div.divider'),
          h('div.card-title', { text: '存储使用' }),
          h('dl.kv',
            h('dt', { text: '数据库' }), h('dd', { text: fmtBytes(sys.storage.database) }),
            h('dt', { text: '上传文件' }), h('dd', { text: fmtBytes(sys.storage.uploads) }),
            h('dt', { text: '语音文件' }), h('dd', { text: fmtBytes(sys.storage.audio) }),
            h('dt', { text: '备份' }), h('dd', { text: fmtBytes(sys.storage.backups) })
          ),
          h('div.row.gap-8.mt-16',
            h('button.btn.btn-sm', {
              type: 'button',
              onclick: async () => {
                const r = await api.post('/api/admin/maintenance/cleanup');
                toast(`清理完成：${r.staleSessions} 会话 / ${r.expiredTokens} 令牌 / ${r.oldAuditLogs} 日志`);
              },
            }, '清理过期数据'),
            h('button.btn.btn-sm', {
              type: 'button',
              onclick: async () => {
                await api.post('/api/admin/maintenance/vacuum');
                toast('数据库已压缩', 'ok');
              },
            }, 'VACUUM')
          )
        ) : null,
        h('div.card.card-tight',
          h('div.card-title', { text: `备份（${backups.backups.length}）` }),
          backups.backups.length
            ? h('div', ...backups.backups.slice(0, 8).map((b) => h('div.sender-row',
                h('span', { style: { color: 'var(--sage)' }, text: '▤' }),
                h('div.grow', { style: { minWidth: 0 } },
                  h('div.tiny.mono.truncate', { text: b.name }),
                  h('div.tiny.dim', { text: fmtBytes(b.bytes) })
                )
              )))
            : h('p.small.muted', { text: '还没有备份。生产环境建议开启自动备份。' })
        )
      )
    )
  );

  return shell({ active: 'dashboard', title: '管理后台', content });
}

function adminStat(k, v, d) {
  return h('div.stat',
    h('div.k', { text: k }),
    h('div.v', { text: String(v) }),
    h('div.d', { text: d })
  );
}
