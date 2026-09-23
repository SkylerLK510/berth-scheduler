import { NextResponse } from "next/server";
import { handle, json, readJson } from "@/lib/api";
import {
  attemptLogin,
  authMode,
  createSession,
  deleteSession,
  isDispatcher,
  MAX_PASSCODE,
  notConfigured,
  originAllowed,
  readCookie,
  SESSION_HOURS,
  sessionCookieName,
  sessionCookieOptions,
  wrongOrigin,
} from "@/lib/auth";

/** Every answer here depends on the visitor's cookie, so no cache may keep or share it. */
function privately<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  const handler = handle(fn);
  return async (...args: T) => {
    const response = await handler(...args);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}

/**
 * GET /api/session: what the current visitor can do. Never reveals configuration details.
 *   editing: "dispatcher" (signed in), "viewer" (read-only), "open" (local development
 *   without sign-in), or "off" (sign-in isn't configured, so nobody can edit).
 */
export const GET = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return json({ editing: "off" });
  if (mode.kind === "dev-open") return json({ editing: "open" });
  return json({ editing: (await isDispatcher(request, mode)) ? "dispatcher" : "viewer" });
});

/** POST /api/session { passcode }: sign in as the dispatcher. */
export const POST = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return notConfigured(mode);
  if (!originAllowed(request, mode)) return wrongOrigin();
  if (mode.kind === "dev-open") return json({ editing: "open" });

  const body = await readJson(request);
  const passcode = body && typeof body === "object" && typeof (body as { passcode?: unknown }).passcode === "string" ? (body as { passcode: string }).passcode : "";
  if (!passcode || passcode.length > MAX_PASSCODE) return json({ errors: ["Enter the dispatcher passcode."] }, 400);

  const result = await attemptLogin(mode, passcode);
  if (!result.ok && result.status === 429) {
    const minutes = Math.ceil(result.retryAfterSeconds / 60);
    const response = json({ errors: [`Too many wrong passcodes. Sign-in is paused for about ${minutes} minute${minutes === 1 ? "" : "s"}.`] }, 429);
    response.headers.set("Retry-After", String(result.retryAfterSeconds));
    return response;
  }
  if (!result.ok) return json({ errors: ["That passcode isn't right."] }, 401);

  // Replace any session this browser already had, so an old token can't linger.
  await deleteSession(readCookie(request, sessionCookieName(mode)));
  const token = await createSession(mode);
  const response = NextResponse.json({ editing: "dispatcher" });
  response.cookies.set(sessionCookieName(mode), token, sessionCookieOptions(mode, SESSION_HOURS * 3600));
  return response;
});

/** DELETE /api/session: sign out. Deletes the session on the server, not just the cookie. */
export const DELETE = privately(async (request: Request) => {
  const mode = authMode();
  if (!originAllowed(request, mode)) return wrongOrigin();
  if (mode.kind === "enforced") await deleteSession(readCookie(request, sessionCookieName(mode)));
  const response = NextResponse.json({ editing: mode.kind === "dev-open" ? "open" : "viewer" });
  response.cookies.set(sessionCookieName(mode), "", sessionCookieOptions(mode, 0));
  return response;
});
