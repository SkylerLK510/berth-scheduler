// Dispatcher sign-in. Anyone can read the schedule; changing anything (bookings, berths,
// vessels, notes, imports) needs a dispatcher session. This decides who may write. It
// doesn't replace the double-booking checks: those still run inside the save transaction,
// so two signed-in dispatchers saving at once are protected the same way as before.
//
// Configuration (server-side environment variables, never in the repo or the browser):
//   DISPATCHER_PASSCODE  the shared dispatcher passcode, at least 12 characters
//   SESSION_SECRET       random string of at least 32 characters; keys the passcode check,
//                        and changing it signs everyone out
//   APP_ORIGIN           the site's exact origin, e.g. https://berth-scheduler.vercel.app
//                        (comma-separated for several). Required in production.
//   DEV_OPEN_WRITES=1    development only: skip sign-in locally. Ignored in production.
//
// Missing or weak configuration fails closed: writes and sign-in are refused.
//
// A shared passcode says "a dispatcher did this", not which one. Personal accounts, roles
// and an audit log are the production follow-up (see the README).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { handle, json } from "./api";
import { db, withWriteTransaction } from "./db";

export const SESSION_HOURS = 12;
const MIN_PASSCODE = 12;
/** Sign-in attempts longer than this are rejected, so the configured passcode must fit too. */
export const MAX_PASSCODE = 200;
const MIN_SECRET = 32;

/** Failed sign-ins allowed per window, counted in the database so every server instance shares them. */
export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

type Env = Record<string, string | undefined>;

export type AuthMode =
  | { kind: "enforced"; passcode: string; secret: string; origins: string[]; production: boolean }
  | { kind: "dev-open"; origins: string[] }
  | { kind: "misconfigured"; problems: string[] };

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

/** Reads the configuration each time, so tests (and a redeploy with new values) take effect at once. */
export function authMode(env: Env = process.env): AuthMode {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];
  const origins = parseOrigins(env.APP_ORIGIN, production, problems);

  if (env.NODE_ENV === "development" && env.DEV_OPEN_WRITES === "1") {
    return problems.length ? { kind: "misconfigured", problems } : { kind: "dev-open", origins };
  }

  const passcode = env.DISPATCHER_PASSCODE ?? "";
  const secret = env.SESSION_SECRET ?? "";
  if (passcode.length < MIN_PASSCODE || passcode.length > MAX_PASSCODE) {
    problems.push(`DISPATCHER_PASSCODE must be set, and between ${MIN_PASSCODE} and ${MAX_PASSCODE} characters.`);
  }
  if (secret.length < MIN_SECRET) problems.push(`SESSION_SECRET must be set and at least ${MIN_SECRET} characters.`);
  if (secret && passcode && secret === passcode) problems.push("SESSION_SECRET must be different from DISPATCHER_PASSCODE.");
  if (production && origins.length === 0) problems.push("APP_ORIGIN must be set in production.");
  if (problems.length) return { kind: "misconfigured", problems };
  return { kind: "enforced", passcode, secret, origins, production };
}

// ---- sessions ----------------------------------------------------------------------
//
// A session is a random token. The browser keeps the token in an HttpOnly cookie; the
// database keeps only its SHA-256 hash, with an expiry and the passcode version it was
// issued under. So signing out deletes the session on the server (a copied cookie stops
// working), sessions expire server-side, and changing the passcode or secret invalidates
// every existing session.

const b64url = (buf: Buffer) => buf.toString("base64url");
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Changes whenever the passcode (or the secret) changes. Sessions from an older version are invalid. */
function passcodeVersion(mode: Extract<AuthMode, { kind: "enforced" }>): string {
  return b64url(hmac(mode.secret, `passcode-version:${mode.passcode}`)).slice(0, 22);
}

/** Timing-safe: both sides are hashed to the same length before comparing. */
export function passcodeMatches(mode: Extract<AuthMode, { kind: "enforced" }>, attempt: string): boolean {
  return sameBytes(hmac(mode.secret, `passcode:${attempt}`), hmac(mode.secret, `passcode:${mode.passcode}`));
}

/** Creates a session and returns the token for the cookie. Also clears out expired and outdated sessions. */
export async function createSession(mode: Extract<AuthMode, { kind: "enforced" }>, now = Date.now()): Promise<string> {
  const token = b64url(randomBytes(32));
  const version = passcodeVersion(mode);
  await (await db()).batch(
    [
      { sql: "DELETE FROM sessions WHERE expires_at <= ? OR passcode_version <> ?", args: [now, version] },
      {
        sql: "INSERT INTO sessions (token_hash, passcode_version, created_at, expires_at) VALUES (?, ?, ?, ?)",
        args: [hashToken(token), version, now, now + SESSION_HOURS * 3600 * 1000],
      },
    ],
    "write",
  );
  return token;
}

/** True only for a token whose hash is stored, unexpired, and issued under the current passcode. */
export async function sessionValid(mode: Extract<AuthMode, { kind: "enforced" }>, token: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const rs = await (await db()).execute({
    sql: "SELECT 1 FROM sessions WHERE token_hash = ? AND passcode_version = ? AND expires_at > ?",
    args: [hashToken(token), passcodeVersion(mode), now],
  });
  return rs.rows.length > 0;
}

export async function deleteSession(token: string | null | undefined): Promise<void> {
  if (!token || token.length > 200) return;
  await (await db()).execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [hashToken(token)] });
}

// ---- cookies and origin -----------------------------------------------------------

/** `__Host-` makes the browser insist on Secure, Path=/ and no Domain, so only this site gets it. */
export function sessionCookieName(mode: AuthMode): string {
  return mode.kind === "enforced" && mode.production ? "__Host-berth_dispatcher" : "berth_dispatcher";
}

export function sessionCookieOptions(mode: AuthMode, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: mode.kind === "enforced" && mode.production,
    sameSite: "strict" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Writes must come from the app's own pages. The browser's Origin header is compared with
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

export async function isDispatcher(request: Request, mode: AuthMode = authMode()): Promise<boolean> {
  if (mode.kind === "dev-open") return true;
  if (mode.kind !== "enforced") return false;
  return sessionValid(mode, readCookie(request, sessionCookieName(mode)));
}

let warnedMisconfigured = false;
export function notConfigured(mode: Extract<AuthMode, { kind: "misconfigured" }>): Response {
  if (!warnedMisconfigured) {
    console.error(`Dispatcher sign-in is not configured, so all changes are refused:\n  ${mode.problems.join("\n  ")}`);
    warnedMisconfigured = true;
  }
  // The details stay in the server log; the public only learns that editing is off.
  return json({ errors: ["Editing is switched off because dispatcher sign-in isn't configured on this server."] }, 503);
}

export const wrongOrigin = () => json({ errors: ["This change didn't come from the app's own pages, so it was refused."] }, 403);

/** null when the request may write; otherwise the response that refuses it. */
export async function writeGuard(request: Request): Promise<Response | null> {
  const mode = authMode();
  if (mode.kind === "misconfigured") return notConfigured(mode);
  if (!originAllowed(request, mode)) return wrongOrigin();
  if (!(await isDispatcher(request, mode))) return json({ errors: ["Sign in as the dispatcher to make changes."] }, 401);
  return null;
}

/** Route wrapper for anything that changes data. Every write route must use it (a test checks). */
export function dispatcherOnly<T extends unknown[]>(fn: (request: Request, ...rest: T) => Promise<Response>) {
  return handle(async (request: Request, ...rest: T) => (await writeGuard(request)) ?? fn(request, ...rest));
}

// ---- sign-in throttle -----------------------------------------------------------

export type LoginResult = { ok: true } | { ok: false; status: 401 } | { ok: false; status: 429; retryAfterSeconds: number };

/**
 * Checks a passcode with a limit on wrong guesses: after LOGIN_LIMIT failures in a
 * LOGIN_WINDOW_MS window, every attempt (even a correct one) is refused until that window
 * ends. The count lives in the database, inside a write transaction, so it holds across
 * serverless instances and concurrent requests.
 *
 * It is one shared counter for all clients, which is simple and can't be dodged by
 * changing IP. The honest trade-off for this demo: each lockout lasts at most one window,
 * but someone who keeps guessing can keep re-triggering it and hold the dispatcher out
 * for as long as they continue. Per-client limits (which need a trusted client IP) or
 * personal accounts are the production fix.
 */
export async function attemptLogin(mode: Extract<AuthMode, { kind: "enforced" }>, attempt: string, now = Date.now()): Promise<LoginResult> {
  return withWriteTransaction<LoginResult>(async (tx) => {
    const row = (await tx.execute("SELECT window_start, failures FROM login_throttle WHERE id = 1")).rows[0];
    let windowStart = row ? Number(row.window_start) : now;
    let failures = row ? Number(row.failures) : 0;
    if (now - windowStart >= LOGIN_WINDOW_MS) {
      windowStart = now;
      failures = 0;
    }
    if (failures >= LOGIN_LIMIT) {
      return { commit: false, value: { ok: false, status: 429, retryAfterSeconds: Math.ceil((windowStart + LOGIN_WINDOW_MS - now) / 1000) } };
    }
    if (passcodeMatches(mode, attempt)) return { commit: false, value: { ok: true } };
    await tx.execute({
      sql: `INSERT INTO login_throttle (id, window_start, failures) VALUES (1, ?, ?)
            ON CONFLICT (id) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures`,
      args: [windowStart, failures + 1],
    });
    return { commit: true, value: { ok: false, status: 401 } };
  });
}
