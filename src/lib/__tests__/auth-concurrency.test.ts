// Parallel wrong guesses can't get past the per-account limit, because each attempt reserves
// its slot in a write transaction before the (slow) password check runs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AccountError, bootstrapAdmin, signIn } from "../accounts";
import { authMode, LIMITS, LOGIN_WINDOW_MS } from "../auth";
import { resetDbForTests } from "../db";

it("concurrent wrong passwords for one account get exactly the allowed number of tries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-login-concurrency-"));
  try {
    resetDbForTests(`file:${join(dir, "test.db")}`);
    const token = "test-only-setup-token-0123456789abcdef";
    const mode = authMode({ NODE_ENV: "production", APP_ORIGIN: "https://example.test", BOOTSTRAP_ADMIN_EMAIL: "admin@example.test", BOOTSTRAP_TOKEN: token });
    await bootstrapAdmin(mode, { token, email: "admin@example.test", name: "Admin", password: "the right password" });

    const now = Date.now();
    const statuses = await Promise.all(
      Array.from({ length: LIMITS.email + 4 }, (_, i) =>
        signIn("admin@example.test", `wrong ${i}`, now).then(
          () => 200,
          (err) => (err instanceof AccountError ? err.status : 500),
        ),
      ),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(LIMITS.email);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    await expect(signIn("admin@example.test", "the right password", now + LOGIN_WINDOW_MS)).resolves.toMatchObject({ role: "admin" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
