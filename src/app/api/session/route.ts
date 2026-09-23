import { NextResponse } from "next/server";
import { json } from "@/lib/api";
import { body, privately, withSession } from "@/lib/account-routes";
import { signIn } from "@/lib/accounts";
import { authMode, currentUser, deleteSession, notConfigured, originAllowed, readCookie, sessionCookieName, sessionCookieOptions, wrongOrigin } from "@/lib/auth";

/**
 * GET /api/session: what the current visitor can do. Never reveals configuration details.
 *   editing: "user" (signed in; see `user` for name and role), "viewer" (can sign in),
 *   "open" (local development without sign-in), or "off" (sign-in isn't configured).
 */
export const GET = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return json({ editing: "off" });
  if (mode.kind === "dev-open") return json({ editing: "open" });
  const user = await currentUser(request, mode);
  return json(user ? { editing: "user", user: { name: user.name, email: user.email, role: user.role } } : { editing: "viewer" });
});

/** POST /api/session { email, password }: sign in. */
export const POST = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return notConfigured(mode);
  if (!originAllowed(request, mode)) return wrongOrigin();
  if (mode.kind === "dev-open") return json({ editing: "open" });

  const { email, password } = await body(request);
  const user = await signIn(email, password);
  // Replace any session this browser already had, so an old token can't linger.
  await deleteSession(readCookie(request, sessionCookieName(mode)));
  return withSession({ editing: "user", user: { name: user.name, email: user.email, role: user.role } }, user.sessionToken);
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
