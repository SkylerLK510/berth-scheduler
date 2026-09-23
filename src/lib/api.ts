// Small helpers shared by the route handlers.

import { NextResponse } from "next/server";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function badRequest(errors: string[] | string) {
  return json({ errors: Array.isArray(errors) ? errors : [errors] }, 400);
}

export function notFound(what = "Not found") {
  return json({ errors: [what] }, 404);
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Route params arrive as strings; "12" -> 12, anything else -> null. */
export function parseId(raw: string | null | undefined): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : null;
}

/** A deliberate refusal with a status and a message that is safe to show the user. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * Wrap a handler so an HttpError becomes its status and message, and anything unexpected
 * becomes a JSON 500 instead of an HTML error page.
 * The full error goes to the server log. The public deployment only says something went
 * wrong, so database and driver messages aren't handed to anyone who calls the API.
 */
export function handle<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        const response = json({ errors: [err.message] }, err.status);
        if (err.retryAfterSeconds) response.headers.set("Retry-After", String(err.retryAfterSeconds));
        return response;
      }
      console.error(err);
      const detail = err instanceof Error ? err.message : "Unexpected error";
      const message = process.env.NODE_ENV === "production" ? "Something went wrong on the server. Try again, and check the server log if it keeps happening." : detail;
      return json({ errors: [message] }, 500);
    }
  };
}
