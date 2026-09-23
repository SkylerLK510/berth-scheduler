// Tiny fetch wrapper for the client components. Every API error comes back as
// { errors: string[] } (plus `problems` for reservation conflicts), so surface
// that consistently instead of a generic "request failed".

import type { Problem } from "./types";

export class ApiError extends Error {
  status: number;
  errors: string[];
  problems: Problem[];

  constructor(status: number, errors: string[], problems: Problem[] = []) {
    super(errors.join(" "));
    this.status = status;
    this.errors = errors;
    this.problems = problems;
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json: body, ...rest } = init ?? {};
  const response = await fetch(url, {
    ...rest,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : rest.body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    // A write refused for lack of a session: let the UI re-check who can edit.
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("berth:session-changed"));
    throw new ApiError(response.status, data?.errors ?? [`Request failed (${response.status})`], data?.problems ?? []);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.errors.join(" ");
  return err instanceof Error ? err.message : String(err);
}
