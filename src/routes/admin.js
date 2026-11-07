import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';

export default async function adminRoutes(app) {
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/admin/overview', admin, async () => {
    const now = Date.now();
    const day = 86400_000;
    const users = get('SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL').c;
    const newUsers7 = get('SELECT COUNT(*) c FROM users WHERE created_at > ? AND deleted_at IS NULL', [now - 7 * day]).c;
    const personas = get('SELECT COUNT(*) c FROM personas').c;
    const messages = get('SELECT COUNT(*) c FROM messages').c;
    const memories = get('SELECT COUNT(*) c FROM memories WHERE is_deleted = 0').c;
    const chunks = get('SELECT COUNT(*) c FROM memory_chunks').c;
    const audio = get("SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM tts_audio WHERE status='ready'").c;
    const audioBytes = get("SELECT COALESCE(SUM(bytes),0) b FROM tts_audio WHERE status='ready'").b;
    const imports = get('SELECT COUNT(*) c FROM import_files').c;
    const failedJobs = get("SELECT COUNT(*) c FROM jobs WHERE status='failed' AND created_at > ?", [now - 7 * day]).c;
    const activeJobs = get("SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')").c;
    const sessions = get('SELECT COUNT(*) c FROM sessions WHERE expires_at > ?', [now]).c;

    return {
      users, newUsers7, personas, messages, memories, chunks,
      audioFiles: audio, audioBytes, imports, failedJobs, activeJobs, activeSessions: sessions,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      env: config.env,
    };
  });

  app.get('/api/admin/users', admin, async (req) => {
    const limit = Math.min(200, Number(req.query?.limit) || 50);
    const q = String(req.query?.q || '').trim();
    let rows;
    if (q) {
      rows = all(
        `SELECT u.id,u.email,u.display_name,u.role,u.status,u.created_at,
                (SELECT COUNT(*) FROM personas WHERE user_id=u.id) AS personas
         FROM users u WHERE u.deleted_at IS NULL AND (u.email LIKE ? OR u.display_name LIKE ?)
         ORDER BY u.created_at DESC LIMIT ?`, [`%${q}%`, `%${q}%`, limit]);
    } else {
      rows = all(
        `SELECT u.id,u.email,u.display_name,u.role,u.status,u.created_at,
                (SELECT COUNT(*) FROM personas WHERE user_id=u.id) AS personas
         FROM users u WHERE u.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT ?`, [limit]);
    }
    // Deliberately no chat content, no API keys, no message counts per persona body.
    return {
      users: rows.map((u) => ({
        id: u.id, email: u.email, displayName: u.display_name, role: u.role, status: u.status,
        createdAt: u.created_at, personaCount: u.personas,
      })),
    };
  });

  app.post('/api/admin/users/:id/status', admin, async (req, reply) => {
    const { status } = req.body || {};
    if (!['active', 'suspended'].includes(status)) return reply.code(400).send({ error: 'status 必须是 active 或 suspended' });
    const u = get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
    if (!u) return reply.code(404).send({ error: '用户不存在' });
    if (u.role === 'admin' && status === 'suspended') return reply.code(400).send({ error: '不能停用管理员账户' });
    run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), u.id]);
    if (status === 'suspended') run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    return { ok: true };
  });

  app.get('/api/admin/system', admin, async () => {
    const mem = process.memoryUsage();
    const dbStat = fs.existsSync(config.dbFile) ? fs.statSync(config.dbFile) : null;
    const dirSize = (dir) => {
      let total = 0;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) total += dirSize(fp);
          else total += fs.statSync(fp).size;
        }
      } catch { /* ignore */ }
      return total;
    };
    const load = os.loadavg();
    return {
      uptimeSec: Math.round(process.uptime()),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      system: {
        totalMem: os.totalmem(), freeMem: os.freemem(), cpus: os.cpus().length,
        load1: load[0], platform: os.platform(), release: os.release(),
      },
      storage: {
        database: dbStat?.size || 0,
        uploads: dirSize(config.uploadDir),
        audio: dirSize(config.audioDir),
        backups: dirSize(config.backupDir),
      },
      db: {
        file: config.dbFile,
        walSize: fs.existsSync(`${config.dbFile}-wal`) ? fs.statSync(`${config.dbFile}-wal`).size : 0,
        integrity: checkIntegrity(),
      },
    };
  });

  app.get('/api/admin/jobs', admin, async (req) => {
    const rows = all(
      `SELECT j.*, u.email FROM jobs j LEFT JOIN users u ON u.id = j.user_id
       ORDER BY j.created_at DESC LIMIT 100`);
    return {
      jobs: rows.map((j) => ({
        id: j.id, type: j.type, status: j.status, progress: j.progress, stage: j.stage,
        error: j.error, createdAt: j.created_at, updatedAt: j.updated_at,
        email: maskEmail(j.email), // masked: admin sees status, not identity detail
      })),
    };
  });

  app.get('/api/admin/logs', admin, async (req) => {
    const limit = Math.min(300, Number(req.query?.limit) || 100);
    const level = req.query?.level;
    const dir = config.logDir;
    if (!fs.existsSync(dir)) return { logs: [] };
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().reverse().slice(0, 3);
    const out = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).slice(-limit);
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          if (level && j.level !== level && j.levelName !== level) continue;
          out.push({ ...sanitizeLog(j), file: f });
        } catch { /* skip */ }
      }
      if (out.length >= limit) break;
    }
    return { logs: out.slice(-limit).reverse() };
  });

  app.get('/api/admin/audit', admin, async (req) => {
    const limit = Math.min(300, Number(req.query?.limit) || 100);
    const rows = all(
      `SELECT l.*, u.email FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT ?`, [limit]);
    return {
      logs: rows.map((l) => ({
        id: l.id, action: l.action, target: l.target, meta: l.meta_json ? JSON.parse(l.meta_json) : null,
        ip: l.ip, at: l.created_at, email: maskEmail(l.email),
      })),
    };
  });

  app.post('/api/admin/backup', admin, async (req, reply) => {
    try {
      const { createBackup } = await import('../lib/backup.js');
      const r = await createBackup();
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get('/api/admin/backups', admin, async () => {
    const dir = config.backupDir;
    if (!fs.existsSync(dir)) return { backups: [] };
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.db') || f.endsWith('.db.gz'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, bytes: st.size, createdAt: st.mtimeMs };
      })
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
    return { backups: files };
  });

  app.post('/api/admin/maintenance/vacuum', admin, async () => {
    const { getDb } = await import('../db/index.js');
    getDb().exec('VACUUM;');
    return { ok: true };
  });

  app.post('/api/admin/maintenance/cleanup', admin, async () => {
    const now = Date.now();
    const stale = run('DELETE FROM sessions WHERE expires_at < ?', [now]).changes;
    const tokens = run('DELETE FROM auth_tokens WHERE expires_at < ?', [now - 7 * 86400_000]).changes;
    const oldAudit = run('DELETE FROM audit_logs WHERE created_at < ?', [now - config.auditLogDays * 86400_000]).changes;
    const oldJobs = run("DELETE FROM jobs WHERE status IN ('done','failed','canceled') AND created_at < ?",
      [now - 30 * 86400_000]).changes;
    return { ok: true, staleSessions: stale, expiredTokens: tokens, oldAuditLogs: oldAudit, oldJobs };
  });
}

function checkIntegrity() {
  try {
    const row = get('PRAGMA integrity_check');
    const v = row ? Object.values(row)[0] : null;
    return v === 'ok' ? 'ok' : String(v || 'unknown');
  } catch (e) {
    return `error: ${e.message}`;
  }
}

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = String(e).split('@');
  if (!d) return '***';
  return `${u.slice(0, 2)}***@${d}`;
}

const SENSITIVE = /(api[_-]?key|authorization|password|secret|token|xi-api-key|bearer)/i;
function sanitizeLog(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) { out[k] = '[REDACTED]'; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeLog(v);
    } else out[k] = v;
  }
  return out;
}
