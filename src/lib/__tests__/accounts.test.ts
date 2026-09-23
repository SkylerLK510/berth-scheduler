// Personal accounts: first-admin setup, invitations and resets, managing people, sign-in
// limits, and the migration away from the shared passcode. Real SQLite files, real scrypt.

import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { acceptInvite, AccountError, bootstrapAdmin, createInvite, inspectInvite, INVITE_HOURS, listPeople, revokeInvite, signIn, updatePerson } from "../accounts";
import { authMode, LIMITS, sessionUser, type AuthMode, type SessionUser } from "../auth";
import { db, resetDbForTests } from "../db";
import { createBerth, listBerths } from "../repo";

const dir = mkdtempSync(join(tmpdir(), "berth-accounts-"));
let dbCount = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetDbForTests(`file:${join(dir, `accounts-${++dbCount}.db`)}`));

const TOKEN = "operator-setup-token-0123456789abcdef";
const ADMIN = "skyler@example.org";
const PASSWORD = "a long enough password";
const mode = authMode({ NODE_ENV: "test", APP_ORIGIN: "https://berths.example.org", BOOTSTRAP_ADMIN_EMAIL: ADMIN, BOOTSTRAP_TOKEN: TOKEN });

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AccountError) return err.status;
    throw err;
  }
  return 0;
}

async function firstAdmin(): Promise<SessionUser> {
  const token = await bootstrapAdmin(mode, { token: TOKEN, email: ADMIN, name: "Skyler", password: PASSWORD });
  return (await sessionUser(token))!;
}

/** Invite and accept a new person; returns them as a session user. */
async function addPerson(admin: SessionUser, email: string, role: "admin" | "dispatcher"): Promise<SessionUser> {
  const invite = await createInvite(admin, email, role);
  return (await sessionUser(await acceptInvite({ token: invite.token, name: email.split("@")[0], password: PASSWORD })))!;
}

describe("first-admin setup", () => {
  it("needs the operator's token and exact email, and creates an admin once", async () => {
    expect(await refusal(bootstrapAdmin(mode, { token: "wrong-token-0123456789abcdef0123", email: ADMIN, name: "X", password: PASSWORD }))).toBe(401);
    expect(await refusal(bootstrapAdmin(mode, { token: TOKEN, email: "someone.else@example.org", name: "X", password: PASSWORD }))).toBe(401);
    const admin = await firstAdmin();
    expect(admin).toMatchObject({ email: ADMIN, role: "admin", name: "Skyler" });
    expect(await refusal(bootstrapAdmin(mode, { token: TOKEN, email: ADMIN, name: "Again", password: PASSWORD }))).toBe(410);
  });

  it("stays closed even if every admin row disappears (a permanent marker, not a head count)", async () => {
    await firstAdmin();
    await (await db()).execute("DELETE FROM users");
    expect(await refusal(bootstrapAdmin(mode, { token: TOKEN, email: ADMIN, name: "X", password: PASSWORD }))).toBe(410);
  });

  it("is unavailable without operator configuration, so the first visitor can't become admin", async () => {
    const plain: AuthMode = authMode({ NODE_ENV: "test", APP_ORIGIN: "https://berths.example.org" });
    expect(await refusal(bootstrapAdmin(plain, { token: TOKEN, email: ADMIN, name: "X", password: PASSWORD }))).toBe(404);
    // a short token is rejected as configuration, not accepted
    const weak = authMode({ NODE_ENV: "test", APP_ORIGIN: "https://berths.example.org", BOOTSTRAP_ADMIN_EMAIL: ADMIN, BOOTSTRAP_TOKEN: "short" });
    expect(weak.kind === "enforced" && weak.bootstrap).toBe(null);
  });

  it("limits wrong setup tokens", async () => {
    for (let i = 0; i < LIMITS.setup; i++) {
      expect(await refusal(bootstrapAdmin(mode, { token: `wrong-${i}-0123456789abcdef0123456789`, email: ADMIN, name: "X", password: PASSWORD }))).toBe(401);
    }
    expect(await refusal(bootstrapAdmin(mode, { token: TOKEN, email: ADMIN, name: "X", password: PASSWORD }))).toBe(429);
  });
});

describe("invitations", () => {
  it("are single-use, hashed at rest, and create the invited role", async () => {
    const admin = await firstAdmin();
    const invite = await createInvite(admin, "Dana@Example.org", "dispatcher");
    expect(invite).toMatchObject({ email: "dana@example.org", role: "dispatcher", kind: "invite" });
    const stored = (await (await db()).execute("SELECT token_hash FROM invites")).rows.map((r) => String(r.token_hash));
    expect(stored.join()).not.toContain(invite.token);
    expect(await inspectInvite(invite.token)).toMatchObject({ email: "dana@example.org", kind: "invite" });

    const session = await acceptInvite({ token: invite.token, name: "Dana", password: PASSWORD });
    expect(await sessionUser(session)).toMatchObject({ email: "dana@example.org", role: "dispatcher" });
    expect(await refusal(acceptInvite({ token: invite.token, name: "Dana", password: PASSWORD }))).toBe(410);
  });

  it("expire, can be revoked, and a new link cancels the old one", async () => {
    const admin = await firstAdmin();
    const now = Date.now();
    const old = await createInvite(admin, "a@example.org", "dispatcher", now);
    expect(await refusal(acceptInvite({ token: old.token, name: "A", password: PASSWORD }, now + INVITE_HOURS * 3600 * 1000 + 1))).toBe(410);

    const second = await createInvite(admin, "a@example.org", "dispatcher");
    expect(await refusal(inspectInvite(old.token))).toBe(410); // replaced
    const { invites } = await listPeople();
    await revokeInvite(admin, invites[0].id);
    expect(await refusal(acceptInvite({ token: second.token, name: "A", password: PASSWORD }))).toBe(410);
  });

  it("reject weak passwords, and only admins may create them", async () => {
    const admin = await firstAdmin();
    const invite = await createInvite(admin, "b@example.org", "dispatcher");
    expect(await refusal(acceptInvite({ token: invite.token, name: "B", password: "short" }))).toBe(400);
    const dispatcher = await addPerson(admin, "c@example.org", "dispatcher");
    expect(await refusal(createInvite(dispatcher, "d@example.org", "admin"))).toBe(403);
  });
});

describe("resets", () => {
  it("change only the password, keep the role, and sign out other sessions", async () => {
    const admin = await firstAdmin();
    const dana = await addPerson(admin, "dana@example.org", "dispatcher");
    const oldSession = (await (await db()).execute({ sql: "SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?", args: [dana.id] })).rows[0];
    expect(Number(oldSession.n)).toBe(1);

    const reset = await createInvite(admin, "dana@example.org", "admin"); // asking for admin doesn't promote
    expect(reset).toMatchObject({ kind: "reset", role: "dispatcher" });
    const fresh = await acceptInvite({ token: reset.token, password: "a different long password" });
    expect(await sessionUser(fresh)).toMatchObject({ role: "dispatcher" });
    const remaining = (await (await db()).execute({ sql: "SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?", args: [dana.id] })).rows[0];
    expect(Number(remaining.n)).toBe(1); // only the new one
    await expect(signIn("dana@example.org", "a different long password")).resolves.toMatchObject({ id: dana.id });
  });

  it("can't bring back a revoked account, and revoking cancels pending links", async () => {
    const admin = await firstAdmin();
    const dana = await addPerson(admin, "dana@example.org", "dispatcher");
    const pending = await createInvite(admin, "dana@example.org", "dispatcher");
    await updatePerson(admin, dana.id, { disabled: true });
    expect(await refusal(acceptInvite({ token: pending.token, password: PASSWORD }))).toBe(410);
    expect(await refusal(createInvite(admin, "dana@example.org", "dispatcher"))).toBe(409);
  });

  it("a role change cancels pending links", async () => {
    const admin = await firstAdmin();
    const dana = await addPerson(admin, "dana@example.org", "dispatcher");
    const pending = await createInvite(admin, "dana@example.org", "dispatcher");
    await updatePerson(admin, dana.id, { role: "admin" });
    expect(await refusal(acceptInvite({ token: pending.token, password: PASSWORD }))).toBe(410);
  });
});

describe("managing people", () => {
  it("revoking access ends the person's sessions at once", async () => {
    const admin = await firstAdmin();
    const invite = await createInvite(admin, "dana@example.org", "dispatcher");
    const token = await acceptInvite({ token: invite.token, name: "Dana", password: PASSWORD });
    const dana = (await sessionUser(token))!;
    await updatePerson(admin, dana.id, { disabled: true });
    expect(await sessionUser(token)).toBeNull();
    expect(await refusal(signIn("dana@example.org", PASSWORD))).toBe(401);
    await updatePerson(admin, dana.id, { disabled: false });
    await expect(signIn("dana@example.org", PASSWORD)).resolves.toMatchObject({ id: dana.id });
  });

  it("never leaves the app without an active admin", async () => {
    const admin = await firstAdmin();
    expect(await refusal(updatePerson(admin, admin.id, { role: "dispatcher" }))).toBe(409);
    expect(await refusal(updatePerson(admin, admin.id, { disabled: true }))).toBe(409);
  });

  it("hands admin over safely: invite a new admin, then step down", async () => {
    const skyler = await firstAdmin();
    const next = await addPerson(skyler, "next@example.org", "admin");
    await updatePerson(skyler, skyler.id, { role: "dispatcher" });
    expect(await refusal(updatePerson(next, next.id, { role: "dispatcher" }))).toBe(409); // now the last one
    expect((await listPeople()).people.filter((p) => p.role === "admin").map((p) => p.email)).toEqual(["next@example.org"]);
  });

  it("two admins demoting each other at once: only one succeeds", async () => {
    const a = await firstAdmin();
    const b = await addPerson(a, "b@example.org", "admin");
    const results = await Promise.all([refusal(updatePerson(a, b.id, { role: "dispatcher" })), refusal(updatePerson(b, a.id, { role: "dispatcher" }))]);
    expect(results.sort()).toEqual([0, 403]); // the loser is no longer an admin when its transaction runs
    expect((await listPeople()).people.filter((p) => p.role === "admin" && p.disabledAt == null)).toHaveLength(1);
  });

  it("re-checks the acting admin inside the transaction", async () => {
    const a = await firstAdmin();
    const b = await addPerson(a, "b@example.org", "admin");
    await updatePerson(a, b.id, { role: "dispatcher" });
    // `b` still holds an old in-memory admin identity; the transaction sees the demotion
    expect(await refusal(createInvite(b, "x@example.org", "admin"))).toBe(403);
    expect(await refusal(updatePerson(b, a.id, { disabled: true }))).toBe(403);
  });
});

describe("sign-in limits", () => {
  it("allows 5 wrong passwords per account, then pauses even the right one", async () => {
    await firstAdmin();
    const start = Date.now();
    for (let i = 0; i < LIMITS.email; i++) expect(await refusal(signIn(ADMIN, `wrong password ${i}`, start))).toBe(401);
    expect(await refusal(signIn(ADMIN, PASSWORD, start + 1000))).toBe(429);
    await expect(signIn(ADMIN, PASSWORD, start + 15 * 60 * 1000)).resolves.toMatchObject({ email: ADMIN });
  });

  it("hands back the slot after a correct password, and treats unknown emails the same", async () => {
    await firstAdmin();
    for (let i = 0; i < LIMITS.email - 1; i++) await refusal(signIn(ADMIN, `wrong ${i}`));
    await signIn(ADMIN, PASSWORD);
    expect(await refusal(signIn(ADMIN, "wrong again"))).toBe(401); // not locked: the success refunded its slot
    expect(await refusal(signIn("nobody@example.org", PASSWORD))).toBe(401);
  });
});

describe("migration from the shared passcode", () => {
  it("drops the old session and throttle tables and keeps the schedule", async () => {
    const url = `file:${join(dir, "legacy.db")}`;
    const legacy = createClient({ url });
    await legacy.executeMultiple(`
      CREATE TABLE berths (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, length_ft REAL, sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '');
      INSERT INTO berths (name, length_ft) VALUES ('North Pier West', 410);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, passcode_version TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('abc', 'v1', 0, 9999999999999);
      CREATE TABLE login_throttle (id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER NOT NULL, failures INTEGER NOT NULL);
    `);
    legacy.close();
    resetDbForTests(url);
    expect((await listBerths()).map((b) => b.name)).toEqual(["North Pier West"]);
    const tables = (await (await db()).execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    expect(tables).not.toContain("sessions");
    expect(tables).not.toContain("login_throttle");
    expect(tables).toEqual(expect.arrayContaining(["users", "invites", "user_sessions", "login_attempts", "app_settings"]));
    await createBerth({ name: "Still writable", lengthFt: 50 });
  });
});
