import crypto from 'node:crypto';

/**
 * Password hashing with scrypt from Node's own crypto module — no third-party
 * dependency, and the parameters are stored alongside the hash so they can be
 * raised later without invalidating existing passwords.
 */

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 128 * SCRYPT_N * SCRYPT_r * 2,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4] as string, 'base64');
    const expected = Buffer.from(parts[5] as string, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Rejects the handful of passwords that would otherwise end up on every
 * install. Deliberately light — this is a LAN system used by hotel staff, not
 * an internet-facing service.
 */
const WEAK = new Set(['password', '12345678', 'admin123', 'hotel123', 'qwerty123', '11111111']);

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (WEAK.has(password.toLowerCase())) return 'That password is too easy to guess. Please pick another.';
  return null;
}
