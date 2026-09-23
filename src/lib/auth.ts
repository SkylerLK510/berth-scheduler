// Who may change things. Anyone can read the schedule; changes need a signed-in person:
// a dispatcher (bookings, berths, vessels, notes, imports) or an admin (all of that, plus
// inviting and managing people). Accounts live in accounts.ts; this file holds the
// configuration, sessions, the same-site check, the route guards and the guess limits.
//
// Signing in decides who may write. It doesn't replace the double-booking checks: those still
// run inside the save transaction, so two people saving at once are protected as before.
//
// Configuration (server-side environment variables, never in the repo or the browser):
//   APP_ORIGIN             the site's exact origin, e.g. https://berth-scheduler-sigma.vercel.app
//                          (comma-separated for several). Required in production, https only.
//   BOOTSTRAP_ADMIN_EMAIL  with BOOTSTRAP_TOKEN: lets the operator create the first admin once,
//   BOOTSTRAP_TOKEN        at /setup. At least 32 characters. Remove both after setup.
//   DEV_OPEN_WRITES=1      development only: skip sign-in locally. Ignored in production.
//
// DISPATCHER_PASSCODE and SESSION_SECRET from the shared-passcode version are ignored.
// Missing or invalid configuration fails closed: every change and every sign-in is refused.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { handle, json } from "./api";
import { db } from "./db";

export const SESSION_HOURS = 12;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Wrong guesses allowed per window, per bucket. Counted in the database, shared by every server instance. */
export const LIMITS = { email: 5, global: 100, setup: 10 } as const;
const MIN_BOOTSTRAP_TOKEN = 32;

type Env = Record<string, string | undefined>;

export type Role = "admin" | "dispatcher";
export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export type AuthMode =
  | { kind: "enforced"; origins: string[]; production: boolean; bootstrap: { email: string; token: string } | null }
  | { kind: "dev-open"; origins: string[] }
  | { kind: "misconfigured"; problems: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (raw: unknown) => (typeof raw === "string" ? raw.trim().toLowerCase() : "");
export const isEmail = (email: string) => email.length <= 254 && EMAIL.test(email);

function parseOrigins(raw: string | undefined, production: boolean, problems: string[]): string[] {
  const origins = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of origins) {
    let url: URL | null = null;
    try {
      url = new URL(o);
    } catch {}
    // Only real web origins: http(s), exactly scheme://host[:port], and https in production.
    const exact = url != null && (url.protocol === "https:" || url.protocol === "http:") && url.origin === o;
    if (!exact) problems.push(`APP_ORIGIN "${o}" isn't an exact http(s) origin like https://example.com (no path or trailing slash).`);
    else if (production && url!.protocol !== "https:") problems.push(`APP_ORIGIN "${o}" must use https in production.`);
  }
  return origins;
}

let warnedBootstrap = false;
function parseBootstrap(env: Env): { email: string; token: string } | null {
  const email = normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  const token = env.BOOTSTRAP_TOKEN ?? "";
  if (!email && !token) return null;
  const problems = [];
  if (!isEmail(email)) problems.push("BOOTSTRAP_ADMIN_EMAIL must be an email address.");
  if (token.length < MIN_BOOTSTRAP_TOKEN || token.length > 200) problems.push(`BOOTSTRAP_TOKEN must be ${MIN_BOOTSTRAP_TOKEN} to 200 characters.`);
  if (problems.length) {
    if (!warnedBootstrap) console.error(`First-admin setup is off:\n  ${problems.join("\n  ")}`);
    warnedBootstrap = true;
    return null;
  }
  return { email, token };
}

/** Reads the configuration each time, so tests (and a redeploy with new values) take effect at once. */
export function authMode(env: Env = process.env): AuthMode {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];
  const origins = parseOrigins(env.APP_ORIGIN, production, problems);
  if (env.NODE_ENV === "development" && env.DEV_OPEN_WRITES === "1") {
    return problems.length ? { kind: "misconfigured", problems } : { kind: "dev-open", origins };
  }
  if (production && origins.length === 0) problems.push("APP_ORIGIN must be set in production.");
  if (problems.length) return { kind: "misconfigured", problems };
  return { kind: "enforced", origins, production, bootstrap: parseBootstrap(env) };
}

// ---- sessions ----------------------------------------------------------------------
//
// A session is a random token. The browser keeps it in an HttpOnly cookie; the database keeps
// only its SHA-256 hash, the user, and an expiry. Every request re-reads the user, so
// disabling someone or changing their role takes effect at once, and signing out deletes the
// session on the server (a copied cookie stops working).

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export async function createSession(userId: number, conn?: Transaction, now = Date.now()): Promise<string> {
  const token = newToken();
  const c = conn ?? (await db());
  await c.execute({ sql: "DELETE FROM user_sessions WHERE expires_at <= ?", args: [now] });
  await c.execute({
    sql: "INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    args: [hashToken(token), userId, now, now + SESSION_HOURS * 3600 * 1000],
  });
  return token;
}

/** The active user behind a session token, or null for a missing, expired, revoked or disabled one. */
export async function sessionUser(token: string | null | undefined, now = Date.now()): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const rs = await (await db()).execute({
    sql: `SELECT u.id, u.email, u.name, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
    args: [hashToken(token), now],
  });
  const row = rs.rows[0];
  return row ? { id: Number(row.id), email: String(row.email), name: String(row.name), role: row.role as Role } : null;
}

export async function deleteSession(token: string | null | undefined): Promise<void> {
  if (!token || token.length > 200) return;
  await (await db()).execute({ sql: "DELETE FROM user_sessions WHERE token_hash = ?", args: [hashToken(token)] });
}

// ---- cookies and origin -------------------------------------------------------------

/** `__Host-` makes the browser insist on Secure, Path=/ and no Domain, so only this site gets it. */
export function sessionCookieName(mode: AuthMode): string {
  return mode.kind === "enforced" && mode.production ? "__Host-berth_session" : "berth_session";
}

export function sessionCookieOptions(mode: AuthMode, maxAgeSeconds: number) {
  return { httpOnly: true, secure: mode.kind === "enforced" && mode.production, sameSite: "strict" as const, path: "/", maxAge: maxAgeSeconds };
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Changes must come from the app's own pages. The browser's Origin header is compared with
 * APP_ORIGIN exactly. Outside production, when APP_ORIGIN isn't set, it falls back to the
 * request's own URL (built from headers the client controls, so never in production).
 */
export function originAllowed(request: Request, mode: AuthMode): boolean {
  if (mode.kind === "misconfigured") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const trusted = mode.origins.length ? mode.origins : [new URL(request.url).origin];
  return trusted.includes(origin);
}

/** The signed-in user for this request (never in dev-open mode, which has no users). */
export async function currentUser(request: Request, mode: AuthMode = authMode()): Promise<SessionUser | null> {
  if (mode.kind !== "enforced") return null;
  return sessionUser(readCookie(request, sessionCookieName(mode)));
}

let warnedMisconfigured = false;
export function notConfigured(mode: Extract<AuthMode, { kind: "misconfigured" }>): Response {
  if (!warnedMisconfigured) {
    console.error(`Sign-in is not configured, so all changes are refused:\n  ${mode.problems.join("\n  ")}`);
    warnedMisconfigured = true;
  }
  // The details stay in the server log; the public only learns that editing is off.
  return json({ errors: ["Editing is switched off because sign-in isn't configured on this server."] }, 503);
}

export const wrongOrigin = () => json({ errors: ["This change didn't come from the app's own pages, so it was refused."] }, 403);

/** Who is acting: a signed-in user, or `null` for local development with DEV_OPEN_WRITES. */
export type Actor = SessionUser | null;

/** The acting user when the request may write with at least `role`; otherwise the refusal. */
export async function guard(request: Request, role: Role): Promise<{ actor: Actor } | { refused: Response }> {
  const mode = authMode();
  if (mode.kind === "misconfigured") return { refused: notConfigured(mode) };
  // Browsers normally omit Origin on same-origin GET/HEAD requests. Those methods
  // only read; they still require a valid session and role. Every mutation retains
  // the exact-origin check, and an explicitly foreign Origin is refused on reads.
  const readsOnly = request.method === "GET" || request.method === "HEAD";
  if ((!readsOnly || request.headers.has("origin")) && !originAllowed(request, mode)) return { refused: wrongOrigin() };
  if (mode.kind === "dev-open") return { actor: null };
  const user = await currentUser(request, mode);
  if (!user) return { refused: json({ errors: ["Sign in to make changes."] }, 401) };
  if (role === "admin" && user.role !== "admin") return { refused: json({ errors: ["Only an admin can do that."] }, 403) };
  return { actor: user };
}

/** Route wrapper for anything that changes schedule data. Every write route must use a wrapper (a test checks). */
export function dispatcherOnly<T extends unknown[]>(fn: (request: Request, ...rest: T) => Promise<Response>) {
  return handle(async (request: Request, ...rest: T) => {
    const g = await guard(request, "dispatcher");
    return "refused" in g ? g.refused : fn(request, ...rest);
  });
}

/** Route wrapper for managing people. The handler gets the acting admin (null only in dev-open). */
export function adminOnly<T extends unknown[]>(fn: (actor: Actor, request: Request, ...rest: T) => Promise<Response>) {
  return handle(async (request: Request, ...rest: T) => {
    const g = await guard(request, "admin");
    return "refused" in g ? g.refused : fn(g.actor, request, ...rest);
  });
}

// ---- guess limits -----------------------------------------------------------------------
//
// Each attempt reserves a slot in its buckets *before* the password or token is checked, in
// one write transaction, so parallel guesses can't slip past the limit. A successful attempt
// hands its slots back. Password hashing happens outside the transaction, so a slow hash
// never holds the database's write lock.
//
// Buckets: "email:<address>" (5 per 15 minutes) slows guessing at one account; "global"
// (100 per 15 minutes) caps guessing across all accounts; "setup" (10) guards /setup. A lockout
// lasts at most one window, but someone who keeps guessing can keep re-triggering it for an
// account while they continue: the honest trade-off without trusted client IPs.

export type Reservation = { ok: true; buckets: string[] } | { ok: false; retryAfterSeconds: number };

export async function reserveAttempt(tx: Transaction, buckets: { bucket: string; limit: number }[], now = Date.now()): Promise<Reservation> {
  const rows = [];
  let retryAfter = 0;
  for (const { bucket, limit } of buckets) {
    const row = (await tx.execute({ sql: "SELECT window_start, failures FROM login_attempts WHERE bucket = ?", args: [bucket] })).rows[0];
    let windowStart = row ? Number(row.window_start) : now;
    let failures = row ? Number(row.failures) : 0;
    if (now - windowStart >= LOGIN_WINDOW_MS) {
      windowStart = now;
      failures = 0;
    }
    if (failures >= limit) retryAfter = Math.max(retryAfter, Math.ceil((windowStart + LOGIN_WINDOW_MS - now) / 1000));
    rows.push({ bucket, windowStart, failures });
  }
  if (retryAfter > 0) return { ok: false, retryAfterSeconds: retryAfter };
  for (const r of rows) {
    await tx.execute({
      sql: `INSERT INTO login_attempts (bucket, window_start, failures) VALUES (?, ?, ?)
            ON CONFLICT (bucket) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures`,
      args: [r.bucket, r.windowStart, r.failures + 1],
    });
  }
  return { ok: true, buckets: rows.map((r) => r.bucket) };
}

/** Give back the slots of an attempt that turned out to be correct. */
export async function refundAttempt(tx: Transaction, buckets: string[]): Promise<void> {
  for (const bucket of buckets) {
    await tx.execute({ sql: "UPDATE login_attempts SET failures = MAX(failures - 1, 0) WHERE bucket = ?", args: [bucket] });
  }
}

/** Constant-time comparison of two secrets of any length. */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
