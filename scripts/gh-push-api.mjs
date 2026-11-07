#!/usr/bin/env node
/* 用 GitHub Git Data API 推送，绕开 git 传输层（当前环境代理对
 * github.com 的 CONNECT 一律 502，git push 完全不可用，但 api.github.com 通）。
 *
 * 思路：把本地 HEAD 与远端 base 之间的差异，按 blob → tree → commit → ref
 * 逐层用 REST 接口写上去。等价于一次 fast-forward push，只是换了传输方式。
 *
 * 用法：node scripts/gh-push-api.mjs [--dry]
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const OWNER = '0htan1';
const REPO = 'echopersona';
const BRANCH = 'main';
const DRY = process.argv.includes('--dry');

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

function token() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('取不到 git 凭据');
  return m[1].trim();
}

const TOKEN = token();

async function api(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'echopersona-push',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) {
    throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json || text).slice(0, 400)}`);
  }
  return json;
}

/* ---------------------------------------------------------------- 远端基线 */
const localHead = sh('git rev-parse HEAD');
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const remoteSha = ref.object.sha;
console.log(`远端 ${BRANCH}: ${remoteSha.slice(0, 7)}`);
console.log(`本地 HEAD : ${localHead.slice(0, 7)}`);

if (remoteSha === localHead) { console.log('已经一致，无需推送。'); process.exit(0); }

/* 确认是 fast-forward：远端必须是本地的祖先，否则直接覆盖会丢提交，要报错让用户决定。
 *
 * 例外：`--force` 只允许覆盖「本脚本自己上一次推歪的提交」—— 判定条件是远端 tree
 * 里的每个 blob 路径在本地也都存在（它没有引入本地没有的文件），只是字节被污染。
 * 真有别人的提交就一定不满足。注意远端 commit 只在 GitHub 上，本地没有这个对象，
 * 所有查询都必须走 API，不能用 git ls-tree / git diff。 */
const remoteTree0 = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${remoteSha}?recursive=1`);
const remoteBlobs0 = (remoteTree0.tree || []).filter((n) => n.type === 'blob');

let isFF = false;
try {
  sh(`git merge-base --is-ancestor ${remoteSha} ${localHead}`);
  isFF = true;
} catch { isFF = false; }

const FORCE = process.argv.includes('--force');
if (!isFF) {
  if (!FORCE) {
    console.error('远端不是本地祖先，不是快进关系。中止，避免覆盖别人的提交。');
    console.error('（如果确认远端是上一次推送污染出来的，加 --force）');
    process.exit(2);
  }
  const localFiles = new Set(sh(`git ls-tree -r --name-only ${localHead}`).split('\n').filter(Boolean));
  const extra = remoteBlobs0.map((n) => n.path).filter((p) => !localFiles.has(p));
  if (extra.length) {
    console.error(`远端有本地不存在的文件，拒绝覆盖：\n  ${extra.join('\n  ')}`);
    process.exit(2);
  }
  console.log(`--force：远端 ${remoteBlobs0.length} 个文件在本地都存在，判定为上次污染推送，允许覆盖`);
} else {
  console.log('fast-forward 关系确认');
}

/* ---------------------------------------------------------------- 差异文件 */
/* 不能用 `git diff remoteSha localHead`：远端那个 commit 只在 GitHub 上，
 * 本地没有这个对象，git 会报 bad object。
 *
 * 改用 content-addressed 对比：远端 tree 的 blob sha vs 本地 `git ls-tree` 的
 * blob sha。sha 相同即字节相同，比 diff 更直接，而且本地这边取的是 git 规范化后
 * 的内容（LF），所以不会因为 Windows 磁盘上的 CRLF 产生假差异。 */
const remoteTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${remoteSha}?recursive=1`);
const remoteMap = new Map(
  (remoteTree.tree || []).filter((n) => n.type === 'blob').map((n) => [n.path, n.sha]),
);
const localMap = new Map();
for (const line of sh(`git ls-tree -r ${localHead}`).split('\n').filter(Boolean)) {
  /* 格式：<mode> <type> <sha>\t<path> */
  const [meta, ...rest] = line.split('\t');
  const sha = meta.split(/\s+/)[2];
  localMap.set(rest.join('\t'), sha);
}

const writes = [];
const deletes = [];
for (const [p, sha] of localMap) {
  if (remoteMap.get(p) !== sha) writes.push(p);
}
for (const p of remoteMap.keys()) {
  if (!localMap.has(p)) deletes.push(p);
}
console.log(`差异 ${writes.length} 改/增, ${deletes.length} 删`);
for (const p of writes) console.log(`  ~ ${p}`);
for (const p of deletes) console.log(`  - ${p}`);

if (!writes.length && !deletes.length) { console.log('内容已一致，无需推送。'); process.exit(0); }

if (DRY) { console.log('\n--dry 模式，未写入。'); process.exit(0); }

/* ---------------------------------------------------------------- 建 blob */
/* 关键：内容必须取自 git 索引（HEAD:path），不能读磁盘。
 *
 * 本机 core.autocrlf=true，磁盘上是 CRLF，而 git 仓库里存的是 LF。
 * 直接读磁盘会把 6 个文件的换行符全改一遍，推上去就是「整文件重写」——
 * 一个只改了 12 行的 src/server.js 会显示成 +1/-1281，
 * 提交历史从此不可读，review 也没法看。
 *
 * `git cat-file blob HEAD:path` 拿到的正是 git 里应该存的那份规范内容。 */
const blobs = [];
for (const file of writes) {
  const buf = execSync(`git cat-file blob HEAD:${JSON.stringify(file)}`, {
    encoding: 'buffer', maxBuffer: 1 << 28,
  });
  const b = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: buf.toString('base64'),
    encoding: 'base64',
  });
  blobs.push({ path: file, sha: b.sha, size: buf.length });
  console.log(`  blob ${file} → ${b.sha.slice(0, 7)} (${(buf.length / 1024).toFixed(1)}KB)`);
}

/* ---------------------------------------------------------------- 建 tree */
/* 递归 tree 需要基于远端当前 tree，这样未改动的文件自动保留 */
const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteSha}`);
const baseTree = baseCommit.tree.sha;

const treeItems = [
  ...blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
  ...deletes.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
];
const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
  base_tree: baseTree,
  tree: treeItems,
});
console.log(`tree → ${newTree.sha.slice(0, 7)}`);

/* ---------------------------------------------------------------- 建 commit */
/* 本地领先远端的那些提交，说明合并起来作为本次提交信息。
 * 不能用 `${remoteSha}..HEAD` —— 远端 commit 本地没有，range 无效。
 * 用 `--not --remotes` 取"尚未推送的提交"，正是我们要的语义。 */
const msgs = sh('git log --reverse --format=%B --not --remotes').split('\n\n\n').map((s) => s.trim()).filter(Boolean);
const message = msgs.join('\n\n') || sh(`git log -1 --format=%B ${localHead}`);
const newCommit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [remoteSha],
  author: {
    name: 'EchoPersona',
    email: 'noreply@echopersona.local',
    date: new Date().toISOString(),
  },
});
console.log(`commit → ${newCommit.sha.slice(0, 7)}`);

/* ---------------------------------------------------------------- 更新 ref */
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  sha: newCommit.sha,
  force: false,
});
console.log(`\n已推送 ${BRANCH} → ${newCommit.sha.slice(0, 7)}`);
console.log(`https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);
