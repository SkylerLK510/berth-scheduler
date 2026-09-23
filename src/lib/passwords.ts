// Password hashing with scrypt from Node's standard library (no extra dependency).
// Stored as "scrypt$N$r$p$salt$hash" so the cost can be raised later without breaking
// existing hashes: verification reads the parameters from the stored string.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;

// OWASP Password Storage Cheat Sheet: scrypt with N=2^17, r=8, p=1. Uses about 128 MB for
// a fraction of a second per hash, which is why hashing never happens inside a database lock.
const N = 131072;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
/** Upper bound on the parameters we'll accept from a stored hash, so a bad row can't exhaust memory. */
const MAX_N = 1 << 20;
const MAX_MEM = 256 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** A human-readable reason the password can't be used, or null when it's fine. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > MAX_PASSWORD) return false;
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  const [cost, block, parallel] = [Number(n), Number(r), Number(p)];
  if (scheme !== "scrypt" || !salt || !hash || !(cost > 1 && cost <= MAX_N) || !(block >= 1 && block <= 32) || !(parallel >= 1 && parallel <= 16)) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), cost, block, parallel);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Checked against when the email doesn't match any account, so a wrong email takes as long
 * as a wrong password and response times don't reveal which accounts exist.
 */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(KEY_LENGTH).toString("base64url")}`;
