// Personal accounts: signing in, the one-time first-admin setup, invitations and resets,
// and admins managing people. The rules that matter:
//
// * Nobody becomes admin by being first. The first admin is created at /setup with a token
//   only the server operator knows, and setup closes for good once used (a permanent marker,
//   not a count of admins).
// * Invitation and reset links are single-use, expire after 72 hours, and are stored hashed.
//   A reset changes only the password: it never changes a role or re-enables a disabled
//   account. Disabling someone or changing their role cancels their pending links, so an old
//   link can't undo it.
// * There is always at least one active admin: the last one can't be demoted or disabled.
// * Anything that depends on the acting admin re-checks, inside the same write transaction,
//   that they are still an active admin.
// * Password hashing (deliberately slow) always happens outside the database's write lock.

import type { Transaction } from "@libsql/client";
import { hashToken, LIMITS, newToken, normalizeEmail, isEmail, refundAttempt, reserveAttempt, secretsMatch, createSession, type Actor, type AuthMode, type Role, type SessionUser } from "./auth";
import { HttpError } from "./api";
import { db, withWriteTransaction } from "./db";
import { DUMMY_HASH, hashPassword, MAX_PASSWORD, passwordProblem, verifyPassword } from "./passwords";

export const INVITE_HOURS = 72;
const BOOTSTRAP_MARKER = "bootstrap_consumed_at";

/** A refusal the routes pass straight to the user (see HttpError in api.ts). */
export class AccountError extends HttpError {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 410 | 429, message: string, retryAfterSeconds?: number) {
    super(status, message, retryAfterSeconds);
  }
}

export interface Person {
  id: number;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  disabledAt: number | null;
}

export interface PendingInvite {
  id: number;
  email: string;
  role: Role;
  kind: "invite" | "reset";
  createdAt: number;
  expiresAt: number;
  createdBy: string | null;
}

const isRole = (v: unknown): v is Role => v === "admin" || v === "dispatcher";
const cleanName = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 100) : "");

function toPerson(r: Record<string, unknown>): Person {
  return {
    id: Number(r.id),
    email: String(r.email),
    name: String(r.name),
    role: r.role as Role,
    createdAt: Number(r.created_at),
    disabledAt: r.disabled_at == null ? null : Number(r.disabled_at),
  };
}

type Executor = Transaction | Awaited<ReturnType<typeof db>>;

async function findUserByEmail(conn: Executor, email: string): Promise<(Person & { passwordHash: string }) | null> {
  const row = (await conn.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] })).rows[0];
  return row ? { ...toPerson(row), passwordHash: String(row.password_hash) } : null;
}

/** Throws unless `actor` is still an active admin (dev-open has no actor and is allowed). */
async function assertStillAdmin(tx: Transaction, actor: Actor): Promise<void> {
  if (!actor) return;
  const row = (await tx.execute({ sql: "SELECT role, disabled_at FROM users WHERE id = ?", args: [actor.id] })).rows[0];
  if (!row || row.disabled_at != null || row.role !== "admin") throw new AccountError(403, "Only an active admin can do that.");
}

async function activeAdminsOtherThan(tx: Transaction, id: number): Promise<number> {
  const row = (await tx.execute({ sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ?", args: [id] })).rows[0];
  return Number(row.n);
}

async function cancelPendingLinks(tx: Transaction, email: string, now: number): Promise<void> {
  await tx.execute({ sql: "UPDATE invites SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL", args: [now, email] });
}

/** Runs `work` in a write transaction, turning an AccountError into a rollback and a rethrow. */
async function inTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const outcome = await withWriteTransaction<{ value: T } | { error: AccountError }>(async (tx) => {
    try {
      return { commit: true, value: { value: await work(tx) } };
    } catch (err) {
      if (err instanceof AccountError) return { commit: false, value: { error: err } };
      throw err;
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

// ---- signing in ------------------------------------------------------------------------

/** Checks an email and password with the guess limits. Returns the user, or throws AccountError. */
export async function signIn(rawEmail: unknown, password: unknown, now = Date.now()): Promise<SessionUser & { sessionToken: string }> {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email) || typeof password !== "string" || !password || password.length > MAX_PASSWORD) throw new AccountError(400, "Enter your email and password.");

  const reservation = await withWriteTransaction(async (tx) => {
    const r = await reserveAttempt(tx, [{ bucket: `email:${email}`, limit: LIMITS.email }, { bucket: "global", limit: LIMITS.global }], now);
    return { commit: r.ok, value: r };
  });
  if (!reservation.ok) {
    const minutes = Math.ceil(reservation.retryAfterSeconds / 60);
    throw new AccountError(429, `Too many wrong attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`, reservation.retryAfterSeconds);
  }

  const user = await findUserByEmail(await db(), email);
  // Always run a hash comparison, so a wrong email takes as long as a wrong password.
  const matches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !matches || user.disabledAt != null) throw new AccountError(401, "That email and password don't match an active account.");

  // Verification was deliberately outside the lock. A reset or revocation may have
  // happened during that work, so re-check the credential and create the session in
  // the same transaction. A reset after this commit will delete this session too.
  return inTransaction(async (tx) => {
    const current = await findUserByEmail(tx, email);
    if (!current || current.id !== user.id || current.disabledAt != null || current.passwordHash !== user.passwordHash) {
      throw new AccountError(401, "That email and password don't match an active account.");
    }
    await refundAttempt(tx, reservation.buckets);
    const sessionToken = await createSession(current.id, tx, now);
    return { id: current.id, email: current.email, name: current.name, role: current.role, sessionToken };
  });
}

// ---- first admin --------------------------------------------------------------------------

export async function setupAvailable(mode: AuthMode): Promise<boolean> {
  if (mode.kind !== "enforced" || !mode.bootstrap) return false;
  const row = (await (await db()).execute({ sql: "SELECT 1 FROM app_settings WHERE key = ?", args: [BOOTSTRAP_MARKER] })).rows[0];
  return !row;
}

/**
 * Creates the first admin, once. Needs the operator's BOOTSTRAP_TOKEN and exactly the
 * BOOTSTRAP_ADMIN_EMAIL. Returns a session token for the new admin.
 */
export async function bootstrapAdmin(mode: AuthMode, input: { token?: unknown; email?: unknown; name?: unknown; password?: unknown }, now = Date.now()): Promise<string> {
  if (mode.kind !== "enforced" || !mode.bootstrap) throw new AccountError(404, "First-admin setup isn't available on this server.");
  const email = normalizeEmail(input.email);
  const name = cleanName(input.name);
  const problem = passwordProblem(input.password);
  if (!name) throw new AccountError(400, "Enter your name.");
  if (problem) throw new AccountError(400, problem);
  if (typeof input.token !== "string" || !input.token || input.token.length > 200) throw new AccountError(400, "Enter the setup token.");

  if (!(await setupAvailable(mode))) throw new AccountError(410, "Setup has already been completed. Sign in instead.");
  const reservation = await withWriteTransaction(async (tx) => {
    const r = await reserveAttempt(tx, [{ bucket: "setup", limit: LIMITS.setup }], now);
    return { commit: r.ok, value: r };
  });
  if (!reservation.ok) throw new AccountError(429, "Too many wrong setup attempts. Try again later.", reservation.retryAfterSeconds);
  if (!secretsMatch(input.token, mode.bootstrap.token) || email !== mode.bootstrap.email) {
    throw new AccountError(401, "The setup token or email doesn't match this server's setup settings.");
  }

  const passwordHash = await hashPassword(input.password as string);
  return inTransaction(async (tx) => {
    const done = (await tx.execute({ sql: "SELECT 1 FROM app_settings WHERE key = ?", args: [BOOTSTRAP_MARKER] })).rows[0];
    if (done) throw new AccountError(410, "Setup has already been completed. Sign in instead.");
    if (await findUserByEmail(tx, email)) throw new AccountError(409, "An account with that email already exists.");
    const rs = await tx.execute({
      sql: "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, 'admin', ?, ?) RETURNING id",
      args: [email, name, passwordHash, now],
    });
    await tx.execute({ sql: "INSERT INTO app_settings (key, value) VALUES (?, ?)", args: [BOOTSTRAP_MARKER, String(now)] });
    await refundAttempt(tx, reservation.buckets);
    return createSession(Number(rs.rows[0].id), tx, now);
  });
}

// ---- invitations and resets ---------------------------------------------------------------

/**
 * A single-use link for `email`. For someone new it's an invitation with `role`; for an
 * existing active account it's a password reset that keeps their current role. Returns the
 * raw token, which is shown to the admin once and never stored or logged.
 */
export async function createInvite(actor: Actor, rawEmail: unknown, rawRole: unknown, now = Date.now()) {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) throw new AccountError(400, "Enter a valid email address.");
  if (!isRole(rawRole)) throw new AccountError(400, "Choose a role: admin or dispatcher.");
  const token = newToken();

  return inTransaction(async (tx) => {
    await assertStillAdmin(tx, actor);
    const existing = await findUserByEmail(tx, email);
    if (existing?.disabledAt != null) throw new AccountError(409, "That account's access has been revoked. Restore it first, then send a reset link.");
    const kind = existing ? ("reset" as const) : ("invite" as const);
    const role = existing ? existing.role : rawRole;
    await cancelPendingLinks(tx, email, now); // one live link per person
    const expiresAt = now + INVITE_HOURS * 3600 * 1000;
    await tx.execute({
      sql: "INSERT INTO invites (token_hash, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [hashToken(token), email, role, actor?.id ?? null, now, expiresAt],
    });
    return { token, email, role, kind, expiresAt };
  });
}

async function liveInvite(conn: Executor, token: string, now: number) {
  const row = (
    await conn.execute({
      sql: "SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
      args: [hashToken(token), now],
    })
  ).rows[0];
  return row ? { id: Number(row.id), email: String(row.email), role: row.role as Role } : null;
}

/** What a link is for, so the page can say "set your password for …". */
export async function inspectInvite(token: unknown, now = Date.now()) {
  if (typeof token !== "string" || !token || token.length > 200) throw new AccountError(400, "This link is incomplete.");
  const conn = await db();
  const invite = await liveInvite(conn, token, now);
  if (!invite) throw new AccountError(410, "This link has expired, been used, or been cancelled. Ask an admin for a new one.");
  const existing = await findUserByEmail(conn, invite.email);
  if (existing?.disabledAt != null) throw new AccountError(410, "This account's access has been revoked.");
  return { email: invite.email, role: existing ? existing.role : invite.role, kind: existing ? ("reset" as const) : ("invite" as const), name: existing?.name ?? "" };
}

/** Uses a link: sets the password (and name, for someone new) and returns a session token. */
export async function acceptInvite(input: { token?: unknown; name?: unknown; password?: unknown }, now = Date.now()): Promise<string> {
  const token = input.token;
  if (typeof token !== "string" || !token || token.length > 200) throw new AccountError(400, "This link is incomplete.");
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountError(400, problem);
  const name = cleanName(input.name);

  // Reject arbitrary, expired and revoked tokens before the expensive hash. Keep the
  // authoritative check inside the transaction too, because the link may change while
  // hashing. A valid invitation is the capability required to reach this work.
  await inspectInvite(token, now);
  const passwordHash = await hashPassword(input.password as string);
  return inTransaction(async (tx) => {
    const invite = await liveInvite(tx, token, now);
    if (!invite) throw new AccountError(410, "This link has expired, been used, or been cancelled. Ask an admin for a new one.");
    const existing = await findUserByEmail(tx, invite.email);
    let userId: number;
    if (existing) {
      // A reset: password only. Never re-enables a revoked account or changes the role.
      if (existing.disabledAt != null) throw new AccountError(410, "This account's access has been revoked.");
      await tx.execute({ sql: "UPDATE users SET password_hash = ?, name = ? WHERE id = ?", args: [passwordHash, name || existing.name, existing.id] });
      await tx.execute({ sql: "DELETE FROM user_sessions WHERE user_id = ?", args: [existing.id] }); // sign out everywhere else
      userId = existing.id;
    } else {
      if (!name) throw new AccountError(400, "Enter your name.");
      const rs = await tx.execute({
        sql: "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        args: [invite.email, name, invite.role, passwordHash, now],
      });
      userId = Number(rs.rows[0].id);
    }
    await tx.execute({ sql: "UPDATE invites SET used_at = ? WHERE id = ?", args: [now, invite.id] });
    return createSession(userId, tx, now);
  });
}

export async function revokeInvite(actor: Actor, id: number, now = Date.now()): Promise<void> {
  await inTransaction(async (tx) => {
    await assertStillAdmin(tx, actor);
    const rs = await tx.execute({ sql: "UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL", args: [now, id] });
    if (rs.rowsAffected === 0) throw new AccountError(404, "No pending link with that id.");
  });
}

// ---- managing people -------------------------------------------------------------------------

export async function listPeople(now = Date.now()): Promise<{ people: Person[]; invites: PendingInvite[] }> {
  const conn = await db();
  const people = (await conn.execute("SELECT * FROM users ORDER BY disabled_at IS NOT NULL, role, name")).rows.map(toPerson);
  const invites = (
    await conn.execute({
      sql: `SELECT i.*, u.name AS created_by_name, EXISTS (SELECT 1 FROM users x WHERE x.email = i.email) AS for_existing
            FROM invites i LEFT JOIN users u ON u.id = i.created_by
            WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
      args: [now],
    })
  ).rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email),
    role: r.role as Role,
    kind: Number(r.for_existing) ? ("reset" as const) : ("invite" as const),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    createdBy: r.created_by_name == null ? null : String(r.created_by_name),
  }));
  return { people, invites };
}

/**
 * Change someone's role, revoke their access, or restore it. Revoking signs them out
 * everywhere. Either change cancels their pending links. The last active admin can't be
 * demoted or revoked, which is checked inside the transaction so two admins acting at once
 * can't both succeed.
 */
export async function updatePerson(actor: Actor, id: number, change: { role?: unknown; disabled?: unknown }, now = Date.now()): Promise<Person> {
  if (change.role !== undefined && !isRole(change.role)) throw new AccountError(400, "Choose a role: admin or dispatcher.");
  if (change.disabled !== undefined && typeof change.disabled !== "boolean") throw new AccountError(400, "disabled must be true or false.");
  if (change.role === undefined && change.disabled === undefined) throw new AccountError(400, "Nothing to change.");

  return inTransaction(async (tx) => {
    await assertStillAdmin(tx, actor);
    const row = (await tx.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] })).rows[0];
    if (!row) throw new AccountError(404, "No such person.");
    const person = toPerson(row);
    const losesAdmin = person.role === "admin" && person.disabledAt == null && (change.disabled === true || change.role === "dispatcher");
    if (losesAdmin && (await activeAdminsOtherThan(tx, id)) === 0) {
      throw new AccountError(409, "This is the last active admin. Make someone else an admin first.");
    }
    if (change.role !== undefined && change.role !== person.role) {
      await tx.execute({ sql: "UPDATE users SET role = ? WHERE id = ?", args: [change.role as Role, id] });
      await cancelPendingLinks(tx, person.email, now);
    }
    if (change.disabled === true && person.disabledAt == null) {
      await tx.execute({ sql: "UPDATE users SET disabled_at = ? WHERE id = ?", args: [now, id] });
      await tx.execute({ sql: "DELETE FROM user_sessions WHERE user_id = ?", args: [id] });
      await cancelPendingLinks(tx, person.email, now);
    }
    if (change.disabled === false && person.disabledAt != null) {
      await tx.execute({ sql: "UPDATE users SET disabled_at = NULL WHERE id = ?", args: [id] });
    }
    return toPerson((await tx.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] })).rows[0]);
  });
}
