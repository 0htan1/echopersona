import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- minimal .env loader (no dependency) ---
export function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const ROOT = process.cwd();

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  // 默认绑定 0.0.0.0：托管平台通过反向代理访问容器，只监听回环会连不上。
  // 本地开发若只想本机访问，显式设 HOST=127.0.0.1。
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8080),
  appName: 'EchoPersona',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:8080',

  // storage
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
  get dbFile() { return path.join(this.dataDir, 'echopersona.db'); },
  get uploadDir() { return path.join(this.dataDir, 'uploads'); },
  get audioDir() { return path.join(this.dataDir, 'audio'); },
  get avatarDir() { return path.join(this.dataDir, 'avatars'); },
  get backupDir() { return path.join(this.dataDir, 'backups'); },
  get logDir() { return path.join(this.dataDir, 'logs'); },

  // secrets
  masterKey: process.env.MASTER_KEY || '',
  sessionCookie: 'ep_session',
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 30),

  // limits
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
  maxAudioBytes: Number(process.env.MAX_AUDIO_MB || 20) * 1024 * 1024,
  maxAvatarBytes: 4 * 1024 * 1024,
  maxAudioRefBytes: Number(process.env.MAX_AUDIO_REF_MB || 10) * 1024 * 1024,
  maxZipEntries: 200,
  maxZipUncompressed: Number(process.env.MAX_ZIP_UNCOMPRESSED_MB || 200) * 1024 * 1024,

  // SSRF
  ssrfAllowPrivate: bool(process.env.SSRF_ALLOW_PRIVATE, false),
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120000),

  // 反向代理：设为 1（或 CIDR 列表）时才信任 X-Forwarded-For。
  // 默认关闭，避免客户端伪造 IP 绕过限流。
  trustProxy: (() => {
    const raw = (process.env.TRUST_PROXY || '').trim();
    if (!raw) return false;
    if (raw === 'true' || raw === '1') return true;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  })(),

  // registration
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  requireEmailVerify: bool(process.env.REQUIRE_EMAIL_VERIFY, false),
  adminEmail: (process.env.ADMIN_EMAIL || '').toLowerCase(),

  // mail (optional; if unset, reset links are printed to console for admin)
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'no-reply@echopersona.local',

  // retention
  auditLogDays: Number(process.env.AUDIT_LOG_DAYS || 180),
  ttsCacheDays: Number(process.env.TTS_CACHE_DAYS || 30),
};

export function ensureDirs() {
  for (const d of [config.dataDir, config.uploadDir, config.audioDir, config.avatarDir, config.backupDir, config.logDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Derive a stable 32-byte encryption key from MASTER_KEY.
 *
 * 优先用环境变量；未设置时回退到数据目录里的密钥文件（0600，首次启动生成）。
 * 这样托管平台无需把密钥写死进代码/配置，密钥随数据卷持久化，重启后旧密文仍可解密。
 * 兼容早期版本的 .devkey 文件名，避免升级后历史数据解不开。
 */
export function masterKeyBytes() {
  const raw = config.masterKey;
  if (raw && raw.length >= 16) {
    return crypto.createHash('sha256').update(raw).digest();
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const legacy = path.join(config.dataDir, '.devkey');
  const f = fs.existsSync(legacy) ? legacy : path.join(config.dataDir, '.masterkey');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
