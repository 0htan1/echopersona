import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, ensureDirs, masterKeyBytes } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { scheduleBackups } from './lib/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const SENSITIVE_RE = /(authorization|api[_-]?key|xi-api-key|password|secret|cookie|token)/i;

export async function buildServer({ logger = true } = {}) {
  ensureDirs();

  const app = Fastify({
    logger: logger ? {
      level: process.env.LOG_LEVEL || 'info',
      // never log secrets
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
          'req.headers["xi-api-key"]', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
      transport: config.isProd ? undefined : undefined,
      formatters: {
        log(obj) {
          // 日志对象里常带 req/res 这类循环引用，必须做深度限制 + 循环检测，
          // 否则会 Maximum call stack size exceeded 直接把进程搞崩。
          const seen = new WeakSet();
          const clean = (o, depth = 0) => {
            if (depth > 6) return '[DepthLimit]';
            if (o === null || typeof o !== 'object') return o;
            if (seen.has(o)) return '[Circular]';
            seen.add(o);
            const out = {};
            for (const [k, v] of Object.entries(o)) {
              if (SENSITIVE_RE.test(k)) { out[k] = '[REDACTED]'; continue; }
              out[k] = clean(v, depth + 1);
            }
            seen.delete(o);
            return out;
          };
          try {
            return clean(obj);
          } catch {
            return { msg: 'log serialization failed' };
          }
        },
      },
    } : false,
    // 只有确实部署在反向代理后面时才信任 X-Forwarded-For。
    // 无条件 true 会让任何客户端伪造 IP 绕过限流与审计。
    trustProxy: config.trustProxy,
    /* bodyLimit 只管「非 multipart」的 JSON 请求体，所以 2MB 够用。
     * 但不要再指望它给上传兜底：文件走 @fastify/multipart，限制在下面的
     * fileSize 里单独设。
     *
     * 这里曾经写死 2MB，而 MAX_UPLOAD_MB 默认 50 —— 结果是 3MB 的聊天记录
     * 上传直接 413，报「请求体过大」，用户完全想不到是 bodyLimit 干的。
     * 现在按上传上限放开，让 multipart 自己按文件逐个判断。 */
    bodyLimit: Math.max(2 * 1024 * 1024, config.maxUploadBytes + 1024 * 1024),
    disableRequestLogging: config.isProd,
    /* 单请求最长 60 秒。导入已改成后台 job（立刻返回 202），
     * 长耗时工作不再占着 HTTP 连接，所以这里不需要 5 分钟的宽限 ——
     * 让真正的慢请求尽早失败，别把连接池耗光。 */
    requestTimeout: 60000,
    connectionTimeout: 30000,
  });

  app.decorate('tempKeys', new Map());
  app.decorate('db', null);

  await app.register(fastifyCookie);

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Math.max(config.maxUploadBytes, config.maxAudioRefBytes),
      files: 20,
      fields: 40,
      fieldSize: 1024 * 1024,
    },
    throwFileSizeLimit: true,
  });

  await app.register(fastifyRateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    // 必须返回 Error 实例，插件会 throw 它；返回普通对象会退化成 500。
    errorResponseBuilder: (req, ctx) => {
      const e = new Error('请求过于频繁，请稍后再试');
      e.statusCode = 429;
      e.code = 'RATE_LIMITED';
      e.retryAfter = ctx?.after || '60 seconds';
      return e;
    },
  });

  // ---------- security headers ----------
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'microphone=(), camera=(), geolocation=()');
    // HSTS 只在 HTTPS 请求上下发。判断依据用实际协议（含反代透传的
    // X-Forwarded-Proto），而不是只看 NODE_ENV —— 托管平台未必注入
    // NODE_ENV=production，但站点已经是 HTTPS，此时仍然需要 HSTS。
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim();
    if (proto === 'https' || config.isProd) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    // frame-ancestors 不写在 CSP 里：托管网关会往这条指令尾部追加源表达式
    // （实测被改写成 `frame-ancestors 'none' *`），而按规范 'none' 与其他
    // 源表达式并列时整条指令会被忽略，等于防嵌套保护失效。
    // 防嵌入改由上面的 x-frame-options: DENY 承担，语义一致且不受网关改写影响。
    reply.header('content-security-policy',
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "media-src 'self' blob:; " +
      "font-src 'self' data:; " +
      "connect-src 'self'; " +
      "base-uri 'self'; " +
      "form-action 'self'");
    return payload;
  });

  // ---------- db ----------
  app.decorate('rawDb', getDb());
  app.db = app.rawDb;

  // ---------- routes ----------
  const { default: sessionPlugin } = await import('./lib/session.js');
  const { default: authRoutes } = await import('./routes/auth.js');
  const { default: configRoutes } = await import('./routes/configs.js');
  const { default: personaRoutes } = await import('./routes/personas.js');
  const { default: importRoutes } = await import('./routes/imports.js');
  const { default: chatRoutes } = await import('./routes/chat.js');
  const { default: voiceRoutes } = await import('./routes/voice.js');
  const { default: adminRoutes } = await import('./routes/admin.js');

  // 会话解析钩子 + requireAuth/requireAdmin 必须挂在根实例上，
  // 且要在各业务路由之前注册。
  await app.register(sessionPlugin);

  await app.register(authRoutes);
  await app.register(configRoutes);
  await app.register(personaRoutes);
  await app.register(importRoutes);
  await app.register(chatRoutes);
  await app.register(voiceRoutes, { prefix: '' });
  await app.register(adminRoutes);

  // health
  app.get('/api/health', async () => {
    let dbOk = false;
    try { getDb().prepare('SELECT 1').get(); dbOk = true; } catch { dbOk = false; }
    return {
      ok: dbOk, service: 'echopersona', version: '1.0.0',
      uptime: Math.round(process.uptime()), db: dbOk, env: config.env,
      time: new Date().toISOString(),
    };
  });

  // static SPA
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
    /* 注意第一个参数是 Fastify 的 reply，不是 Node 的 res。
     *
     * @fastify/static v10 把回调签名从 `(res, path)` 改成了 `(reply, path, stat)`。
     * 写成 res.setHeader 会在每次静态请求时抛 `res.setHeader is not a function`，
     * 表现是首页、JS、CSS 全部 500 —— 而 `npm test` 只打接口，测不到这一层，
     * 所以这条必须是真实启动服务后用 curl 验证的。 */
    setHeaders(reply, filePath) {
      if (/\.(js|css)$/.test(filePath)) reply.header('cache-control', 'public, max-age=300');
      if (/\.html$/.test(filePath)) reply.header('cache-control', 'no-cache');
    },
  });

  // SPA fallback: any non-API GET -> index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: '接口不存在', code: 'NOT_FOUND' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.type('text/html').send(fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')));
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      app.log.error({ err: { message: err.message, stack: err.stack }, url: req.url }, 'request error');
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: `文件超过大小限制（${Math.round(config.maxUploadBytes / 1024 / 1024)}MB）` });
    }
    const message = status >= 500
      ? (process.env.EXPOSE_ERRORS === '1' ? err.message : '服务器内部错误，请稍后重试')
      : err.message;
    return reply.code(status).send({ error: message, code: err.code || null });
  });

  app.addHook('onClose', async () => { closeDb(); });

  return app;
}

/* ------------------------------------------------------------------ */
async function main() {
  // fail fast on missing production secrets
  masterKeyBytes();

  const app = await buildServer();

  const backupTimer = scheduleBackups(app.log);

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    try { if (backupTimer) clearInterval(backupTimer); } catch { /* ignore */ }
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => {
    app.log.error({ err: e?.message || String(e) }, 'unhandled rejection');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`${config.appName} listening on http://${config.host}:${config.port} (${config.env})`);
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

export { main };
