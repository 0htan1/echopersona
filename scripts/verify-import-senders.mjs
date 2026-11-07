#!/usr/bin/env node
/**
 * 「导入后凭空多出很多人物」的真实验证。
 *
 * 用户报的现象：导入一份聊天记录，发送者列表里出现一堆不是人的东西
 * （「注意」「时间」「问题」……），自动判定的复刻对象也判到错的人头上。
 *
 * 根因在 TXT 解析器的 PLAIN 正则：任何「词：内容」的行都会开一条新消息，
 * 于是正文里带冒号的行全变成了"人物"。
 *
 * 这个脚本走完整 HTTP 链路（上传 → 解析 → 落库 → 统计发送者），
 * 断言发送者数量与真人对得上，而不是只测正则本身。
 *
 * 用法： node scripts/verify-import-senders.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-snd-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.MASTER_KEY = 'verify-senders-key-0123456789abcd';
process.env.BACKUP_INTERVAL_HOURS = '0';

const checks = [];
const ok = (n, d = '') => { checks.push({ ok: true, n }); console.log(`  PASS ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { checks.push({ ok: false, n }); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); };

const { buildServer } = await import('../src/server.js');

let cookie = '';
let app;

async function req(method, url, body) {
  const res = await app.inject({
    method, url,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers['set-cookie'];
  if (sc) {
    const c = Array.isArray(sc) ? sc[0] : sc;
    const v = c.split(';')[0];
    if (v.startsWith('ep_session=')) cookie = v;
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
  return { status: res.statusCode, body: json, raw: res.body };
}

async function upload(personaId, filename, text, extra = {}) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await app.inject({
    method: 'POST', url: `/api/personas/${personaId}/imports`,
    headers: { cookie }, payload: form,
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { status: res.statusCode, body: json, raw: res.body };
}

/* 真实场景一：微信 PC 导出的 TXT。
 * 正文里带冒号的句子（"注意：""怎么说呢：""其实："）是最容易被误判成人的地方。 */
const WECHAT_TXT = `2024-03-12 21:04:33 林小满
今天下班又是十点半，地铁上人还是好多。
注意：明天要带伞

2024-03-12 21:05:02 我
又加班？你们组是不要人活了吧
怎么说呢：其实也还好

2024-03-12 21:05:41 林小满
害，习惯了，反正回去也是一个人待着。
你呢，今天吃得还行吗

2024-03-12 21:06:15 我
凑合吧 楼下那家面馆
顺便说一句：那家汤太咸了

2024-03-12 21:06:44 林小满
那家我记得，汤太咸了哈哈哈`;

/* 真实场景二：从微信里手动复制出来的纯「昵称：内容」。
 * 这里夹着「说明：」这种一眼是正文的行，也夹着只说过一句的第三人。 */
const PLAIN_TXT = `林小满：你在干嘛呀
我：在加班
林小满：害 那你早点回来 给你留了饭
说明：以下为系统提示
我：好
阿杰：我也在加班啊
林小满：每次都这样`;

async function main() {
  app = await buildServer({ logger: false });
  await app.ready();
  console.log('\n[verify-import-senders] 开始\n');

  let r = await req('POST', '/api/auth/register', {
    email: `snd${Date.now()}@example.com`, password: 'Passw0rd123', displayName: '验证', consent: true,
  });
  if (r.status >= 400) { bad('注册账号', `HTTP ${r.status} ${r.raw.slice(0, 160)}`); return finish(); }
  ok('注册账号');

  /* ---------------------------------------- 场景一：微信 PC TXT */
  r = await req('POST', '/api/personas', { name: '林小满', relationship: '女朋友' });
  const pid1 = r.body?.persona?.id;
  if (!pid1) { bad('创建人格', r.raw.slice(0, 160)); return finish(); }
  ok('创建人格');

  let up = await upload(pid1, 'wechat.txt', WECHAT_TXT);
  if (up.status !== 200) { bad('导入微信 TXT', `HTTP ${up.status} ${up.raw.slice(0, 200)}`); return finish(); }
  ok('导入微信 TXT', `${up.body.added} 条`);

  let s = await req('GET', `/api/personas/${pid1}/senders`);
  const names1 = (s.body?.senders || []).map((x) => x.name);
  if (names1.length === 2 && names1.includes('林小满') && names1.includes('我')) {
    ok('发送者只有两个真人', names1.join(' / '));
  } else {
    bad('发送者只有两个真人', JSON.stringify(names1));
  }
  /* 这几个是最常被误判成人的正文词，必须一个都不在名单里 */
  const noise = ['注意', '怎么说呢', '顺便说一句', '其实'];
  const leaked = names1.filter((n) => noise.includes(n));
  if (!leaked.length) ok('正文里带冒号的句子没变成人物');
  else bad('正文里带冒号的句子没变成人物', leaked.join(' / '));

  /* 正文没有被吞掉：那几句带冒号的话仍要留在消息里（作为上一条的续行） */
  const msgs = await req('GET', `/api/personas/${pid1}/imported-messages?limit=50`);
  const all1 = (msgs.body?.messages || []).map((m) => m.content).join('\n');
  if (all1.includes('注意：明天要带伞') && all1.includes('怎么说呢：其实也还好')) {
    ok('带冒号的正文仍在消息里，没被丢弃');
  } else {
    bad('带冒号的正文仍在消息里，没被丢弃', all1.slice(0, 160));
  }
  // 也不能被记到错误的人头上 —— 它属于说出来的人
  const note = (msgs.body?.messages || []).find((m) => String(m.content).includes('注意：明天要带伞'));
  if (note && note.sender_raw === '林小满') ok('带冒号的正文归属于说出它的人', note.sender_raw);
  else bad('带冒号的正文归属于说出它的人', JSON.stringify(note && { s: note.sender_raw, c: String(note.content).slice(0, 40) }));

  /* 自动判定复刻对象：发言最多的一方 */
  const p1 = await req('GET', `/api/personas/${pid1}`);
  const personaCount = (s.body?.senders || []).find((x) => x.role === 'persona');
  if (personaCount && personaCount.name === '林小满') {
    ok('自动判定的复刻对象是发言最多的人', `${personaCount.name} ${personaCount.count} 条`);
  } else {
    bad('自动判定的复刻对象是发言最多的人', JSON.stringify((s.body?.senders || []).map((x) => `${x.name}:${x.role}`)));
  }

  /* --------------------------------- 场景二：纯「昵称：内容」 */
  r = await req('POST', '/api/personas', { name: '小满', relationship: '朋友' });
  const pid2 = r.body?.persona?.id;
  ok('创建第二个人格', pid2 || '');

  up = await upload(pid2, 'copy.txt', PLAIN_TXT);
  if (up.status !== 200) { bad('导入纯冒号 TXT', `HTTP ${up.status} ${up.raw.slice(0, 200)}`); return finish(); }
  ok('导入纯冒号 TXT', `${up.body.added} 条`);

  s = await req('GET', `/api/personas/${pid2}/senders`);
  const names2 = (s.body?.senders || []).map((x) => x.name);
  /* 真人是 林小满 / 我 / 阿杰 三个；「说明」不能算人 */
  if (names2.length === 3) ok('发送者是三个真人', names2.join(' / '));
  else bad('发送者是三个真人', JSON.stringify(names2));
  if (!names2.includes('说明')) ok('「说明：」没被当成人物');
  else bad('「说明：」没被当成人物', JSON.stringify(names2));

  /* 只说过一句的第三人也必须留下 —— 不能为了去噪把真人一起干掉 */
  if (names2.includes('阿杰')) ok('只说过一句的真人被保留', '阿杰');
  else bad('只说过一句的真人被保留', JSON.stringify(names2));

  finish();
}

async function finish() {
  const fail = checks.filter((c) => !c.ok);
  console.log(`\n[verify-import-senders] ${checks.length - fail.length}/${checks.length} 通过\n`);
  for (const f of fail) console.log(' - ' + f.n);
  await app?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
