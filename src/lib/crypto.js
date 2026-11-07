import crypto from 'node:crypto';
import { masterKeyBytes } from '../config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await new Promise((res, rej) =>
    crypto.scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024 },
      (e, k) => (e ? rej(e) : res(k)))
  );
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await new Promise((res, rej) =>
      crypto.scrypt(password.normalize('NFKC'), salt, expected.length, { N: +N, r: +r, p: +p, maxmem: 128 * 1024 * 1024 },
        (e, k) => (e ? rej(e) : res(k)))
    );
    return crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

const AAD = Buffer.from('echopersona:v1');

/** AES-256-GCM encrypt. Returns base64 string: iv.tag.ciphertext */
export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const key = masterKeyBytes();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed ciphertext');
  const key = masterKeyBytes();
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
}

export function maskSecret(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 8) return '•'.repeat(Math.max(4, s.length));
  return `${s.slice(0, 3)}${'•'.repeat(Math.min(12, s.length - 7))}${s.slice(-4)}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function constantTimeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
