/**
 * 云端第三方登录的**服务端校验**。
 *
 * 核心原则（不要为了省一次请求破坏它）：
 *   前端拿到云端 session 后，会把 access_token 交给我们；但它**绝不**同时
 *   把 openid / 手机号报上来当依据。服务端必须拿着这个 token 自己回源
 *   问一句「你是谁」，用云端返回的身份建本地会话。
 *
 *   如果信前端报的 subject，任何人只要提交 `{ provider:'wechat',
 *   subject:'<别人的 openid>' }` 就能登录别人的账号。access_token 是唯一
 *   可信凭据，身份字段一律从上游响应里取。
 *
 * 另一个原则：微信 OAuth 在 localhost 上走不通（relay 要求 callback_url 是
 * 已发布站点的 https 地址），所以这条链路只能在正式域名验证。这一点在
 * 前端会明确提示，不假装能用。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

const AUTH_BASE = '/.cloud/auth/v1';

/**
 * 解析出「这个应用自己的 Origin」，用于回源时声明 client 身份。
 *
 * 为什么必须带：云端判定「这个 publishableKey 是哪个应用」靠的是 **Origin
 * 精确匹配**（官方设计文档 §5.2 / §7.3 原话：publishableKey 只标识哪个应用、
 * 不携带权限，安全性由服务端 Origin 精确匹配提供）。
 *
 * 浏览器里 SDK 发请求时 Origin 是浏览器**自动**加的，所以前端那条链一直正常；
 * 而 Node 的 fetch **不会**自动带 Origin。少了它，云端拿到一个有效但不属于
 * 任何 client 的请求，只能回 `invalid_grant: the session is invalid, expired
 * or issued for another client` —— 看起来像 token 有问题，实际是缺了 Origin。
 *
 * 优先用调用方传进来的真实请求 Origin（和浏览器完全一致），
 * 拿不到再退回 PUBLIC_URL —— 后者是我们配置里唯一可信的自身地址。
 */
function resolveOrigin(hint) {
  const h = String(hint || '').trim();
  if (/^https?:\/\/[^/\s]+$/i.test(h)) return h.replace(/\/+$/, '');
  try {
    return new URL(config.publicUrl).origin;
  } catch {
    return '';
  }
}

/** 云端返回多少种字段写法，都兼容一下；都是内侧接口，改过名 */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

export class CloudAuthError extends Error {
  constructor(message, statusCode = 400, code = 'CLOUD_AUTH_FAILED') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function cloudEnv() {
  const endpoint = String(process.env.EP_CLOUD_ENDPOINT || '').trim().replace(/\/+$/, '');
  const key = String(process.env.EP_CLOUD_PUBLISHABLE_KEY || '').trim();
  return { endpoint, key };
}

export function cloudAuthConfigured() {
  const { endpoint, key } = cloudEnv();
  return !!endpoint && !!key;
}

/**
 * 用 access_token 回源取云端身份。
 * 返回 { userId, subject, phone, name, avatarUrl }，全部来自上游。
 *
 * @param {string} accessToken 浏览器换到的云端 access_token
 * @param {string} [originHint] 浏览器这一跳的 Origin。必须透传 —— 云端靠它
 *   把 token 归到正确的 client 上，缺了就会被判成「issued for another client」。
 */
export async function fetchCloudIdentity(accessToken, originHint) {
  const token = String(accessToken || '').trim();
  if (!token) throw new CloudAuthError('缺少登录凭据', 400, 'NO_TOKEN');

  const { endpoint, key } = cloudEnv();
  if (!endpoint || !key) {
    throw new CloudAuthError('本站还没有配置云登录服务，请用邮箱登录', 400, 'CLOUD_AUTH_NOT_CONFIGURED');
  }

  const origin = resolveOrigin(originHint);
  const headers = {
    'x-wb-webapp-access-key': key,
    authorization: `Bearer ${token}`,
  };
  // 模拟浏览器的同源请求：云端按 Origin 精确匹配认 client。
  if (origin) headers.origin = origin;

  let res;
  try {
    res = await fetch(`${endpoint}${AUTH_BASE}/user/me`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new CloudAuthError(`云登录服务连接失败：${e.message}`, 502, 'CLOUD_AUTH_UNREACHABLE');
  }

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 就当作失败 */ }

  if (!res.ok) {
    // 401 说明 token 无效/过期。这是用户能自己解决的（重新登录），
    // 不要报成 500 吓人。
    const detail = pick(body, 'error_description', 'error', 'message') || `HTTP ${res.status}`;
    const code = pick(body, 'code');
    throw new CloudAuthError(`登录凭据无效：${detail}`, res.status === 401 ? 401 : 502,
      res.status === 401
        ? (code === 'invalid_client' ? 'CLOUD_CLIENT_MISMATCH' : 'CLOUD_TOKEN_INVALID')
        : 'CLOUD_AUTH_UPSTREAM');
  }
  if (!body || typeof body !== 'object') {
    throw new CloudAuthError('云登录服务返回了无法解析的内容', 502, 'CLOUD_AUTH_UPSTREAM');
  }

  // 兼容 user/me 可能把身份放在 user 子对象里
  const u = body.user && typeof body.user === 'object' ? body.user : body;
  const subject = pick(u, 'sub', 'uid', 'id');
  if (!subject) throw new CloudAuthError('云登录服务没有返回用户标识', 502, 'CLOUD_AUTH_UPSTREAM');

  return {
    userId: subject,
    subject,
    phone: pick(u, 'phone_number', 'phone'),
    email: pick(u, 'email'),
    name: pick(u, 'name', 'nickname', 'display_name'),
    avatarUrl: pick(u, 'avatar_url', 'avatarUrl', 'picture'),
    isAnonymous: u.is_anonymous === true,
  };
}

/**
 * 把云端身份翻译成我们要落的 (provider, subject)。
 *
 * intent 来自前端（'wechat' | 'phone'），服务端用它**选择取哪个字段**，
 * 而不是用它决定「这是谁」——谁的身份完全由上游响应决定：
 *   phone  → 必须有 phone 字段，subject = 规范化后的手机号
 *   wechat → subject = 云端用户 id
 *
 * 安全性：攻击者拿自己的 token 谎称 intent=phone，只能得到自己的手机号
 * （上游给的），拿不到别人的。谎称 intent=wechat 得到的是自己的 id。
 * 所以这个 intent 无法用于越权。
 */
export function identityFromCloud(cloud, intent) {
  if (!cloud || cloud.isAnonymous) {
    throw new CloudAuthError('这个云账号是匿名会话，不能用来登录', 400, 'CLOUD_AUTH_ANONYMOUS');
  }
  if (intent === 'phone') {
    /* 只认上游给的手机号，不做「拿 cloud.subject 顶替」的兜底。
     *
     * 试过那样的兜底，结果是更糟的 bug：同一个云端账号走微信登录时
     * subject 是 `sub`，走手机号登录时变成 `uid:<sub>`，服务端会当成两个人，
     * 各建一个本地账号 —— 用户换个登录入口就发现「我的对话全没了」。
     * 宁可给一句能看懂的错误，也不要悄悄把数据切成两半。 */
    if (!cloud.phone) {
      throw new CloudAuthError(
        '这个云端账号没有返回手机号，无法用它登录。请改用微信扫码或邮箱密码登录；'
        + '如果这是手机号注册的新账号，请先在微信里授权手机号后再试。',
        400, 'NO_PHONE',
      );
    }
    return { provider: 'phone', subject: cloud.phone, displayName: cloud.name || '' };
  }
  if (intent === 'wechat') {
    return { provider: 'wechat', subject: cloud.subject, displayName: cloud.name || '' };
  }
  throw new CloudAuthError('不支持的登录方式', 400, 'BAD_INTENT');
}

/** 下发到浏览器的云登录配置。都是公开值，不是密钥。 */
export function publicCloudAuthConfig() {
  const { endpoint, key } = cloudEnv();
  return {
    enabled: !!endpoint && !!key,
    endpoint,
    publishableKey: key,
    oauthRelayBaseUrl: String(process.env.EP_CLOUD_OAUTH_RELAY_BASE_URL || '').trim(),
  };
}

/** 只用于日志/审计的短指纹，避免把 token 写进日志 */
export function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}
