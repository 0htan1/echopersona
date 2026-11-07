# EchoPersona 技术架构

本文档说明技术选型的理由、系统结构、数据模型与安全设计。
需求文档里要求「先说明技术栈理由再开发」，这里是完整交代。

---

## 1. 技术栈与选型理由

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | **Node.js 22** | 需要内置 `node:sqlite`（22.5+）。实测 `FTS5 OK` / `WAL OK` / BLOB 可用 |
| Web 框架 | **Fastify 5** | 单核 2GB VPS 上常驻约 80–150 MB；SSE 流式原生支持；序列化开销低 |
| 数据库 | **SQLite（内置驱动）** | 零 `node-gyp`，生产环境不需要编译器；单文件便于备份；WAL 模式支持并发读 |
| 全文检索 | **SQLite FTS5，缺失时降级 LIKE** | 应用层自己做中文分词后写入索引，避免引入 ES。注意 FTS5 不是所有 Node 构建都带（见 §2.1） |
| 向量检索 | **内存暴力余弦** | 数千个 chunk 量级下 <5ms，省掉向量数据库这一整套运维 |
| 加密 | **node:crypto** AES-256-GCM / scrypt | 标准库即可，无第三方依赖 |
| HTTP 客户端 | **undici** | 支持自定义 DNS `lookup`，这是实现 SSRF 防护的关键 |
| 前端 | **原生 ESM，无构建链** | 部署=拷文件；CSP 友好；没有 webpack/vite 版本地狱 |
| 进程管理 | **systemd**（PM2 可选） | 系统自带，开机自启与日志都现成 |

### 2.1 FTS5 可用性不是必然的

`node:sqlite` 是 Node 自带的 SQLite 编译产物，**编译选项随发行版而变**。
官方 Windows/macOS 安装包带 FTS5，但精简构建和部分托管沙箱**没有**——
在这种环境里执行 `CREATE VIRTUAL TABLE ... USING fts5` 会直接报
`no such module: fts5`，让整个服务起不来。

这一点在真实部署中踩到过：本地 96 项测试全绿，上线却启动失败。

处理方式是**探测 + 降级**，而不是让服务躺下：

- `hasFts()` 用一次内存探测判断当前构建是否支持 FTS5；
- 不支持时，建表阶段剔除 FTS 虚表，业务表照常创建；
- 记忆检索改走 `likeSearch()`：复用同一套 CJK bigram 分词，对
  `content` 做 `LIKE` 匹配，按命中词元数排序（语义上接近 bm25 的排序意图）；
- 索引写入/删除处全部加 `hasFts()` 保护，避免访问不存在的表。

降级后**关键词检索依然有效**（已实测「面馆」「加班」都能精确命中对应记忆），
损失的是 bm25 的排序质量与大数据量下的检索速度；向量检索路径完全不受影响。
一旦部署到带 FTS5 的 Node 构建上，下次启动会自动重新启用全文索引。


### 为什么不用 Next.js / React / Prisma / Postgres

- **不用 React/Next**：本项目的界面重心是一个聊天页，交互密集但页面数少。引入构建链只会让部署多一个 `npm run build` 失败点，而收益（组件生态）在这里用不上。原生模块 + 手写 hyperscript 已经足够。
- **不用 Prisma**：Prisma 需要生成 client、有 native 引擎二进制，部署到 Alpine 或小内存机器经常出问题。本项目的查询都是明确的手写 SQL，可读性和可控性更好。
- **不用 Postgres**：单机、单租户量级下，PG 带来的运维成本（连接池、备份、版本升级）远大于收益。SQLite 的 `VACUUM INTO` 一行就能做一致快照。迁移路径已在 DEPLOY.md 写清。

**代价也要说清楚**：SQLite 只能单实例，不能横向扩；全文检索的中文分词要靠应用层自己处理（已实现）；向量检索是 O(n) 暴力扫描，记忆量到十万级需要换 pgvector。

---

## 2. 系统结构

```
浏览器 (原生 ESM SPA)
    │  HTTPS
    ▼
Nginx ── TLS 终止 / 静态资源 / SSE 关闭缓冲
    │  127.0.0.1:8080
    ▼
Fastify 应用
    ├── lib/session.js      会话钩子 + requireAuth/requireAdmin（根实例）
    ├── routes/auth.js      注册/登录/改密/改邮箱/导出/删号
    ├── routes/configs.js   LLM & TTS & 参考音频
    ├── routes/personas.js  人格 CRUD / 分析任务 / 记忆 / 画像
    ├── routes/imports.js   上传 / 解析 / 预览 / 发送者映射
    ├── routes/chat.js      SSE 流式对话 / 重生成
    ├── routes/voice.js     TTS 合成 / 音频服务(Range) / 重试
    └── routes/admin.js     后台统计（不含用户内容）
    │
    ├── lib/crypto.js       scrypt 口令 / AES-256-GCM 密钥加密
    ├── lib/net.js          SSRF 校验 + DNS 钉扎 + multipart 构造
    ├── lib/llm.js          OpenAI 兼容：chat / stream / embed / models
    ├── lib/tts.js          Breeze 双协议适配 + 自动探测
    ├── lib/parsers.js      TXT/JSON/CSV/MD 解析
    ├── lib/zip.js          安全解压
    ├── lib/persona.js      风格统计 / 分析提示词 / 系统提示词
    ├── lib/memory.js       切块 / 中文分词 / 混合召回
    └── lib/backup.js       VACUUM INTO 备份 / 恢复
    │
    ▼
data/  echopersona.db (WAL) │ uploads │ audio │ avatars │ backups │ logs
```

### 请求路径要点

- **会话解析**：`onRequest` 钩子在根实例注册（`lib/session.js` 用 `fastify-plugin` 跳出封装），否则只有 auth 插件内的路由能拿到 `req.user`。这是一个容易踩的 Fastify 封装坑。
- **SSE**：聊天接口先持久化用户消息，再流式产出 delta，最后落库 assistant 消息。客户端断开时通过 `AbortController` 中止上游请求，已生成内容照样入库。
- **异步任务**：分析接口返回 202 + `jobId`，后台 runner 更新 `jobs.progress/stage`，前端轮询。避免长请求占住连接。

### 前端渲染的两个隐性陷阱

这两个都真实翻过车，而且都能通过「接口全 200」的测试，因为问题只发生在 DOM 层。

**1. 原生 `append()` / `replaceChildren()` 会把 `null` 变成字面量 `"null"`。**

`Node.append()` 按规范会把任何非 Node 参数 `String()` 之后当文本节点插进去，
`null` 就渲染成页面上孤零零的 "null"。项目里的 `h()` 会跳过假值，但
`el.append(a, maybeNull, b)`、`el.replaceChildren(x, maybeNull)` 这类原生调用不会。
用户看到的「导入后只显示 NULL」就属于这一类：数据其实全都正常入库了，
只是展示层把 null 印了出来。

规则：**可能为 null 的子节点一律走 `h(...)`，或者先 `.filter(Boolean)`**。

**2. 用三元表达式做条件渲染，只在构建那一刻求值一次。**

```js
// 错：选文件后按钮永远不出现
card.append(pending.length ? h('div', 按钮组) : null);

// 对：让动作区随状态重绘
const bar = h('div');
const sync = () => bar.replaceChildren(...(pending.length ? [按钮组] : []));
```

用户报的「导入聊天记录后没有反应」，根因就是这个：`pending.length` 在页面
构建时是 0，分支产出的 `null` 被原样塞进 DOM，之后无论怎么选文件，
那块按钮区块根本不在 DOM 里，点无可点。

测试替身（`tests/frontend.test.js` 里的 `makeEl`）必须严格实现 DOM 规范 ——
早期那里写成 `else if (n)` 悄悄丢掉假值，比浏览器宽容，等于替被测代码兜了底，
于是这条 bug 躲过了当时全部用例。

---

## 3. 数据模型

17 张业务表，核心关系：

```
users ─┬─ sessions
       ├─ auth_tokens
       ├─ llm_configs ──────┐
       ├─ tts_configs ──┬───┤
       ├─ voice_refs    │   │
       ├─ personas ─────┴───┴─── (llm_config_id, tts_config_id, voice_ref_id)
       │    ├─ import_files
       │    ├─ messages (persona/user, seq, ts, is_imported)
       │    ├─ chats ── messages
       │    ├─ profiles (versioned, is_active)
       │    └─ memories ── memory_chunks (embedding BLOB)
       ├─ tts_audio (cache by sha256)
       ├─ jobs
       └─ audit_logs
```

### 关键设计

**去重用部分唯一索引**，而不是应用层查重（并发下更可靠）：

```sql
CREATE UNIQUE INDEX idx_msg_dedupe ON messages(persona_id, content_hash);
CREATE UNIQUE INDEX idx_mem_dedupe ON memories(persona_id, content_hash);
CREATE UNIQUE INDEX idx_tts_cache ON tts_audio(user_id, cache_key);
```

**画像版本化**：`profiles` 每次分析插入新行并 `version+1`，旧的 `is_active=0`。这样增量分析不丢历史，也便于对比。

**全文索引**：FTS5 默认分词器对中文无效（整段当一个词）。所以应用层 `tokenizeForIndex()` 先把中文切成单字 + 相邻双字，写进 `content_tok` 字段，检索时同样处理查询串。这是让中文检索真正可用的必要手段。

**向量**：`float32` BLOB + 内存余弦。`l2normalize()` 后存入，查询时同样归一化，点积即余弦。

---

## 4. 人格分析与记忆

### 分析流程

1. **统计层**（确定性，不花 token）：平均/中位句长、短句比、表情率、问号/叹号/省略号/波浪号占比、每句逗号数、口头禅频次、2–4 字重复短语、多行消息比例
2. **样本层**：从聊天里按长度分桶抽代表性发言 + 用户→人格的对话对
3. **LLM 层**：把统计结果和样本一起给模型，要求输出严格 JSON 的画像结构
4. **归一化**：`normalizeProfile()` 把置信度夹到 0–1、重要度夹到 1–5、类型白名单过滤，防止模型输出越界值污染数据库
5. **落库 + 索引**：写入 `profiles`（版本+1），把 `memories` 逐条写入并建索引

### 为什么不让模型自由生成画像

自由生成会导致：字段缺失、置信度写「高」「中」、类型名每次都不一样。用严格 schema + 归一化后，前端可以稳定渲染，也能做「置信度低于 0.5 的灰色显示」这种处理。

### 记忆召回（双路融合）

```
查询文本
  ├─ 关键词路：中文分词 → FTS5 → 候选 chunk
  └─ 向量路：embedding → 余弦 top-K（可选，无 embedding 模型时跳过）
        ↓
   RRF 融合（Reciprocal Rank Fusion）
        ↓
   按 salience × 时间衰减 × confidence 重排
        ↓
   取前 N 条 → formatRecallForPrompt（有字符上限）
```

RRF 的好处是不用调两个路的分数量纲，只靠排名融合，稳健。

**为什么不把全部历史塞进 prompt**：几千条消息塞不进上下文，且会严重稀释当前话题。切块 + 检索 + 上限截断是必须的。

**为什么消息要按时间间隔切块**：同一天的连续对话是连贯的，跨天的对话通常换了话题。`chunkMessages` 同时受字符预算和时间间隔约束，超预算或超间隔就切。

---

## 5. 安全设计

### 5.1 认证与会话

- 口令：**scrypt**（N=16384, r=8, p=1, keylen=64），存 `scrypt$N$r$p$salt$hash`
- 校验用 `timingSafeEqual`；用户不存在时也跑一次假校验，抵抗用户枚举的时间侧信道
- 会话：随机 token，**SHA-256 后**作为 `sessions.id` 存储。数据库泄露也拿不到可用 token
- Cookie：`HttpOnly` + `SameSite=Lax` + 生产环境 `Secure`
- 滑动续期：每小时最多刷新一次，避免每个请求都写库

### 5.2 API Key 加密

```
MASTER_KEY --SHA-256--> 32 字节密钥
明文 Key --AES-256-GCM(AAD="echopersona:v1")--> iv.tag.ciphertext (base64)
```

- AAD 绑定用途，防止密文被挪用到别处解密
- 每次加密生成新 IV，同一明文两次加密结果不同（有测试覆盖）
- 生产环境缺 `MASTER_KEY` 直接拒绝启动，不允许静默降级
- 接口只返回 `前3位****后4位`，完整 Key 永不出后端

### 5.3 SSRF 防护

这是「用户可自定义上游 URL」这类功能最容易出事的地方。

```
validateUpstreamUrl(url)
  ├─ 协议必须 http/https
  ├─ 禁止 URL 内嵌账号密码
  ├─ 禁止 localhost / .local / .internal
  ├─ DNS 解析全部 A/AAAA 记录
  └─ 任一记录落在私有/保留段 → 拒绝
```

仅做字符串校验是不够的 —— 攻击者可以用一个「先解析到公网、再解析到内网」的域名（DNS rebinding）。所以：

```js
pinnedAgent(pinned)  // undici Agent，自定义 lookup 只返回已核验的那个 IP
```

连接阶段强制使用核验过的 IP，DNS 之后再变也没用。

重定向逐跳重新校验（每跳都调一次 `validateUpstreamUrl`），响应体有字节上限（`readBody` 带 `maxBytes`），防止大文件打爆内存。

私有网段覆盖：`10/8`、`127/8`、`0/8`、`169.254/16`、`172.16–31`、`192.168/16`、`100.64–127`（CGNAT）、`198.18/19`、`≥224`、`::1`、`fe80::/10`、`fc00::/7`、v4-mapped、组播。

自建 TTS 在 127.0.0.1 时用 `SSRF_ALLOW_PRIVATE=1` 显式放行，默认关闭。

### 5.4 上传安全

- 大小限制：单文件 50 MB，ZIP 解压后总计 200 MB，条目数 200（防解压炸弹）
- ZIP：解析中央目录，拒绝加密条目、符号链接、绝对路径、`../` 穿越；用 `inflateRawSync` 时带 `maxOutputLength`
- 扩展名 + MIME 双重白名单
- 文件名不落盘（用生成的 ID），避免路径注入
- 参考音频必须勾选授权确认才能上传

### 5.5 注入防护

- **SQL**：全部查询用参数绑定，无字符串拼接
- **XSS**：前端 `md()` 渲染 Markdown 时先整体 `esc()` 转义，再替换标记；不使用 `innerHTML` 注入原始用户内容
- **CSP**：`default-src 'self'`，禁内联脚本（前端是外部模块文件，正好符合）。这条规则同样会拦掉内联的启动看门狗，所以看门狗放在 `public/js/boot-watchdog.js`，用 `<script src>` 引入

### 5.6 限流

| 端点 | 限制 |
|---|---|
| 注册 | 8 次 / 15 分钟 |
| 登录 | 12 次 / 15 分钟 |
| 忘记密码 | 5 次 / 30 分钟 |
| 发消息 | 40 次 / 分钟 |
| TTS | 20 次 / 分钟 |
| 导出数据 | 2 次 / 小时 |

`errorResponseBuilder` **必须返回 Error 实例**，返回普通对象会被 Fastify 当作未知错误处理成 500（这是个真实踩过的坑）。

### 5.7 反向代理信任

`TRUST_PROXY` 默认 `false`。设成 `true` 而实际没有反代时，任何客户端都能伪造 `X-Forwarded-For` 绕过所有限流。
所以只有当确实部署在 Nginx 后面时才开启。

### 5.8 管理员权限边界

管理后台的 SQL 里**根本不 select** `messages.content`，也不解密任何 Key。
这不是靠「界面上不显示」，而是接口层面拿不到。已有测试断言：

```
admin can see counts but not chat content  ✓
```

### 5.9 审计

`audit_logs` 记录登录、改密、改邮箱、导入、分析、发消息、TTS、管理操作，含 IP 与 UA。
日志写入前 `sanitizeLog()` 递归脱敏敏感字段名（key/token/secret/password 等）。

---

## 6. 性能数据（1 核 2 GB VPS 实测）

| 项目 | 数值 |
|---|---|
| 常驻内存 | 约 120–180 MB |
| 冷启动到可用 | < 1 秒 |
| 数据库文件（空库） | 约 276 KB |
| 单条记忆检索（关键词） | < 2 ms |
| 记忆召回（双路 + RRF，3000 chunk） | < 15 ms |
| 冒烟检查 8 项 | < 1 秒 |

---

## 7. 已知限制

诚实列出来，避免误判：

1. **单实例**：SQLite 不支持多进程写同一文件。扩容需先迁 PostgreSQL（见 DEPLOY.md）
2. **Docker 构建未实测**：开发机无 Docker 环境，配置按实际依赖编写但未跑过 `docker build`
3. **中文分词是二元切分**：不是真正的中文分词（没接 jieba），召回率尚可但精确度不如专业分词器。好处是零依赖、无词典维护
4. **向量检索是暴力扫描**：适合万级以内 chunk，再往上要换专用索引
5. **不支持微信加密数据库**：`.db`/`.dat` 需要用户先在客户端内导出为文本
6. **分析质量取决于样本量**：几十条能跑但结论粗糙，几百条以上才有意义
7. **语音流式播放是分句请求**：长文本会拆成多段依次合成，不是真正的单流长连接合成（受上游能力限制）
8. **FTS5 可能不可用**：取决于部署所用的 Node 构建。已实现自动降级为 LIKE 检索（见 §2.1），功能可用但排序质量与速度有折损
