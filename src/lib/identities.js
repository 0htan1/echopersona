/**
 * 第三方身份登录（微信 / 手机号）。
 *
 * 为什么不能直接把「微信登录」塞进 users 表：
 *   users.email 是 NOT NULL + UNIQUE，而微信 OAuth 只给 openid，不给邮箱；
 *   手机号登录也不该被迫编一个假邮箱。硬塞会让「同一邮箱两种登录」和
 *   「同一微信绑两个号」这类边界全部变成脏数据。
 *
 * 所以单独一张 identities 表，把「外部身份」映射到「本地 user」：
 *   (provider, subject) -> user_id
 * 一个本地用户可以绑多个身份（先邮箱注册，再绑微信），
 * 一个身份只能属于一个本地用户（唯一索引保证）。
 *
 * 注意：这里**不信任前端传上来的 user_id**。绑定必须走「已登录会话」，
 * 否则任何人都能把别人的微信号绑到自己账号上。
 */
import crypto from 'node:crypto';
import { get, run, all } from '../db/index.js';

export const IDENTITY_PROVIDERS = ['wechat', 'phone'];

/** 把外部身份规范化成 (provider, subject)。手机号要抹掉格式差异。 */
export function normalizeIdentity(provider, raw) {
  if (!IDENTITY_PROVIDERS.includes(provider)) return null;
  if (provider === 'phone') {
    // 只留数字和开头的 +，避免「+86 138-0000-0000」和「13800000000」被当成两个人
    const s = String(raw || '').trim();
    if (!s) return null;
    const plus = s.startsWith('+') ? '+' : '';
    const digits = s.replace(/\D/g, '');
    if (digits.length < 6) return null;
    return { provider, subject: plus + digits };
  }
  // 微信：subject 是 openid / unionid，原样保存
  const s = String(raw || '').trim();
  if (!s) return null;
  return { provider, subject: s };
}

export function findIdentity(provider, subject) {
  return get('SELECT * FROM user_identities WHERE provider = ? AND subject = ?', [provider, subject]);
}

export function listIdentities(userId) {
  return all(
    `SELECT provider, subject, created_at AS createdAt, last_used_at AS lastUsedAt
     FROM user_identities WHERE user_id = ? ORDER BY created_at`, [userId]);
}

/**
 * 按外部身份找到或创建一个本地用户。
 *
 * 已存在 → 直接返回（并更新 last_used_at）。
 * 不存在 → 建一个「无密码」的本地用户。
 *
 * 关键点：为什么敢建无密码账号？
 * 因为 password_hash 留一个不可能被 verifyPassword 通过的哨兵值，
 * 这样这个账号**无法**用邮箱+密码登录，只能用它对应的第三方身份进来。
 * 反过来也不会出现「邮箱登录拿到了别人的微信账号」。
 */
export function upsertIdentityUser({ provider, subject, displayName = '', email = null, avatarUrl = null }) {
  const norm = normalizeIdentity(provider, subject);
  if (!norm) throw Object.assign(new Error('登录身份不合法'), { statusCode: 400 });
  const now = Date.now();

  const existing = findIdentity(norm.provider, norm.subject);
  if (existing) {
    run('UPDATE user_identities SET last_used_at = ? WHERE id = ?', [now, existing.id]);
    const user = get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [existing.user_id]);
    if (!user) {
      // 身份指向的用户已被删除：清理掉这条悬空身份，让下面重建
      run('DELETE FROM user_identities WHERE id = ?', [existing.id]);
    } else if (user.status !== 'active') {
      throw Object.assign(new Error('这个账号已被停用'), { statusCode: 403 });
    } else {
      return { created: false, userId: user.id, user };
    }
  }

  // 微信/手机号拿不到可信邮箱。users.email 是 NOT NULL + UNIQUE，
  // 所以生成一个**不可用于登录**的占位邮箱：域名用 .invalid（RFC 2606 保留），
  // 任何人都不可能真的收到这个地址的邮件，也不会与真实邮箱撞车。
  const localEmail = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
    ? email
    : `${norm.provider}_${crypto.randomUUID()}@users.invalid`;

  const userId = `usr_${crypto.randomUUID()}`;
  // 哨兵哈希：不是合法 bcrypt/scrypt 结构，verifyPassword 一定返回 false。
  // 这样这个账号无法通过「邮箱+密码」登录，只能走它绑定的第三方身份。
  const SENTINEL = '!thirdparty-no-password';
  run(
    `INSERT INTO users (id,email,password_hash,display_name,avatar_path,role,email_verified,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [userId, localEmail, SENTINEL, String(displayName || '').slice(0, 60), null,
      'user', email ? 1 : 0, 'active', now, now]);

  const id = `idn_${crypto.randomUUID()}`;
  run(
    `INSERT INTO user_identities (id,user_id,provider,subject,created_at,last_used_at)
     VALUES (?,?,?,?,?,?)`,
    [id, userId, norm.provider, norm.subject, now, now]);

  return { created: true, userId, user: get('SELECT * FROM users WHERE id = ?', [userId]) };
}

/**
 * 把外部身份绑到**当前已登录**的用户上。
 * 已经是同一个用户 → 幂等成功。
 * 已属于别人 → 拒绝（不能抢别人的绑定）。
 */
export function bindIdentity({ userId, provider, subject }) {
  const norm = normalizeIdentity(provider, subject);
  if (!norm) throw Object.assign(new Error('登录身份不合法'), { statusCode: 400 });
  const existing = findIdentity(norm.provider, norm.subject);
  if (existing) {
    if (existing.user_id === userId) return { ok: true, already: true };
    throw Object.assign(new Error('这个微信/手机号已经绑定了另一个账号'), { statusCode: 409 });
  }
  const now = Date.now();
  run(`INSERT INTO user_identities (id,user_id,provider,subject,created_at,last_used_at)
       VALUES (?,?,?,?,?,?)`,
    [`idn_${crypto.randomUUID()}`, userId, norm.provider, norm.subject, now, now]);
  return { ok: true, already: false };
}

export function unbindIdentity({ userId, provider }) {
  const r = run('DELETE FROM user_identities WHERE user_id = ? AND provider = ?', [userId, provider]);
  return { ok: true, removed: r.changes || 0 };
}

/** 这个账号有没有设置过密码（第三方登录建的账号没有） */
export function hasPassword(user) {
  const h = String(user?.password_hash || '');
  return !!h && h !== '!thirdparty-no-password';
}
