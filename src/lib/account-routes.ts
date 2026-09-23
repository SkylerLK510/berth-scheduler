// Shared bits for the sign-in, setup, invitation and people routes.

import { NextResponse } from "next/server";
import { handle, readJson } from "./api";
import { authMode, SESSION_HOURS, sessionCookieName, sessionCookieOptions } from "./auth";

/** Every answer from these routes depends on who is asking, so no cache may keep or share it. */
export function privately<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  const handler = handle(fn);
  return async (...args: T) => {
    const response = await handler(...args);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}

/** The request body as an object (empty when it isn't one). */
export async function body(request: Request): Promise<Record<string, unknown>> {
  const data = await readJson(request);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** A JSON response that also signs the browser in with `token`. */
export function withSession(data: unknown, token: string, status = 200) {
  const mode = authMode();
  const response = NextResponse.json(data, { status });
  response.cookies.set(sessionCookieName(mode), token, sessionCookieOptions(mode, SESSION_HOURS * 3600));
  return response;
}
