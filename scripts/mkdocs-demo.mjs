#!/usr/bin/env node
/**
 * 为 README 截图准备演示数据：一个已分析的人格 + 导入记录 + 一段像样的对话。
 *
 * 只服务于文档（配合 scripts/shots-for-readme.mjs），不进验收链路。
 *
 * 为什么单独写这个：
 *   截图里的对话必须**读起来像真的**，否则读者一眼看出是占位符，反而减分。
 *   但也不能拿真实聊天记录 —— 那是别人的隐私。
 *   所以这里用一段自己写的、有明显性格特征的对话，走真实的表结构写入。
 *
 * 前置：
 *   node scripts/mk-test-user.mjs --session     # 拿到 e2e 账号的 token
 * 用法：
 *   DATA_DIR=../echopersona-data node scripts/mkdocs-demo.mjs <token>
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './lib/browser.mjs';

const token = process.argv[2] || process.env.EP_TEST_TOKEN;
if (!token) {
  console.error('需要一个 session token：先跑 node scripts/mk-test-user.mjs --session');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || path.join(ROOT, '..', 'storage');
const db = new DatabaseSync(path.join(dataDir, 'echopersona.db'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const sess = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sha256(token));
if (!sess) {
  console.error('token 无效：sessions 表里找不到（id 存的是 token 的 sha256）。');
  process.exit(1);
}
const userId = sess.user_id;
const now = Date.now();

/* 截图里会露出账号名（左下角、问候语）。测试账号默认叫「E2E 用户」，
 * 摆在 README 里像是没做完的测试环境。这里改成一个普通的名字，
 * 只影响这个本地演示账号，不碰别人的数据。 */
try {
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('阿岸', userId);
} catch { /* users 表结构不同就跳过 */ }

/* --------------- 幂等：先清掉这个账号的旧数据 --------------- */
for (const t of ['memory_chunks', 'memories', 'messages', 'chats', 'import_files',
  'profiles', 'personas', 'llm_configs', 'tts_configs', 'voice_refs']) {
  try { db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId); } catch { /* 表结构可能不同 */ }
}

/* --------------- 1. 可用的模型配置（指向模拟上游） --------------- */
db.prepare(`INSERT INTO llm_configs
  (id,user_id,label,provider,base_url,api_key_enc,model,params_json,is_default,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
  'llm_demo', userId, '我的模型', 'openai', 'http://127.0.0.1:8790/v1',
  'demo-not-a-real-key', 'mock-chat', '{}', 1, now, now,
);

/* --------------- 2. 人格 --------------- */
const personaId = 'per_demo_readme';
/* analysis_status 用 'ready' —— 前端 analysisBadge() 只认
 * ready / running / queued / failed / none 这五个值。
 * 写成 'done' 会让界面显示「尚未分析」，而档案其实是有的，
 * 截图里就会出现「有分析结果却标着未分析」的自相矛盾。 */
db.prepare(`INSERT INTO personas
  (id,user_id,name,relationship,bio,description,language,similarity_mode,voice_mode,
   status,analysis_status,analyzed_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  personaId, userId, '林小满', '认识八年的朋友', '总在加班，说话很轻',
  '话不多，习惯自嘲，回消息常常隔一会儿。语气里有疲惫，但很在意对方有没有吃饭。',
  'zh', 'natural', 'text', 'ready', 'ready', now, now - 86400_000, now,
);

/* --------------- 3. 人格档案（分析结果） ---------------
 *
 * 字段名必须和 src/lib/persona.js 里 NORMALIZE 的 schema 完全一致，
 * 否则页面上的「语言风格」「性格与交流」会渲染成空卡片 ——
 * 而「人物画像」用 summary 就出来了，看起来像半个 bug。
 * 这里照抄真实 schema，不做自己的命名。 */
db.prepare(`INSERT INTO profiles
  (id,user_id,persona_id,version,data_json,model,sample_count,message_count,is_active,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
  'prof_demo', userId, personaId, 1,
  JSON.stringify({
    summary: '话少，句子短，习惯先应一声再往下说。情绪不外露，用「害」「还行吧」把难受轻轻带过。',
    language_style: {
      tone: '温和、克制，带一点疲惫',
      sentence_pattern: '一句一个意思，很少用长句和从句',
      punctuation_habit: '几乎不用句末标点，爱用空格断句，表情符号极少',
      catchphrases: ['害', '还行吧', '我跟你说过好多次了', '感觉自己像个人了'],
      favorite_words: ['凑合', '难得', '知道啦', '反正'],
      reply_rhythm: '回得快，但一条只说一句，想到什么再补一条',
      initiative: '中低，更常回应而不是发起，很少主动追问',
    },
    personality: {
      traits: [
        { trait: '克制', evidence: '「害 还行吧 就是有点累」——不直接说难受', confidence: 0.82 },
        { trait: '自我消解', evidence: '「等这个项目结束就好了」这类说法反复出现，用将来安慰现在', confidence: 0.78 },
        { trait: '体贴', evidence: '自己刚说完累，下一句先问「你呢 今天吃饭了没」', confidence: 0.86 },
      ],
      humor: '自嘲式，「感觉自己像个人了」这类把处境说得轻描淡写',
      emotion_expression: '不直接说不开心，用「害」「也不是总这样」把情绪压下去',
      communication_style: '偏迂回，先说「还行」，被追问才说实话',
      topic_reactions: [
        { topic: '加班', reaction: '承认，但马上说「习惯了」，不愿多谈' },
        { topic: '吃饭', reaction: '答得很具体（哪家店、吃什么），也借此把话题转回对方' },
        { topic: '承诺', reaction: '答应得很快（「不会不会」），会主动加一句加强' },
      ],
      with_familiar: '话仍不多，但会主动分享琐事，也会开玩笑',
      with_stranger: '无证据',
    },
    relationship_memory: {
      shared_experiences: [
        { content: '一起去过巷子里的面馆', when: '2024 年春', confidence: 0.7 },
        { content: '答应带对方去吃那家面馆，还没去成', when: '最近', confidence: 0.75 },
      ],
      important_events: [],
      common_topics: ['加班', '吃饭', '那家面馆', '睡眠'],
      interests: [],
      preferences: [
        { content: '不喜欢别人说「随便」', confidence: 0.55 },
        { content: '觉得楼下那家面馆汤有点咸，但还是常去', confidence: 0.6 },
      ],
      agreements: [{ content: '答应带对方去吃那家面馆', confidence: 0.75 }],
      nicknames: [],
      key_quotes: ['害 还行吧 就是有点累', '等这个项目结束就好了 我跟你说过好多次了哈哈', '感觉自己像个人了'],
    },
    memories: [],
    speaking_style: {
      has_voice_evidence: false,
      voice_tone: '无语音样本',
      sentence_length: '无语音样本',
      fillers: [],
      opening: [],
      ending: [],
      pronunciation_notes: '无证据',
      difference_from_text: '无语音样本',
    },
    caution_notes: '仅 13 条文本、单方面记录，未包含语音；结论为文本推断，非心理诊断。',
  }),
  'mock-chat', 13, 13, 1, now,
);

const insMsg = db.prepare(`INSERT INTO messages
  (id,user_id,persona_id,chat_id,import_id,role,sender_raw,content,msg_type,ts,seq,
   is_imported,is_persona_voice,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

/* --------------- 4. 导入记录 --------------- */
const importId = 'impf_demo';
db.prepare(`INSERT INTO import_files
  (id,user_id,persona_id,original_name,stored_path,bytes,mime,status,parser,
   message_total,message_new,message_dup,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  importId, userId, personaId, 'chat.txt', 'demo/chat.txt', 1024, 'text/plain',
  'done', 'txt', 13, 13, 0, now - 7200_000,
);

const chatImport = 'cht_imported_demo';
db.prepare(`INSERT INTO chats (id,user_id,persona_id,title,created_at,updated_at,archived)
  VALUES (?,?,?,?,?,?,0)`).run(chatImport, userId, personaId, '导入的聊天记录', now - 7200_000, now - 7200_000);

const imported = [
  ['林小满', '今天下班又是十点半，地铁上人还是好多。'],
  ['我', '又加班？你们组是不要人活了吧'],
  ['林小满', '害，习惯了，反正回去也是一个人待着。'],
  ['我', '吃饭了吗'],
  ['林小满', '楼下那家面馆 凑合吃一口'],
  ['我', '你总这样不行啊'],
  ['林小满', '我知道 但也没别的办法'],
  ['林小满', '等这个项目结束就好了 我跟你说过好多次了哈哈'],
  ['我', '你每次都说这句话'],
  ['林小满', '因为每次都是真的嘛'],
  ['林小满', '早 今天没那么困'],
  ['我', '难得'],
  ['林小满', '昨晚十一点就睡了 感觉自己像个人了'],
];
let s1 = 0;
for (const [who, text] of imported) {
  const isP = who === '林小满';
  insMsg.run(`msg_imp_${s1}`, userId, personaId, chatImport, importId,
    isP ? 'assistant' : 'user', who, text, 'text',
    now - 7200_000 + s1 * 60000, s1, 1, 0, now - 7200_000 + s1 * 60000);
  s1 += 1;
}

/* --------------- 5. 一段像样的对话（截图主角） --------------- */
const chatId = 'cht_demo_readme';
db.prepare(`INSERT INTO chats (id,user_id,persona_id,title,created_at,updated_at,archived)
  VALUES (?,?,?,?,?,?,0)`).run(chatId, userId, personaId, '周末去吃那家面馆', now - 3600_000, now);

const convo = [
  ['user', '今天又加班到现在？'],
  ['assistant', '害 还行吧 就是有点累'],
  ['assistant', '你呢 今天吃饭了没'],
  ['user', '吃了，楼下那家面馆。你最近还总这样熬着？'],
  ['assistant', '也不是总这样'],
  ['assistant', '等这个项目结束就好了 我跟你说过好多次了哈哈'],
  ['user', '你每次都这么说'],
  ['assistant', '因为每次都是真的嘛'],
  ['user', '行吧。那你自己注意点，别又两三点才睡'],
  ['assistant', '知道啦'],
  ['assistant', '今天应该能早点 昨晚十一点就睡了 感觉自己像个人了'],
  ['user', '那挺好，难得听你这么说'],
  ['assistant', '嗯 主要是今天没那么困'],
  ['user', '周末有空吗，去吃那家面馆'],
  ['assistant', '你说的那家？'],
  ['assistant', '行啊 我请你 上次就说要带你去的'],
  ['user', '你说的啊，别到周末又说要加班'],
  ['assistant', '不会不会'],
  ['assistant', '这次真的不会'],
];
let s2 = 0;
for (const [role, text] of convo) {
  insMsg.run(`msg_demo_${s2}`, userId, personaId, chatId, null, role,
    role === 'user' ? '我' : '林小满', text, 'text',
    now - 3600_000 + s2 * 45000, s2, 0, 0, now - 3600_000 + s2 * 45000);
  s2 += 1;
}

/* --------------- 6. 长期记忆 --------------- */
const mem = [
  ['fact', '经常加班到十点半，在互联网公司做项目', 3],
  ['event', '答应带对方去巷子里那家面馆，还没去成', 4],
  ['preference', '觉得楼下那家面馆汤有点咸，但还是常去', 2],
  ['fact', '习惯先应一声（「害」「还行吧」）再往下说', 3],
  ['event', '2024 年春天一起吃过那家面馆', 3],
];
let mi = 0;
for (const [kind, content, salience] of mem) {
  db.prepare(`INSERT INTO memories
    (id,user_id,persona_id,kind,content,salience,confidence,source_type,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`mem_demo_${mi}`, userId, personaId,
    kind, content, salience, 0.8, 'analysis', now, now);
  mi += 1;
}

/* --------------- 7. 首屏引导状态：语音那一步留空 --------------- */
try {
  db.prepare(`INSERT INTO settings (id,user_id,value_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(`onboard:${userId}`, userId, JSON.stringify({ llm: 1, persona: 1, import: 1, analyze: 1 }), now);
} catch { /* settings 结构不同就跳过，不影响截图 */ }

db.close();
console.log(`\n演示数据就绪：\n  人格 ${personaId}`);
console.log(`  导入 ${imported.length} 条 / 对话 ${convo.length} 条 / 记忆 ${mem.length} 条\n`);
