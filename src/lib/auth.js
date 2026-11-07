import crypto from 'node:crypto';
import { get as dbGet, run as dbRun, all as dbAll, tx } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from './crypto.js';
import { hasPassword as identityHasPassword, listIdentities } from './identities.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateEmail(email) {
  const e = normalizeEmail(email);
  if (e.length > 254 || !EMAIL_RE.test(e)) return { ok: false, error: '邮箱格式不正确' };
  return { ok: true, value: e };
}

export function validatePassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (s.length > 200) return { ok: false, error: '密码过长' };
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return { ok: false, error: '密码需同时包含字母和数字' };
  return { ok: true };
}

export function clientIp(req) {
  // trust proxy is enabled for loopback in server.js; use req.ip
  return (req.ip || '').replace(/^::ffff:/, '');
}

export async function createUser({ email, password, displayName, role = 'user' }) {
  const v = validateEmail(email);
  if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 400 });
  const pv = validatePassword(password);
  if (!pv.ok) throw Object.assign(new Error(pv.error), { statusCode: 400 });

  const existing = dbGet('SELECT id FROM users WHERE email = ?', [v.value]);
  if (existing) throw Object.assign(new Error('该邮箱已注册'), { statusCode: 409 });

  const id = `usr_${crypto.randomUUID()}`;
  const now = Date.now();
  const name = String(displayName || '').trim().slice(0, 60) || v.value.split('@')[0];
  dbRun(
    `INSERT INTO users (id,email,password_hash,display_name,role,email_verified,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, v.value, await hashPassword(password), name,
      config.adminEmail && v.value === config.adminEmail ? 'admin' : role,
      config.requireEmailVerify ? 0 : 1, 'active', now, now]
  );
  return getPublicUser(id);
}

export function getPublicUser(id) {
  const u = dbGet(
    `SELECT id,email,password_hash,display_name,avatar_path,role,email_verified,status,created_at,updated_at,ui_theme
     FROM users WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    avatarPath: u.avatar_path,
    role: u.role,
    emailVerified: !!u.email_verified,
    status: u.status,
    createdAt: u.created_at,
    isAdmin: u.role === 'admin',
    // 聊天界面外观：classic（现有）/ wechat（复刻微信）
    uiTheme: u.ui_theme === 'wechat' ? 'wechat' : 'classic',
    // 微信/手机号登录建的账号没有密码（password_hash 是哨兵值）。
    // 前端必须知道这一点，否则会给他显示「修改密码」表单，
    // 而那张表单项一项都填不对——他没有旧密码可填。
    hasPassword: identityHasPassword(u),
    // 占位邮箱（@users.invalid）不该展示给用户，那是内部实现细节。
    placeholderEmail: /@users\.invalid$/i.test(String(u.email || '')),
    identities: listIdentities(u.id).map((x) => ({ provider: x.provider, subject: x.subject })),
  };
}

export async function authenticate(email, password) {
  const e = normalizeEmail(email);
  const u = dbGet('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [e]);
  // constant-ish time: always run a hash verify
  const dummy = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88);
  const ok = await verifyPassword(password, u ? u.password_hash : dummy);
  if (!u || !ok) return { ok: false, error: '邮箱或密码错误' };
  if (u.status !== 'active') return { ok: false, error: '账户已被停用' };
  if (config.requireEmailVerify && !u.email_verified) {
    return { ok: false, error: '邮箱尚未验证，请先完成邮箱验证', needVerify: true };
  }
  return { ok: true, user: getPublicUser(u.id) };
}

export function createSession(userId, { ip, ua } = {}) {
  const id = randomToken(32);
  const now = Date.now();
  const expires = now + config.sessionTtlDays * 86400_000;
  dbRun(
    `INSERT INTO sessions (id,user_id,created_at,expires_at,last_seen,ip,user_agent) VALUES (?,?,?,?,?,?,?)`,
    [sha256(id), userId, now, expires, now, ip || null, (ua || '').slice(0, 300)]
  );
  return { token: id, expires };
}

export function resolveSession(token) {
  if (!token) return null;
  const row = dbGet('SELECT * FROM sessions WHERE id = ?', [sha256(token)]);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    dbRun('DELETE FROM sessions WHERE id = ?', [row.id]);
    return null;
  }
  // sliding refresh at most once per hour
  if (now - row.last_seen > 3600_000) {
    dbRun('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?',
      [now, now + config.sessionTtlDays * 86400_000, row.id]);
  }
  const user = getPublicUser(row.user_id);
  if (!user || user.status !== 'active') return null;
  return { user, sessionId: row.id };
}

export function destroySession(token) {
  if (!token) return;
  dbRun('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
}

export function destroyAllSessions(userId, exceptToken = null) {
  if (exceptToken) {
    dbRun('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, sha256(exceptToken)]);
  } else {
    dbRun('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

export function listSessions(userId) {
  return dbAll(
    'SELECT id,created_at,expires_at,last_seen,ip,user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC',
    [userId]
  );
}

// ---- password reset / email change tokens -------------------------
export function issueToken(userId, kind, payload = null, ttlMs = 3600_000) {
  const raw = randomToken(32);
  const now = Date.now();
  dbRun(
    'INSERT INTO auth_tokens (id,user_id,kind,payload,expires_at,created_at) VALUES (?,?,?,?,?,?)',
    [sha256(raw), userId, kind, payload, now + ttlMs, now]
  );
  return raw;
}

export function consumeToken(raw, kind) {
  const h = sha256(String(raw || ''));
  const row = dbGet('SELECT * FROM auth_tokens WHERE id = ? AND kind = ?', [h, kind]);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  dbRun('UPDATE auth_tokens SET used_at = ? WHERE id = ?', [Date.now(), h]);
  return row;
}

export async function changePassword(userId, newPassword) {
  const pv = validatePassword(newPassword);
  if (!pv.ok) throw Object.assign(new Error(pv.error), { statusCode: 400 });
  dbRun('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [await hashPassword(newPassword), Date.now(), userId]);
}

export async function changeEmail(userId, newEmail) {
  const v = validateEmail(newEmail);
  if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 400 });
  const clash = dbGet('SELECT id FROM users WHERE email = ? AND id != ?', [v.value, userId]);
  if (clash) throw Object.assign(new Error('该邮箱已被其他账户使用'), { statusCode: 409 });
  dbRun('UPDATE users SET email = ?, email_verified = ?, updated_at = ? WHERE id = ?',
    [v.value, config.requireEmailVerify ? 0 : 1, Date.now(), userId]);
}

export function audit(userId, action, { target = null, meta = null, ip = null, ua = null } = {}) {
  try {
    dbRun(
      'INSERT INTO audit_logs (id,user_id,action,target,meta_json,ip,ua,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [`log_${crypto.randomUUID()}`, userId, action, target, meta ? JSON.stringify(meta).slice(0, 4000) : null, ip, (ua || '').slice(0, 300), Date.now()]
    );
  } catch { /* logging must never break the request */ }
}
