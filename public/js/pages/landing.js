import { h, mount, navigate, svgIcon } from '../core.js';
import { state, loadSession, setTitle } from '../shell.js';

export function landingPage() {
  setTitle('');

  const nav = h('header.land-nav',
    h('a.brand', { href: '/' },
      h('span.mark', { text: 'E' }),
      h('span', { text: 'EchoPersona' })
    ),
    h('div.links',
      h('a', { href: '#how', text: '如何运作' }),
      h('a', { href: '#features', text: '能力' }),
      h('a', { href: '#ethics', text: '伦理边界' })
    ),
    h('div.actions',
      state.user
        ? h('a.btn.btn-primary', { href: '/app' }, '进入工作台')
        : [
            h('a.btn.btn-ghost', { href: '/login' }, '登录'),
            h('a.btn.btn-primary', { href: '/register' }, '开始使用'),
          ]
    )
  );

  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  const mockBubbles = [
    { side: 'them', text: '今天下班又是十点半，地铁上人还是好多。', delay: 120 },
    { side: 'me', text: '又加班？你们组是不要人活了吧', delay: 420 },
    { side: 'them', text: '害，习惯了，反正回去也是一个人待着。', delay: 760 },
    { side: 'them', text: '你呢，今天吃得还行吗', delay: 1080 },
  ];

  const mockBody = h('div.mock-body');
  for (const b of mockBubbles) {
    const el = h(`div.bubble.${b.side === 'them' ? 'them' : 'me'}`, { text: b.text });
    el.style.animationDelay = `${b.delay}ms`;
    mockBody.append(el);
  }
  const typing = h('div.bubble.them', { style: { display: 'none' } },
    h('span.typing', h('i'), h('i'), h('i')));
  mockBody.append(typing);
  setTimeout(() => { typing.style.display = ''; typing.style.animationDelay = '0ms'; }, 1500);

  const hero = h('section.hero',
    h('div.hero-copy',
      h('div.eyebrow', { text: 'AI 人格复刻' }),
      h('h1', { html: '让那些熟悉的语气，<br>继续<em>说下去</em>。' }),
      h('p.hero-lede', {
        text: '导入你们的聊天记录，EchoPersona 会分析对方的语言习惯、性格特征与共同记忆，'
          + '生成一个能持续对话的人格。用你自己的大模型和语音服务，数据留在你自己的账户里。',
      }),
      h('div.hero-cta',
        state.user
          ? h('a.btn.btn-copper.btn-lg', { href: '/app' }, '进入工作台')
          : [
              h('a.btn.btn-copper.btn-lg', { href: '/register' }, '免费创建人格'),
              h('a.btn.btn-lg', { href: '/login' }, '已有账户'),
            ]
      ),
      h('p.hero-note', { text: '无需训练模型 · 自备 API Key · 数据按账户隔离' })
    ),
    h('div.hero-visual',
      h('div.mock',
        h('div.mock-head',
          h('div.av.av-34', { text: '小满' }),
          h('div',
            h('div', { style: { fontWeight: '650', fontSize: '0.9rem' }, text: '林小满' }),
            h('div.tiny.dim', { text: 'AI 人格模拟 · 基于 3,842 条聊天记录' })
          )
        ),
        mockBody
      )
    )
  );

  const flow = h('div.flow-strip', { id: 'how' },
    ...[
      ['01', '导入记录', '上传你与 TA 的 TXT / JSON / CSV / Markdown 聊天记录，或直接打包 ZIP。'],
      ['02', '自动分析', '用你自己的大模型提取语言风格、性格倾向、共同记忆与口头禅。'],
      ['03', '建立记忆', '聊天记录切片索引，按话题召回相关往事，而不是每次塞进全部对话。'],
      ['04', '开始对话', '文字流式回复，可选语音输出。三种模仿强度，随时切换。'],
    ].map(([n, t, d]) => h('div.flow-step',
      h('span.n', { text: n }),
      h('h4', { text: t }),
      h('p', { text: d })
    ))
  );

  const features = h('section.section', { id: 'features' },
    h('div.section-head',
      h('h2', { text: '不是套模板的角色扮演' }),
      h('p', { text: '一个固定提示词写不出一个人的说话方式。EchoPersona 用真实样本 + 结构化档案 + 长期记忆三层叠加。' })
    ),
    h('div.feature-grid',
      ...[
        ['icFingerprint', '语言指纹分析', '句长分布、标点习惯、语气词频率、表情符号比例，先用统计算出客观特征，再让模型解释语义。'],
        ['icLayers', '结构化人格档案', '语言风格、性格推测、关系记忆、原话样本分开存储，每一项都带证据来源与可信度，可手动修订。'],
        ['icMemory', '混合记忆检索', '向量检索 + 关键词检索双路召回，按重要度与时间衰减重排。无关记忆不会干扰回答。'],
        ['icWave', '真实语音输出', '对接你自己配置的 BreezeTTS 服务，支持参考音频克隆、语速音量调整、音频缓存与重试。'],
        ['icKey', '密钥只在你手里', 'API Key 服务端加密存储，浏览器永远拿不到明文。所有调用走服务端代理，日志自动脱敏。'],
        ['icQuestion', '承认不知道', 'AI 不知道的事会说不确定，不会编造真实人物的经历。人格身份始终标注为模拟。'],
      ].map(([ic, t, d]) => h('div.feature',
        h('div.fi', svgIcon(ic)),
        h('h3', { text: t }),
        h('p', { text: d })
      ))
    )
  );

  const ethics = h('section.ethics', { id: 'ethics' },
    h('div.ethics-inner',
      h('h3', { text: '关于边界，我们把话说清楚' }),
      h('p.small', { style: { color: 'var(--ink-2)', maxWidth: '62ch' }, text:
        '这个工具是用来保存语言记忆的，不是用来冒充真人的。以下是我们坚持的规则：' }),
      h('div.ethics-list',
        h('div', { text: '所有 AI 回复都会标注为「AI 人格模拟」，不冒充真实人物。' }),
        h('div', { text: '只有你上传的记录会被使用，我们不会用你的数据训练任何模型。' }),
        h('div', { text: '克隆他人声音必须取得声音所有者的明确授权，上传时需确认。' }),
        h('div', { text: '性格结论是基于文本的推测，不是心理诊断，也不应当作对方的真实想法。' }),
        h('div', { text: '账户注销会彻底删除聊天记录、人格档案、记忆与音频文件。' }),
        h('div', { text: '不同账户之间数据完全隔离，管理员也无法查看你的聊天内容与密钥。' })
      )
    )
  );

  const foot = h('footer.land-foot',
    h('span', { text: '© 2026 EchoPersona' }),
    h('a', { href: '/login', text: '登录' }),
    h('a', { href: '/register', text: '注册' }),
    h('span.grow'),
    h('span', { text: 'AI 生成内容仅供个人回顾与创作参考' })
  );

  mount(h('div.landing', nav, hero, flow, features, ethics, foot));
  window.scrollTo(0, 0);
}
