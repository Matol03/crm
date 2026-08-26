/**
 * Password hashing and verification.
 *
 * Uses scrypt from Node's built-in crypto — a deliberately slow, memory-hard
 * function, so a stolen database cannot be brute-forced at speed. No external
 * dependency is introduced (the service has none at runtime by design).
 *
 * Rules enforced here:
 *   - a plaintext password is never stored, logged, or returned
 *   - every user gets a unique random salt, so identical passwords produce
 *     different hashes and one cracked password reveals nothing about others
 *   - comparison is timing-safe, so response time cannot be used to guess
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/** Cost parameters. N=16384 keeps a single verification around 50–100 ms. */
const KEYLEN = 64;
const SCRYPT_N = 16_384;
const SALT_BYTES = 16;

export interface PasswordRecord {
  hash: string;
  salt: string;
}

export function hashPassword(plain: string): PasswordRecord {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(plain, salt, KEYLEN, { N: SCRYPT_N }).toString('hex');
  return { hash, salt };
}

/**
 * Verify a password. Returns false for any malformed record rather than
 * throwing, so a corrupt row denies access instead of crashing the endpoint.
 */
export function verifyPassword(plain: string, record: PasswordRecord): boolean {
  if (!record.hash || !record.salt) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(plain, record.salt, KEYLEN, { N: SCRYPT_N });
  } catch {
    return false;
  }
  const stored = Buffer.from(record.hash, 'hex');
  // timingSafeEqual throws on length mismatch, which would itself leak a bit.
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}

/** A new opaque session token. Returned once; only its hash is persisted. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a session token for storage. A fast hash is correct here (unlike for
 * passwords): the token already has 256 bits of entropy, so there is nothing
 * to brute-force, and login checks should not be slowed down.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Minimum policy for a new password. Returns null when acceptable. */
export function passwordProblem(plain: string): string | null {
  if (plain.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-z]/i.test(plain)) return 'Password must contain a letter.';
  if (!/[0-9]/.test(plain)) return 'Password must contain a digit.';
  return null;
}
