import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  createUser, authenticate, createSession, destroySession,
  destroyAllSessions, getPublicUser, issueToken, consumeToken, changePassword,
  changeEmail, validateEmail, validatePassword, audit, normalizeEmail, listSessions,
} from '../lib/auth.js';
import {
  fetchCloudIdentity, identityFromCloud, publicCloudAuthConfig, cloudAuthConfigured, tokenFingerprint,
} from '../lib/cloud-auth.js';
import {
  upsertIdentityUser, bindIdentity, unbindIdentity, hasPassword, listIdentities, IDENTITY_PROVIDERS,
} from '../lib/identities.js';
import { get, run } from '../db/index.js';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE_OPTS = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd && config.publicUrl.startsWith('https'),
  path: '/',
});

export default async function authRoutes(app) {
  // 会话钩子与 requireAuth/requireAdmin 已在 src/lib/session.js 中
  // 以 fastify-plugin 注册到根实例，这里直接复用。
  const requireAuth = app.requireAuth;
  const requireAdmin = app.requireAdmin;

  // ---- session state ----
  app.get('/api/auth/session', async (req) => {
    if (!req.user) return { authenticated: false, user: null, config: publicConfig() };
    return { authenticated: true, user: req.user, config: publicConfig() };
  });

  // ---- register ----
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
    schema: {
      body: {
        type: 'object', required: ['email', 'password'],
        properties: {
          email: { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 200 },
          displayName: { type: 'string', maxLength: 60 },
          consent: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!config.allowRegistration) {
      return reply.code(403).send({ error: '当前未开放注册' });
    }
    if (!req.body.consent) {
      return reply.code(400).send({ error: '请先阅读并同意隐私说明与使用条款' });
    }
    try {
      const user = await createUser({
        email: req.body.email, password: req.body.password, displayName: req.body.displayName,
      });
      const { token } = createSession(user.id, { ip: req.ip, ua: req.headers['user-agent'] });
      reply.setCookie(config.sessionCookie, token, { ...COOKIE_OPTS(), maxAge: config.sessionTtlDays * 86400 });
      audit(user.id, 'user.register', { ip: req.ip, ua: req.headers['user-agent'] });
      return { ok: true, user };
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });

  // ---- login ----
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 12, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: '请填写邮箱和密码' });
    const r = await authenticate(email, password);
    if (!r.ok) {
      audit(null, 'user.login_failed', { meta: { email: normalizeEmail(email) }, ip: req.ip, ua: req.headers['user-agent'] });
      return reply.code(401).send({ error: r.error, needVerify: r.needVerify || false });
    }
    const { token } = createSession(r.user.id, { ip: req.ip, ua: req.headers['user-agent'] });
    reply.setCookie(config.sessionCookie, token, { ...COOKIE_OPTS(), maxAge: config.sessionTtlDays * 86400 });
    audit(r.user.id, 'user.login', { ip: req.ip, ua: req.headers['user-agent'] });
    return { ok: true, user: r.user };
  });

  // ---- logout ----
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[config.sessionCookie];
    destroySession(token);
    reply.clearCookie(config.sessionCookie, { path: '/' });
    if (req.user) audit(req.user.id, 'user.logout', { ip: req.ip });
    return { ok: true };
  });

  /* ==================================================================
   * 云端第三方登录（微信 / 手机号）
   *
   * 前端流程：
   *   1. 浏览器用 SDK 走完扫码 / 收验证码，拿到云端 session.accessToken
   *   2. 把 accessToken 交给下面这个端点
   *   3. 服务端拿 token 回源问云端「这是谁」，再换成我们自己的 ep_session
   *
   * 为什么不让前端直接报 openid / 手机号：
   *   那样任何人提交一个别人的 openid 就能登录别人的账号。
   *   accessToken 是唯一可信凭据，身份字段一律取自上游响应。
   * ================================================================== */

  // 下发到浏览器的云登录公开配置（endpoint / publishableKey 本来就是公开值）
  app.get('/api/auth/cloud-config', async () => publicCloudAuthConfig());

  /**
   * 用云端 accessToken 换取本地会话。
   *
   * intent 只用来**决定从上游响应里取哪个字段**（手机号还是用户 id），
   * 不用来决定「这是谁」。所以伪造 intent 拿不到别人的身份。
   */
  app.post('/api/auth/cloud/exchange', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    schema: {
      body: {
        type: 'object', required: ['accessToken'],
        properties: {
          accessToken: { type: 'string', maxLength: 8192 },
          intent: { type: 'string', maxLength: 20 },
          // 已登录用户（想把微信绑到现有账号）带意愿标志；
          // 但最终仍然要求 cookie 里有会话，不信任这个布尔值本身。
          link: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!cloudAuthConfigured()) {
      return reply.code(400).send({
        error: '本站还没有配置云登录服务，请用邮箱登录。',
        code: 'CLOUD_AUTH_NOT_CONFIGURED',
      });
    }
    const intent = String(req.body?.intent || '').trim();
    if (intent !== 'wechat' && intent !== 'phone') {
      return reply.code(400).send({ error: '不支持的登录方式', code: 'BAD_INTENT' });
    }

    let cloud;
    try {
      /* 唯一的信任来源：服务端自己回源查。前端说什么都不作数。
       *
       * 但 Origin 必须透传 —— 它不是身份，而是「这个请求来自哪个客户端」。
       * 云端按 Origin 精确匹配来认 publishableKey 属于哪个应用，浏览器里
       * SDK 发请求时这个头是浏览器自动加的，服务端用 Node fetch 则不会，
       * 少了它云端会把一个合法 token 判成 "issued for another client"。
       *
       * 安全性不受影响：身份依然 100% 来自上游响应；Origin 顶多让云端
       * 拒绝这次查询，不能伪造出别人的身份。 */
      cloud = await fetchCloudIdentity(req.body.accessToken, req.headers.origin);
    } catch (e) {
      app.log.warn({ err: e.message, fp: tokenFingerprint(req.body?.accessToken), code: e.code },
        '[cloud-auth] 校验云端身份失败');
      return reply.code(e.statusCode || 400).send({ error: e.message, code: e.code || 'CLOUD_AUTH_FAILED' });
    }

    let ident;
    try {
      ident = identityFromCloud(cloud, intent);
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message, code: e.code || 'CLOUD_AUTH_FAILED' });
    }

    const ua = req.headers['user-agent'];

    // 情况 A：已登录 + 想绑定 —— 把身份挂到当前账号上
    if (req.body.link === true) {
      if (!req.user) {
        return reply.code(401).send({
          error: '登录状态已过期，请重新登录后再绑定', code: 'UNAUTHENTICATED',
        });
      }
      try {
        const r = bindIdentity({ userId: req.user.id, provider: ident.provider, subject: ident.subject });
        audit(req.user.id, 'user.identity_bind', {
          ip: req.ip, ua, meta: { provider: ident.provider, already: r.already },
        });
        return { ok: true, linked: true, provider: ident.provider, already: !!r.already, user: getPublicUser(req.user.id) };
      } catch (e) {
        return reply.code(e.statusCode || 400).send({ error: e.message });
      }
    }

    // 情况 B：登录 / 首登即注册
    let r;
    try {
      r = upsertIdentityUser({
        provider: ident.provider,
        subject: ident.subject,
        displayName: ident.displayName,
        email: null,
      });
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }

    const { token } = createSession(r.userId, { ip: req.ip, ua });
    reply.setCookie(config.sessionCookie, token, { ...COOKIE_OPTS(), maxAge: config.sessionTtlDays * 86400 });
    audit(r.userId, r.created ? 'user.register_thirdparty' : 'user.login_thirdparty', {
      ip: req.ip, ua, meta: { provider: ident.provider },
    });
    return {
      ok: true, created: r.created, provider: ident.provider,
      user: getPublicUser(r.userId),
    };
  });

  /* ---------------------------------------------- 身份绑定管理（已登录） */
  app.get('/api/me/identities', { preHandler: requireAuth }, async (req) => {
    const u = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    return {
      identities: listIdentities(req.user.id).map((x) => ({
        provider: x.provider,
        // 手机号部分打码：这是设置页，没必要把完整号码再画一遍
        subject: x.provider === 'phone'
          ? String(x.subject).replace(/^(\+?\d{1,4})(\d+)(\d{4})$/, '$1****$3')
          : String(x.subject).slice(0, 8) + '…',
        createdAt: x.createdAt,
      })),
      // 没有任何登录方式可用时必须拦住解绑：会把账号锁死进不去
      canUnbind: hasPassword(u),
      providers: IDENTITY_PROVIDERS,
    };
  });

  app.delete('/api/me/identities/:provider', { preHandler: requireAuth }, async (req, reply) => {
    const provider = String(req.params.provider || '');
    if (!IDENTITY_PROVIDERS.includes(provider)) {
      return reply.code(400).send({ error: '未知的登录方式' });
    }
    // 关键保护：这个账号如果没设密码，解绑唯一身份 = 永久锁死自己的账号。
    //
    // 注意不能只看「一共绑了几个」——解绑是按 provider 整批删的，
    // 一个人可能绑了两个微信身份（比如换了微信号又绑一次）。
    // 所以要算「删掉这个 provider 之后还剩几个」，剩 0 且无密码才拦。
    const u = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const mine = listIdentities(req.user.id);
    const remaining = mine.filter((x) => x.provider !== provider).length;
    if (!hasPassword(u) && remaining === 0) {
      return reply.code(400).send({
        error: '这是你唯一的登录方式，解绑后将无法登录。请先设置密码。',
        code: 'LAST_IDENTITY',
      });
    }
    const r = unbindIdentity({ userId: req.user.id, provider });
    audit(req.user.id, 'user.identity_unbind', { ip: req.ip, meta: { provider, removed: r.removed } });
    return { ok: true, removed: r.removed };
  });

  /**
   * 第三方账号补设密码。
   * 微信/手机号登录建的账号没有旧密码，所以这里**不要求** currentPassword，
   * 但要求已登录（有会话），且只允许在「当前没有密码」时使用。
   * 有密码的账号改密码必须走 /api/me/password 验旧密码，
   * 否则就是给会话劫持者一个直接改密码的后门。
   */
  app.post('/api/me/password/first', { preHandler: requireAuth }, async (req, reply) => {
    const u = get('SELECT password_hash, email FROM users WHERE id = ?', [req.user.id]);
    if (hasPassword(u)) {
      return reply.code(400).send({ error: '这个账号已经有密码了，请使用「修改密码」。', code: 'ALREADY_HAS_PASSWORD' });
    }
    const pw = String(req.body?.newPassword || '');
    const pv = validatePassword(pw);
    if (!pv.ok) return reply.code(400).send({ error: pv.error });

    // 顺手把占位邮箱换成用户填的真实邮箱（否则以后没法用邮箱登录）
    const wantedEmail = normalizeEmail(req.body?.email || '');
    let email = u.email;
    if (wantedEmail) {
      const v = validateEmail(wantedEmail);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      const clash = get('SELECT id FROM users WHERE email = ? AND id != ?', [v.value, req.user.id]);
      if (clash) return reply.code(409).send({ error: '该邮箱已被其他账户使用' });
      email = v.value;
    } else if (/@users\.invalid$/i.test(String(u.email || ''))) {
      // 不填邮箱也允许，但不能留着占位邮箱当登录名——它永远收不到信
      email = u.email;
    }

    await changePassword(req.user.id, pw);
    if (email !== u.email) {
      run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [email, Date.now(), req.user.id]);
    }
    audit(req.user.id, 'user.password_set_first', { ip: req.ip });
    return { ok: true, user: getPublicUser(req.user.id) };
  });

  // ---- password reset request ----
  app.post('/api/auth/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '30 minutes' } },
  }, async (req, reply) => {
    const email = normalizeEmail(req.body?.email);
    const user = get('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [email]);
    if (user) {
      const raw = issueToken(user.id, 'password_reset', null, 3600_000);
      const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(raw)}`;
      // No SMTP configured -> surface the link to the operator log only (never to the client).
      if (!config.smtpUrl) {
        app.log.warn({ email, link }, '[password-reset] SMTP 未配置，重置链接已输出到服务端日志');
      } else {
        try {
          const { sendMail } = await import('../lib/mail.js');
          await sendMail({ to: email, subject: 'EchoPersona 密码重置', text: `点击链接重置密码（1 小时内有效）：\n${link}` });
        } catch (e) {
          app.log.error({ err: e.message }, '[password-reset] 邮件发送失败');
        }
      }
      audit(user.id, 'user.password_reset_request', { ip: req.ip });
    }
    // Always the same response: no account enumeration.
    return { ok: true, message: '如果该邮箱已注册，我们已发送重置链接。' };
  });

  app.post('/api/auth/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { token, password } = req.body || {};
    const row = consumeToken(token, 'password_reset');
    if (!row) return reply.code(400).send({ error: '重置链接无效或已过期' });
    const pv = validatePassword(password);
    if (!pv.ok) return reply.code(400).send({ error: pv.error });
    await changePassword(row.user_id, password);
    destroyAllSessions(row.user_id);
    audit(row.user_id, 'user.password_reset', { ip: req.ip });
    return { ok: true };
  });

  // ---- profile ----
  app.get('/api/me', { preHandler: requireAuth }, async (req) => ({ user: req.user }));

  app.patch('/api/me', { preHandler: requireAuth }, async (req, reply) => {
    const { displayName, uiTheme } = req.body || {};
    if (typeof displayName === 'string') {
      const name = displayName.trim().slice(0, 60);
      if (!name) return reply.code(400).send({ error: '昵称不能为空' });
      run('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), req.user.id]);
    }
    if (uiTheme !== undefined) {
      // 只接受这两个值：其它任何输入都落回 classic，不让前端塞任意字符串进库
      const theme = uiTheme === 'wechat' ? 'wechat' : 'classic';
      run('UPDATE users SET ui_theme = ?, updated_at = ? WHERE id = ?', [theme, Date.now(), req.user.id]);
    }
    return { ok: true, user: getPublicUser(req.user.id) };
  });

  app.post('/api/me/password', { preHandler: requireAuth }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body || {};
    const u = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const { verifyPassword } = await import('../lib/crypto.js');
    if (!(await verifyPassword(currentPassword || '', u.password_hash))) {
      return reply.code(400).send({ error: '当前密码不正确' });
    }
    await changePassword(req.user.id, newPassword);
    // keep current session, drop others
    destroyAllSessions(req.user.id, req.cookies?.[config.sessionCookie]);
    audit(req.user.id, 'user.password_change', { ip: req.ip });
    return { ok: true };
  });

  app.post('/api/me/email', { preHandler: requireAuth }, async (req, reply) => {
    const { email, password } = req.body || {};
    const u = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const { verifyPassword } = await import('../lib/crypto.js');
    if (!(await verifyPassword(password || '', u.password_hash))) {
      return reply.code(400).send({ error: '请输入当前密码以确认修改' });
    }
    try {
      await changeEmail(req.user.id, email);
      audit(req.user.id, 'user.email_change', { ip: req.ip });
      return { ok: true, user: getPublicUser(req.user.id) };
    } catch (e) {
      return reply.code(e.statusCode || 400).send({ error: e.message });
    }
  });

  // ---- avatar ----
  app.post('/api/me/avatar', { preHandler: requireAuth }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: config.maxAvatarBytes, files: 1 } });
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    const allowed = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = allowed[file.mimetype];
    if (!ext) return reply.code(400).send({ error: '头像仅支持 PNG / JPG / WEBP / GIF' });
    const buf = await file.toBuffer();
    if (buf.length > config.maxAvatarBytes) return reply.code(413).send({ error: '图片过大' });
    const name = `u_${req.user.id}_${Date.now()}${ext}`;
    fs.mkdirSync(config.avatarDir, { recursive: true });
    fs.writeFileSync(path.join(config.avatarDir, name), buf);
    const old = get('SELECT avatar_path FROM users WHERE id = ?', [req.user.id])?.avatar_path;
    run('UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?', [name, Date.now(), req.user.id]);
    if (old && old !== name) {
      try { fs.unlinkSync(path.join(config.avatarDir, old)); } catch { /* ignore */ }
    }
    return { ok: true, user: getPublicUser(req.user.id), avatarUrl: `/api/avatar/${name}` };
  });

  app.get('/api/avatar/:name', async (req, reply) => {
    const name = String(req.params.name || '').replace(/[^A-Za-z0-9_.-]/g, '');
    if (!name || name.includes('..')) return reply.code(400).send({ error: 'bad name' });
    const p = path.join(config.avatarDir, name);
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'not found' });
    const ext = path.extname(name).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
    reply.type(mime).header('cache-control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(p));
  });

  // ---- sessions ----
  app.get('/api/me/sessions', { preHandler: requireAuth }, async (req) => {
    const list = listSessions(req.user.id).map((s) => ({
      id: s.id.slice(0, 12),
      current: s.id === req.sessionId,
      createdAt: s.created_at, lastSeen: s.last_seen, expiresAt: s.expires_at,
      ip: s.ip, userAgent: s.user_agent,
    }));
    return { sessions: list };
  });

  app.post('/api/me/sessions/revoke-others', { preHandler: requireAuth }, async (req) => {
    destroyAllSessions(req.user.id, req.cookies?.[config.sessionCookie]);
    audit(req.user.id, 'user.sessions_revoke', { ip: req.ip });
    return { ok: true };
  });

  // ---- data export & account deletion ----
  app.get('/api/me/export', { preHandler: requireAuth, config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { buildExport } = await import('../lib/export.js');
    const data = buildExport(req.user.id);
    audit(req.user.id, 'user.data_export', { ip: req.ip });
    reply.header('content-disposition', `attachment; filename="echopersona-export-${Date.now()}.json"`);
    reply.type('application/json');
    return reply.send(JSON.stringify(data, null, 2));
  });

  app.delete('/api/me', { preHandler: requireAuth }, async (req, reply) => {
    const { password, confirm } = req.body || {};
    if (confirm !== 'DELETE') return reply.code(400).send({ error: '请输入 DELETE 以确认永久删除' });
    const u = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const { verifyPassword } = await import('../lib/crypto.js');
    if (!(await verifyPassword(password || '', u.password_hash))) {
      return reply.code(400).send({ error: '密码不正确' });
    }
    const { purgeUser } = await import('../lib/export.js');
    audit(req.user.id, 'user.delete_account', { ip: req.ip });
    purgeUser(req.user.id);
    reply.clearCookie(config.sessionCookie, { path: '/' });
    return { ok: true };
  });
}

export function publicConfig() {
  return {
    allowRegistration: config.allowRegistration,
    requireEmailVerify: config.requireEmailVerify,
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    maxAudioMb: Math.round(config.maxAudioBytes / 1024 / 1024),
    maxAudioRefMb: Math.round(config.maxAudioRefBytes / 1024 / 1024),
    appName: config.appName,
    smtpConfigured: !!config.smtpUrl,
    // 登录页据此决定要不要画「微信登录 / 手机号登录」按钮。
    // 云服务没配置时按钮根本不出现，而不是点了才报错。
    cloudAuthEnabled: cloudAuthConfigured(),
  };
}
