import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';

export const token = () => randomBytes(32).toString('hex');
export const equal = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
export function signature(raw, secret, encoding = 'hex') { return createHmac('sha256', secret).update(raw).digest(encoding); }
export function verifyMeta(raw, header, secret) { return equal(header, `sha256=${signature(raw, secret)}`); }
export function verifyWoo(raw, header, secret) { return equal(header, signature(raw, secret, 'base64')); }
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('Password must contain 12–200 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const [salt, expected] = hash.split(':');
  return equal(scryptSync(password, salt, 64).toString('hex'), expected);
}
export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function assert(condition, code, message, status = 400) { if (!condition) throw new AppError(code, message, status); }
export function normalizeWa(value) {
  const wa = String(value || '').replace(/^\+/, '');
  assert(/^\d{8,15}$/.test(wa), 'INVALID_PHONE', 'Invalid WhatsApp number');
  return wa;
}
export function text(value, name, max = 200) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', `${name} is required (maximum ${max} characters)`);
  return value.trim();
}
