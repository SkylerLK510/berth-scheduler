// Sign-in configuration, sessions, the same-site check, and that every route which changes
// data refuses anyone without the right account, calling the real route handlers.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { authMode, createSession, SESSION_HOURS, sessionUser } from "../auth";
import { db, resetDbForTests } from "../db";

const ORIGIN = "https://berths.example.org";
const TOKEN = "operator-setup-token-0123456789abcdef";
const ADMIN = "skyler@example.org";
const PASSWORD = "a long enough password";
const baseEnv = { APP_ORIGIN: ORIGIN, BOOTSTRAP_ADMIN_EMAIL: ADMIN, BOOTSTRAP_TOKEN: TOKEN };

const dir = mkdtempSync(join(tmpdir(), "berth-auth-"));
let dbCount = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const saved = { ...process.env };
function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["APP_ORIGIN", "BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_TOKEN", "DEV_OPEN_WRITES", "DISPATCHER_PASSCODE", "SESSION_SECRET"]) delete process.env[key];
  Object.assign(process.env, values);
}
beforeEach(() => {
  resetDbForTests(`file:${join(dir, `auth-${++dbCount}.db`)}`);
  setEnv(baseEnv);
});
afterEach(() => {
  process.env = { ...saved };
});

describe("configuration", () => {
  it("needs only a valid origin; production needs it set, and https", () => {
    expect(authMode({ NODE_ENV: "test" }).kind).toBe("enforced");
    expect(authMode({ NODE_ENV: "production" }).kind).toBe("misconfigured");
    expect(authMode({ NODE_ENV: "production", APP_ORIGIN: ORIGIN }).kind).toBe("enforced");
    expect(authMode({ NODE_ENV: "production", APP_ORIGIN: "http://berths.example.org" }).kind).toBe("misconfigured");
    for (const bad of ["null", "file:///tmp", "data:text/plain,hi", "ftp://example.org", "*", `${ORIGIN}/`]) {
      expect(authMode({ NODE_ENV: "test", APP_ORIGIN: bad }).kind, bad).toBe("misconfigured");
    }
  });

  it("ignores the retired shared passcode entirely", () => {
    const mode = authMode({ NODE_ENV: "production", APP_ORIGIN: ORIGIN, DISPATCHER_PASSCODE: "the old shared passcode", SESSION_SECRET: "x".repeat(64) });
    expect(mode).toMatchObject({ kind: "enforced", bootstrap: null });
  });

  it("only lets DEV_OPEN_WRITES skip sign-in in development", () => {
    expect(authMode({ NODE_ENV: "development", DEV_OPEN_WRITES: "1" }).kind).toBe("dev-open");
    expect(authMode({ NODE_ENV: "production", APP_ORIGIN: ORIGIN, DEV_OPEN_WRITES: "1" }).kind).toBe("enforced");
    expect(authMode({ NODE_ENV: "test", DEV_OPEN_WRITES: "1" }).kind).toBe("enforced");
  });
});

describe("sessions", () => {
  async function user(disabled = false) {
    const rs = await (await db()).execute({
      sql: "INSERT INTO users (email, name, role, password_hash, created_at, disabled_at) VALUES ('u@example.org', 'U', 'dispatcher', 'x', 0, ?) RETURNING id",
      args: [disabled ? 1 : null],
    });
    return Number(rs.rows[0].id);
  }

  it("accepts a fresh session and rejects forged, tampered and expired ones", async () => {
    const now = Date.now();
    const token = await createSession(await user(), undefined, now);
    expect(await sessionUser(token, now)).toMatchObject({ email: "u@example.org", role: "dispatcher" });
    expect(await sessionUser(null, now)).toBeNull();
    expect(await sessionUser("forged-token", now)).toBeNull();
    expect(await sessionUser(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), now)).toBeNull();
    expect(await sessionUser(token, now + SESSION_HOURS * 3600 * 1000 + 1)).toBeNull();
  });

  it("stores only a hash, and a disabled account's session is dead", async () => {
    const token = await createSession(await user(true));
    const rows = (await (await db()).execute("SELECT token_hash FROM user_sessions")).rows;
    expect(String(rows[0].token_hash)).not.toContain(token);
    expect(await sessionUser(token)).toBeNull();
  });
});

// ---- routes ------------------------------------------------------------------------------

const API = join(__dirname, "../../app/api");
/** POSTs anyone may send (each still checks the origin): the read-only dry run, sign-in, setup, and using a link. */
const PUBLIC_POSTS = new Set(["reservations/check", "session", "setup", "invites/inspect", "invites/accept"]);
/** Routes only an admin may use, for any method. */
const ADMIN_ROUTES = new Set(["users", "users/[id]", "invites", "invites/[id]"]);

function routeFiles(folder = API): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

const request = (path: string, method: string, init: { origin?: string | null; cookie?: string; body?: unknown } = {}) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(init.body) });
};
const ctx = { params: Promise.resolve({ id: "1" }) };
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

type Handler = (req: Request, c: unknown) => Promise<Response>;
async function handlers(methods: string[]) {
  const found: { route: string; method: string; handler: Handler }[] = [];
  for (const file of routeFiles()) {
    const route = relative(API, file).replace(/\/?route\.ts$/, "");
    const mod = (await import(file)) as Record<string, unknown>;
    for (const method of methods) if (typeof mod[method] === "function") found.push({ route, method, handler: mod[method] as Handler });
  }
  return found;
}

/** Sets up the first admin through the real route and returns their cookie. */
async function adminCookie() {
  const setup = await import("../../app/api/setup/route");
  const res = await setup.POST(request("/api/setup", "POST", { body: { token: TOKEN, email: ADMIN, name: "Skyler", password: PASSWORD } }));
  expect(res.status).toBe(201);
  return cookieFrom(res);
}

describe("write routes", () => {
  // Found by importing every route module and looking at what it exports, so a handler
  // written as `export async function POST` or re-exported from elsewhere is still checked.
  it("finds the handlers, and only the listed ones are public", async () => {
    const all = await handlers(["POST", "PUT", "PATCH", "DELETE"]);
    expect(all.length).toBeGreaterThanOrEqual(18);
    expect([...new Set(all.filter((w) => PUBLIC_POSTS.has(w.route)).map((w) => w.route))].sort()).toEqual([...PUBLIC_POSTS].sort());
  });

  it("refuses every non-public change without a session (401), from another origin (403), and when unconfigured (503)", async () => {
    for (const w of (await handlers(["POST", "PUT", "PATCH", "DELETE"])).filter((w) => !PUBLIC_POSTS.has(w.route))) {
      const path = `/api/${w.route.replace("[id]", "1")}`;
      const label = `${w.method} ${path}`;
      expect((await w.handler(request(path, w.method), ctx)).status, label).toBe(401);
      expect((await w.handler(request(path, w.method, { cookie: "berth_session=forged" }), ctx)).status, label).toBe(401);
      expect((await w.handler(request(path, w.method, { origin: "https://evil.example" }), ctx)).status, label).toBe(403);
      expect((await w.handler(request(path, w.method, { origin: null }), ctx)).status, label).toBe(403);
      setEnv({ APP_ORIGIN: "ftp://nope" });
      expect((await w.handler(request(path, w.method), ctx)).status, label).toBe(503);
      setEnv(baseEnv);
    }
  });

  it("keeps people management admin-only, reading included", async () => {
    const admin = await adminCookie();
    const invites = await import("../../app/api/invites/route");
    const accept = await import("../../app/api/invites/accept/route");
    const created = await invites.POST(request("/api/invites", "POST", { cookie: admin, body: { email: "dana@example.org", role: "dispatcher" } }));
    const { token } = await created.json();
    const dispatcher = cookieFrom(await accept.POST(request("/api/invites/accept", "POST", { body: { token, name: "Dana", password: PASSWORD } })));

    for (const w of (await handlers(["GET", "POST", "PATCH", "DELETE"])).filter((w) => ADMIN_ROUTES.has(w.route))) {
      const path = `/api/${w.route.replace("[id]", "1")}`;
      expect((await w.handler(request(path, w.method), ctx)).status, `anonymous ${w.method} ${path}`).toBe(401);
      expect((await w.handler(request(path, w.method, { cookie: dispatcher }), ctx)).status, `dispatcher ${w.method} ${path}`).toBe(403);
    }
  });

  it("protects imports, including the dry-run preview, and keeps reading and the conflict check public", async () => {
    const { POST } = await import("../../app/api/import/route");
    expect((await POST(request("/api/import", "POST", { body: { csv: "x", dryRun: true } }))).status).toBe(401);
    const berths = await import("../../app/api/berths/route");
    expect((await berths.GET()).status).toBe(200);
    const check = await import("../../app/api/reservations/check/route");
    const res = await check.POST(request("/api/reservations/check", "POST", { origin: null, body: { berthId: 999, vesselId: null, title: "x", startDate: "2018-01-01", endDate: "2018-01-02" } }));
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("the whole flow through the routes", () => {
  it("setup, invite, accept, dispatch, revoke, and a copied cookie dies after sign-out", async () => {
    const session = await import("../../app/api/session/route");
    const invites = await import("../../app/api/invites/route");
    const accept = await import("../../app/api/invites/accept/route");
    const users = await import("../../app/api/users/[id]/route");
    const berths = await import("../../app/api/berths/route");

    const admin = await adminCookie();
    const setupAgain = await import("../../app/api/setup/route");
    expect((await setupAgain.POST(request("/api/setup", "POST", { body: { token: TOKEN, email: ADMIN, name: "X", password: PASSWORD } }))).status).toBe(410);

    const created = await invites.POST(request("/api/invites", "POST", { cookie: admin, body: { email: "dana@example.org", role: "dispatcher" } }));
    expect(created.status).toBe(201);
    const invite = await created.json();
    expect(invite.path).toBe(`/accept-invite#${invite.token}`);

    const accepted = await accept.POST(request("/api/invites/accept", "POST", { body: { token: invite.token, name: "Dana", password: PASSWORD } }));
    expect(accepted.status).toBe(200);
    const dana = cookieFrom(accepted);
    expect(accepted.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");

    expect((await berths.POST(request("/api/berths", "POST", { cookie: dana, body: { name: "Test Pier", lengthFt: 100 } }))).status).toBe(201);
    expect((await invites.POST(request("/api/invites", "POST", { cookie: dana, body: { email: "x@example.org", role: "admin" } }))).status).toBe(403);

    // sign in with a password, sign out, replay the old cookie
    const signedIn = await session.POST(request("/api/session", "POST", { body: { email: "dana@example.org", password: PASSWORD } }));
    expect(signedIn.status).toBe(200);
    const second = cookieFrom(signedIn);
    expect((await session.DELETE(request("/api/session", "DELETE", { cookie: second }))).status).toBe(200);
    expect((await berths.POST(request("/api/berths", "POST", { cookie: second, body: {} }))).status).toBe(401);

    // revoking Dana ends her remaining session at once
    const danaId = (await (await db()).execute("SELECT id FROM users WHERE email = 'dana@example.org'")).rows[0].id;
    const revoked = await users.PATCH(request(`/api/users/${danaId}`, "PATCH", { cookie: admin, body: { disabled: true } }), { params: Promise.resolve({ id: String(danaId) }) });
    expect(revoked.status).toBe(200);
    expect((await berths.POST(request("/api/berths", "POST", { cookie: dana, body: {} }))).status).toBe(401);
    expect(await (await session.GET(request("/api/session", "GET", { cookie: dana }))).json()).toEqual({ editing: "viewer" });
  });

  it("refuses sign-in from another origin and reports editing off when unconfigured", async () => {
    const session = await import("../../app/api/session/route");
    expect((await session.POST(request("/api/session", "POST", { origin: "https://evil.example", body: { email: ADMIN, password: PASSWORD } }))).status).toBe(403);
    expect((await session.DELETE(request("/api/session", "DELETE", { origin: "https://evil.example" }))).status).toBe(403);
    setEnv({ APP_ORIGIN: "ftp://nope" });
    const off = await session.GET(request("/api/session", "GET"));
    expect(off.headers.get("cache-control")).toBe("private, no-store");
    expect(await off.json()).toEqual({ editing: "off" });
  });

  it("uses a __Host- Secure cookie in production", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    const setup = await import("../../app/api/setup/route");
    const res = await setup.POST(request("/api/setup", "POST", { body: { token: TOKEN, email: ADMIN, name: "Skyler", password: PASSWORD } }));
    expect(res.status).toBe(201);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^__Host-berth_session=/);
    expect(header).toMatch(/Secure/i);
  });
});
