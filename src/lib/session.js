// 会话与鉴权装饰：必须在根实例上注册（用 fastify-plugin 跳出封装），
// 否则 onRequest 钩子和 requireAuth 只对 auth 插件内部路由生效。
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { resolveSession } from './auth.js';

export const requireAuth = async (req, reply) => {
  if (!req.user) {
    return reply.code(401).send({ error: '未登录或登录已过期', code: 'UNAUTHENTICATED' });
  }
};

export const requireAdmin = async (req, reply) => {
  if (!req.user) {
    return reply.code(401).send({ error: '未登录或登录已过期', code: 'UNAUTHENTICATED' });
  }
  if (req.user.role !== 'admin') {
    return reply.code(403).send({ error: '需要管理员权限', code: 'FORBIDDEN' });
  }
};

async function sessionPlugin(app) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[config.sessionCookie];
    if (!token) return;
    const s = resolveSession(token);
    if (s) {
      req.user = s.user;
      req.sessionId = s.sessionId;
    }
  });

  app.decorate('requireAuth', requireAuth);
  app.decorate('requireAdmin', requireAdmin);
}

export default fp(sessionPlugin, { name: 'ep-session', fastify: '5.x' });
