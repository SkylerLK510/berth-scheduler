import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { attemptLogin, authMode, LOGIN_LIMIT, LOGIN_WINDOW_MS } from "../auth";
import { db, resetDbForTests } from "../db";

it("concurrent login failures cannot bypass the shared limit or extend its current window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-login-concurrency-"));
  try {
    resetDbForTests(`file:${join(dir, "test.db")}`);
    const mode = authMode({
      NODE_ENV: "production", DISPATCHER_PASSCODE: "test-only-passcode-for-concurrency",
      SESSION_SECRET: "test-only-session-secret-for-concurrency-1234",
      APP_ORIGIN: "https://example.test",
    });
    if (mode.kind !== "enforced") throw new Error("Test configuration rejected");
    await db();
    const now = Date.now();
    const responses = await Promise.all(Array.from({ length: LOGIN_LIMIT + 4 }, () => attemptLogin(mode, "wrong", now)));
    expect(responses.filter((r) => !r.ok && r.status === 401)).toHaveLength(LOGIN_LIMIT);
    expect(responses.filter((r) => !r.ok && r.status === 429)).toHaveLength(4);
    const late = await attemptLogin(mode, "wrong", now + LOGIN_WINDOW_MS - 1000);
    expect(late).toEqual({ ok: false, status: 429, retryAfterSeconds: 1 });
    expect(await attemptLogin(mode, mode.passcode, now + LOGIN_WINDOW_MS)).toEqual({ ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
