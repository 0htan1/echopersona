# EchoPersona 部署文档

从一台全新 VPS 到 `https://your-domain.com` 可访问的完整步骤。全程约 30 分钟。

> 本文件里的所有命令都在 Ubuntu 22.04 / Debian 12 上验证过语法。
> **唯一未在本机实测的环节是 Docker 镜像构建**（开发机没装 Docker），
> 见文末「Docker 部署」一节的提示。

---

## ⚠ 发布前必读：别让本地数据跟着上传

**发布工具会把整个项目目录打包上传，`.gitignore` 不起作用。**

这不是理论风险 —— 曾经因此把本地测试库传到线上：19 个测试账号
（其中 `e2e@example.com` 的密码是公开的 `Passw0rd123`）当场可以在线上登录，
`data/.masterkey`（加密所有用户 API Key 的主密钥）也一起泄了出去。

规则：

1. **本地数据放在项目目录之外**：

   ```bash
   DATA_DIR=../echopersona-data npm start
   ```

   云端保持 `.env` 里的 `DATA_DIR=./storage`（默认），云端会自己建。

2. **发布前跑检查**：

   ```bash
   npm run preflight
   ```

   项目目录里存在 `*.db` / `.masterkey` / `audio/` / `avatars/` 等运行时数据时，
   它以退出码 1 拦下，不让你发布。`.tmp/` 也会被上传，发布前清空。

3. **知道沙箱会保留旧文件**：重新发布只覆盖上传的文件，不会清空云端旧目录。
   一旦某个数据目录被污染，换一个目录名（例如 `data/` → `storage/`）让旧目录
   成为无人引用的孤儿，比指望"重新发布能覆盖掉"可靠。

---

## 0. 你需要准备

| 项目 | 说明 |
|---|---|
| 一台 VPS | 最低 1 核 / 1 GB 内存 / 20 GB 磁盘。SQLite + Node 实测常驻约 120–180 MB |
| 一个域名 | 能改 DNS 解析（A 记录指向 VPS 公网 IP） |
| 自己的 LLM API Key | 任何 OpenAI 兼容服务（OpenAI、DeepSeek、通义、Moonshot、自建 vLLM 都行） |
| 自己的 BreezeTTS 服务 | 托管版 Breeze Blue 的 API Key，或自建的 `breeze-tts-2` 地址 |

**重要**：平台本身不带任何 API Key，也不代付模型费用。用户必须在自己的账号里配置自己的 Key，这是设计前提。

---

## 1. 服务器基础环境

```bash
# 以 root 登录后先建一个普通用户，后面都用它操作
adduser echopersona
usermod -aG sudo echopersona
su - echopersona

# 系统更新 + 基础工具
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw

# 时区（日志时间戳会用到）
sudo timedatectl set-timezone Asia/Shanghai
```

### 安装 Node.js 22

项目要求 Node >= 22.5（用到内置 `node:sqlite`）。

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应输出 v22.x
```

> 不用 nvm：systemd 服务以系统用户运行，nvm 的 shell 级环境会失效。

### 确认内置 SQLite 可用

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); console.log('SQLite + FTS5 OK')"
```

看到 `SQLite + FTS5 OK` 才能继续。若无输出或报错，说明 Node 版本不足。

### 防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

**不要**对外开放 8080，应用只监听 127.0.0.1。

---

## 2. 部署代码

```bash
sudo mkdir -p /opt/echopersona
sudo chown echopersona:echopersona /opt/echopersona

# 方式 A：从 git 拉取
git clone <你的仓库地址> /opt/echopersona

# 方式 B：本地上传
# rsync -avz --exclude node_modules --exclude data ./ user@your-vps:/opt/echopersona/

cd /opt/echopersona
npm ci --omit=dev
```

### 配置环境变量

```bash
cp .env.example .env
# 生成主密钥（务必保存好，丢失则已存 API Key 无法解密）
openssl rand -hex 32
```

编辑 `.env`：

```bash
nano .env
```

最少要改这三项：

```ini
NODE_ENV=production
PUBLIC_URL=https://your-domain.com
MASTER_KEY=<上面 openssl 生成的 64 位十六进制>
```

然后加锁：

```bash
chmod 600 .env
```

### （可选）开启 WorkBuddy 云模型

不配置这一节也完全能用——用户各自填自己的 API Key。配了之后，用户可以不填 Key
直接对话，额度由平台承担。

```ini
EP_CLOUD_ENDPOINT=https://你的应用域名
EP_CLOUD_PUBLISHABLE_KEY=wbpk_xxx
EP_CLOUD_OAUTH_RELAY_BASE_URL=https://www.workbuddy.cn/v2/as/genie-baas/oauth
```

这三个值来自 WorkBuddy 云服务的 `publicConfig`，**都不是密钥**——它们本来就要
下发到浏览器，安全性由服务端校验请求 Origin 保证。

三点必须注意：

1. **`EP_CLOUD_ENDPOINT` 必须等于用户实际访问的域名。** 云服务端按 Origin 精确
   匹配，域名不一致时模型调用会 401，而错误信息只说「授权校验失败」，很难归因。
   这也意味着本地 `localhost` 调试时云通道必然失败，属于预期行为。
2. **服务端不代理云模型调用。** 提示词由服务端组装（含用户隐私），模型调用由
   浏览器直连。这是安全要求：服务端中转会把免 Key 额度变成任何人都能用的开放
   代理。架构说明见 `src/lib/cloud.js` 顶部注释。
3. 云通道没有 embedding 能力，长期记忆会退回关键词检索。对聊天这类短文本依然
   可用，但准确度不如配了自己的模型。

### 初始化数据库并试跑

```bash
npm run migrate
npm start
```

另开一个终端：

```bash
curl -s http://127.0.0.1:8080/api/health
# {"ok":true,...}
npm run smoke http://127.0.0.1:8080
```

`smoke` 应该 8 项全过。按 `Ctrl+C` 停掉试跑。

---

## 3. 配置 systemd 开机自启

```bash
sudo cp deploy/echopersona.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now echopersona
sudo systemctl status echopersona --no-pager
```

看日志：

```bash
sudo journalctl -u echopersona -f
# 或只看最近的
sudo journalctl -u echopersona -n 100 --no-pager
```

**改了代码后重启**：

```bash
sudo systemctl restart echopersona
```

> 用 PM2 的话改用 `pm2 start ecosystem.config.cjs`，但**不要同时开 systemd 和 PM2**，会抢同一个端口。

---

## 4. 配置 Nginx 反向代理

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/echopersona
# 把域名换成你自己的（两处 server_name、以及证书路径）
sudo nano /etc/nginx/sites-available/echopersona

sudo ln -s /etc/nginx/sites-available/echopersona /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t          # 语法检查，必须 OK
sudo systemctl reload nginx
```

此时先用 HTTP 测试，**先不要**开 HTTPS（证书还没申请，nginx -t 会因找不到证书失败）。

如果 `nginx -t` 报证书文件不存在，先把 `listen 443` 那个 server 块整段注释掉，只保留 80 端口跳转块，等第 5 步拿到证书后再放开。

---

## 5. 申请 HTTPS 证书

```bash
sudo apt install -y certbot python3-certbot-nginx

# 自动改 Nginx 配置并申请证书
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

按提示输入邮箱、同意条款、选择 **Redirect**（把 HTTP 强制跳到 HTTPS）。

验证自动续期：

```bash
sudo certbot renew --dry-run
```

certbot 会装一个 systemd timer 自动续期，无需额外配置 cron。

把 `.env` 里的 `PUBLIC_URL` 确认为 `https://your-domain.com`，然后：

```bash
sudo systemctl restart echopersona
```

### 最终验收

```bash
npm run smoke https://your-domain.com
```

8 项全过（这次会真的检查 HSTS），并且：

```bash
curl -sI https://your-domain.com | grep -i strict-transport
# 应看到 strict-transport-security: max-age=31536000; includeSubDomains
```

浏览器打开域名，走一遍：注册 → 登录 → 建人格 → 上传聊天记录 → 分析 → 聊天 → 生成语音。

---

## 6. 备份与恢复

### 自动备份

应用内置定时备份（`BACKUP_INTERVAL_HOURS`，默认 24 小时），用 `VACUUM INTO` 生成一致快照后 gzip，存放在 `data/backups/`，默认保留 14 份。

也可以用系统 cron 双保险：

```bash
crontab -e
```

```cron
# 每天凌晨 3:20 备份
20 3 * * * cd /opt/echopersona && /usr/bin/node --no-warnings scripts/backup.js --keep=14 >> data/logs/backup.log 2>&1
```

### 手动备份 / 恢复

```bash
cd /opt/echopersona
npm run backup

# 查看有哪些备份
ls -lh data/backups/

# 恢复（必须先停服务）
sudo systemctl stop echopersona
node scripts/restore.js echopersona-2026-11-06T12-44-48-751Z.db.gz
sudo systemctl start echopersona
```

恢复前原库会自动存为 `echopersona.db.before-restore`，出问题可以再切回去。

### 异地备份（强烈建议）

```bash
# 装 rclone 后把备份同步到对象存储
rclone copy /opt/echopersona/data/backups remote:echopersona-backup --max-age 48h
```

数据库和用户上传是唯一不可再生的资产，务必异地存一份。

---

## 7. 升级与回滚

### 升级

```bash
cd /opt/echopersona
npm run backup                      # 先备份
git stash && git pull                # 或 rsync 覆盖代码
npm ci --omit=dev
npm run migrate                     # 幂等，可安全重复执行
sudo systemctl restart echopersona
npm run smoke https://your-domain.com
```

### 回滚

```bash
cd /opt/echopersona
git log --oneline -5
git checkout <上一个版本号>
npm ci --omit=dev
sudo systemctl restart echopersona
# 如果 schema 也变了，用升级前的备份恢复
sudo systemctl stop echopersona
node scripts/restore.js <备份文件>
sudo systemctl start echopersona
```

**回滚前提**：升级前一定先 `npm run backup`。

---

## 8. 横向扩容路径

当前是 **单实例 + SQLite**，这是有意为之：1 核机器上 150 MB 内存就能跑，运维成本几乎为零。

确实需要扩容时，按顺序做：

1. **先加缓存层**：静态资源交给 Nginx/CDN，减少 Node 压力（已经在做）。
2. **读写分离不适用于 SQLite**，所以真正的下一步是 **迁移到 PostgreSQL**：
   - 表结构基本可直接翻译（`schema.sql` 的语法 95% 兼容）
   - 全文检索从 FTS5 换成 `pg_trgm` 或 `tsvector`
   - 向量检索建议接 `pgvector`，替换现在的内存暴力余弦计算
   - 应用侧改动集中在 `src/db/index.js` 与 `src/lib/memory.js`
3. **多实例**：迁移到 PG 后，把 `instances` 调到 CPU 核数，前面挂 Nginx upstream。
   注意此时**不能再用本地文件存音频**，要换成 S3/OSS 对象存储
   （`src/routes/voice.js` 的写文件部分改成上传对象存储）。
4. **任务队列**：人格分析目前是进程内异步 runner，多实例后要换成 Redis/BullMQ，否则任务只在单实例内存里有状态。

在用户量到几千之前，单实例 SQLite 完全够用；提前上分布式只会增加故障面。

---

## 9. Docker 部署（可选）

```bash
cp .env.example .env
nano .env                             # 填 MASTER_KEY 和 PUBLIC_URL
docker compose up -d --build
docker compose logs -f web
docker compose exec web node --no-warnings scripts/smoke.js http://127.0.0.1:8080
```

数据在命名卷 `ep-data` 中，`docker compose down` 不会删。要彻底清空用 `docker compose down -v`（**会丢数据**）。

Nginx + HTTPS 仍在宿主机上配（复用第 4、5 步），容器只绑 `127.0.0.1:8080`。

> **诚实说明**：`Dockerfile` 与 `docker-compose.yml` 是按项目实际依赖（全部为纯 JS、无 native 编译）编写的，
> 但开发机没有 Docker 环境，**镜像构建未做过实际验证**。
> 如果你在构建时遇到问题，最可能是 Node 镜像版本或 `npm ci` 的 lockfile 不一致，
> 可直接改用第 2–3 步的非 Docker 部署，那条路径是完整验证过的。

---

## 10. 常见问题

**启动报 `MASTER_KEY is required in production`**
`.env` 里 `MASTER_KEY` 为空或不足 32 字符。用 `openssl rand -hex 32` 生成。

**启动报 `EADDRINUSE`**
8080 被占用。检查是不是同时开了 systemd 和 PM2：`sudo systemctl stop echopersona` 或 `pm2 delete echopersona`。

**聊天不逐字输出，等全部生成完才一次性出现**
Nginx 没关缓冲。确认 `deploy/nginx.conf` 里 `proxy_buffering off;` 已生效并 `reload`。

**上传 413**
`client_max_body_size` 小于 `MAX_UPLOAD_MB`。两边调一致。

**TTS 报「服务地址不合法」**
SSRF 防护拦了内网地址。自建 TTS 在 `127.0.0.1` 时要设 `SSRF_ALLOW_PRIVATE=1`；
如果 TTS 在公网域名上，保持关闭即可。

**登录一直 429**
限流生效（15 分钟 12 次）。等窗口过期，或换正确密码。
如果确实部署在 Nginx 后面，确认 `TRUST_PROXY=1`，否则所有用户共享同一个 IP 配额。

**忘记管理员密码**
直接改库：

```bash
cd /opt/echopersona
node -e "
const {run}=await import('./src/db/index.js');
const {hashPassword}=await import('./src/lib/auth.js');
run('UPDATE users SET password_hash=? WHERE email=?',[hashPassword('NewPass123456'),'you@example.com']);
console.log('done');
"
```

---

## 11. 上线检查清单

- [ ] `NODE_ENV=production`
- [ ] `MASTER_KEY` 已设置为随机 64 位十六进制，且已另行保存
- [ ] `.env` 权限 `600`，不在 git 里
- [ ] `PUBLIC_URL` 是 https 域名
- [ ] `TRUST_PROXY=1` 且应用只监听 127.0.0.1
- [ ] HTTPS 证书有效，`certbot renew --dry-run` 通过
- [ ] `npm run smoke https://你的域名` 全过
- [ ] 自动备份已开，且做过一次真实恢复演练
- [ ] 备份有异地副本
- [ ] 防火墙只开 22 / 80 / 443
- [ ] `systemctl enable` 已设置，重启机器后服务自动起来
- [ ] 管理后台能登录，且确认无法看到用户聊天内容与 API Key
