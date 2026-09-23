// Dispatcher sign-in: configuration, sessions, origin checks, the sign-in throttle, and
// that every route which changes data refuses a visitor who isn't signed in.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { authMode, createSession, LOGIN_LIMIT, LOGIN_WINDOW_MS, SESSION_HOURS, attemptLogin, sessionValid } from "../auth";
import { db, resetDbForTests } from "../db";

const ORIGIN = "https://berths.example.org";
const PASSCODE = "correct horse battery";
const SECRET = "s".repeat(24) + "-0123456789abcdef";
const env = { NODE_ENV: "test", DISPATCHER_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN };

const dir = mkdtempSync(join(tmpdir(), "berth-auth-"));
let dbCount = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const saved = { ...process.env };
function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["DISPATCHER_PASSCODE", "SESSION_SECRET", "APP_ORIGIN", "DEV_OPEN_WRITES"]) delete process.env[key];
  Object.assign(process.env, values);
}
beforeEach(() => {
  resetDbForTests(`file:${join(dir, `auth-${++dbCount}.db`)}`);
  setEnv({ DISPATCHER_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN });
});
afterEach(() => {
  process.env = { ...saved };
});

const enforced = () => {
  const mode = authMode(env);
  if (mode.kind !== "enforced") throw new Error("expected enforced mode");
  return mode;
};

describe("configuration", () => {
  it("is enforced with a passcode, a strong secret and a valid origin", () => {
    expect(authMode(env).kind).toBe("enforced");
  });

  it("fails closed in production when anything is missing or weak", () => {
    const prod = { ...env, NODE_ENV: "production" };
    expect(authMode(prod).kind).toBe("enforced");
    expect(authMode({ ...prod, DISPATCHER_PASSCODE: undefined }).kind).toBe("misconfigured");
    expect(authMode({ ...prod, DISPATCHER_PASSCODE: "short" }).kind).toBe("misconfigured");
    expect(authMode({ ...prod, SESSION_SECRET: "too-short" }).kind).toBe("misconfigured");
    expect(authMode({ ...prod, SESSION_SECRET: PASSCODE.repeat(3), DISPATCHER_PASSCODE: PASSCODE.repeat(3) }).kind).toBe("misconfigured");
    expect(authMode({ ...prod, APP_ORIGIN: undefined }).kind).toBe("misconfigured");
    expect(authMode({ ...prod, APP_ORIGIN: `${ORIGIN}/` }).kind).toBe("misconfigured"); // not an exact origin
    expect(authMode({ ...prod, DISPATCHER_PASSCODE: "x".repeat(201) }).kind).toBe("misconfigured");
    expect(authMode({ ...prod, APP_ORIGIN: "http://berths.example.org" }).kind).toBe("misconfigured"); // https only in production
    for (const bad of ["null", "file:///tmp", "data:text/plain,hi", "ftp://example.org", "*"]) {
      expect(authMode({ ...env, APP_ORIGIN: bad }).kind, bad).toBe("misconfigured");
    }
    expect(authMode({ ...env, APP_ORIGIN: "http://localhost:3000" }).kind).toBe("enforced"); // plain http is fine outside production
  });

  it("only lets DEV_OPEN_WRITES skip sign-in in development", () => {
    expect(authMode({ NODE_ENV: "development", DEV_OPEN_WRITES: "1" }).kind).toBe("dev-open");
    expect(authMode({ NODE_ENV: "production", DEV_OPEN_WRITES: "1" }).kind).toBe("misconfigured");
    expect(authMode({ ...env, NODE_ENV: "production", DEV_OPEN_WRITES: "1" }).kind).toBe("enforced");
    expect(authMode({ NODE_ENV: "test", DEV_OPEN_WRITES: "1" }).kind).toBe("misconfigured");
    // without the flag, development needs real configuration too
    expect(authMode({ NODE_ENV: "development" }).kind).toBe("misconfigured");
  });
});

describe("sessions", () => {
  it("accepts a fresh session and rejects forged, tampered and expired ones", async () => {
    const mode = enforced();
    const now = Date.now();
    const token = await createSession(mode, now);
    expect(await sessionValid(mode, token, now)).toBe(true);
    expect(await sessionValid(mode, null, now)).toBe(false);
    expect(await sessionValid(mode, "forged-token", now)).toBe(false);
    expect(await sessionValid(mode, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), now)).toBe(false);
    expect(await sessionValid(mode, token, now + SESSION_HOURS * 3600 * 1000 + 1)).toBe(false);
  });

  it("stores only a hash of the token", async () => {
    const token = await createSession(enforced());
    const rows = (await (await db()).execute("SELECT token_hash FROM sessions")).rows;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].token_hash)).not.toContain(token);
  });

  it("signs everyone out when the passcode or the secret changes", async () => {
    const token = await createSession(enforced());
    const rotated = authMode({ ...env, DISPATCHER_PASSCODE: "a brand new passcode" });
    const newSecret = authMode({ ...env, SESSION_SECRET: "t".repeat(40) });
    if (rotated.kind !== "enforced" || newSecret.kind !== "enforced") throw new Error("expected enforced mode");
    expect(await sessionValid(rotated, token)).toBe(false);
    expect(await sessionValid(newSecret, token)).toBe(false);
    expect(await sessionValid(enforced(), token)).toBe(true);
  });
});

describe("sign-in throttle", () => {
  it("pauses sign-in after too many wrong passcodes, even for the right one, until the window ends", async () => {
    const mode = enforced();
    const start = Date.now();
    for (let i = 0; i < LOGIN_LIMIT; i++) expect(await attemptLogin(mode, `wrong ${i}`, start)).toEqual({ ok: false, status: 401 });
    const blocked = await attemptLogin(mode, PASSCODE, start + 1000);
    expect(blocked).toMatchObject({ ok: false, status: 429 });
    if (!blocked.ok && blocked.status === 429) expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
    // bounded: once the window has passed, the right passcode works again
    expect(await attemptLogin(mode, PASSCODE, start + LOGIN_WINDOW_MS)).toEqual({ ok: true });
  });

  it("keeps the count in the database, so every server instance shares it", async () => {
    const mode = enforced();
    await attemptLogin(mode, "wrong");
    await attemptLogin(mode, "wrong again");
    const row = (await (await db()).execute("SELECT failures FROM login_throttle WHERE id = 1")).rows[0];
    expect(Number(row.failures)).toBe(2);
  });
});

// ---- routes ------------------------------------------------------------------------

const API = join(__dirname, "../../app/api");
const PUBLIC_POSTS = new Set(["reservations/check", "session"]); // read-only dry run, and sign-in itself

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

describe("write routes", () => {
  // Found by importing every route module and looking at what it actually exports, so a
  // handler written as `export async function POST` or re-exported from elsewhere is
  // still checked. The checks below are behavioural: each handler is called for real.
  const VERBS = ["POST", "PUT", "PATCH", "DELETE"] as const;
  type Handler = (req: Request, c: unknown) => Promise<Response>;
  async function writeHandlers() {
    const found: { route: string; method: string; handler: Handler }[] = [];
    for (const file of routeFiles()) {
      const route = relative(API, file).replace(/\/?route\.ts$/, "");
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of VERBS) if (typeof mod[method] === "function") found.push({ route, method, handler: mod[method] as Handler });
    }
    return found;
  }

  it("finds the write handlers, and only the check and sign-in are public", async () => {
    const all = await writeHandlers();
    expect(all.length).toBeGreaterThanOrEqual(13);
    expect([...new Set(all.filter((w) => PUBLIC_POSTS.has(w.route)).map((w) => w.route))].sort()).toEqual(["reservations/check", "session"]);
  });

  it("refuses every data-changing handler without a session (401), from another origin (403), and when unconfigured (503)", async () => {
    for (const w of (await writeHandlers()).filter((w) => !PUBLIC_POSTS.has(w.route))) {
      const path = `/api/${w.route.replace("[id]", "1")}`;
      const label = `${w.method} ${path}`;

      expect((await w.handler(request(path, w.method), ctx)).status, label).toBe(401);
      expect((await w.handler(request(path, w.method, { cookie: "berth_dispatcher=forged" }), ctx)).status, label).toBe(401);
      expect((await w.handler(request(path, w.method, { origin: "https://evil.example" }), ctx)).status, label).toBe(403);
      expect((await w.handler(request(path, w.method, { origin: null }), ctx)).status, label).toBe(403);

      setEnv({ APP_ORIGIN: ORIGIN }); // passcode and secret missing
      expect((await w.handler(request(path, w.method), ctx)).status, label).toBe(503);
      setEnv({ DISPATCHER_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN });
    }
  });

  it("protects imports, including the dry-run preview", async () => {
    const { POST } = await import("../../app/api/import/route");
    const res = await POST(request("/api/import", "POST", { body: { csv: "x", dryRun: true } }));
    expect(res.status).toBe(401);
  });

  it("keeps reading and the conflict check public", async () => {
    const berths = await import("../../app/api/berths/route");
    expect((await berths.GET()).status).toBe(200);
    const check = await import("../../app/api/reservations/check/route");
    const res = await check.POST(request("/api/reservations/check", "POST", { origin: null, body: { berthId: 999, vesselId: null, title: "x", startDate: "2018-01-01", endDate: "2018-01-02" } }));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe("sign-in flow", () => {
  const cookieFrom = (res: Response) => {
    const header = res.headers.get("set-cookie") ?? "";
    return { header, pair: header.split(";")[0] };
  };

  it("signs in, writes, signs out, and a copied cookie stops working after sign-out", async () => {
    const session = await import("../../app/api/session/route");
    const berths = await import("../../app/api/berths/route");

    expect((await session.POST(request("/api/session", "POST", { body: { passcode: "nope" } }))).status).toBe(401);
    expect((await session.POST(request("/api/session", "POST", { origin: "https://evil.example", body: { passcode: PASSCODE } }))).status).toBe(403);

    const login = await session.POST(request("/api/session", "POST", { body: { passcode: PASSCODE } }));
    expect(login.status).toBe(200);
    const { header, pair } = cookieFrom(login);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=strict/i);

    const status = await session.GET(request("/api/session", "GET", { cookie: pair }));
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    expect(await status.json()).toEqual({ editing: "dispatcher" });
    const created = await berths.POST(request("/api/berths", "POST", { cookie: pair, body: { name: "Test Pier", lengthFt: 100 } }));
    expect(created.status).toBe(201);

    const logout = await session.DELETE(request("/api/session", "DELETE", { cookie: pair }));
    expect(logout.status).toBe(200);
    expect(cookieFrom(logout).header).toMatch(/Max-Age=0/i);

    // the old cookie, replayed after sign-out, is dead on the server
    expect((await berths.POST(request("/api/berths", "POST", { cookie: pair, body: { name: "Another", lengthFt: 50 } }))).status).toBe(401);
    expect(await (await session.GET(request("/api/session", "GET", { cookie: pair }))).json()).toEqual({ editing: "viewer" });
  });

  it("refuses sign-in and sign-out from another origin, and reports editing off when unconfigured", async () => {
    const session = await import("../../app/api/session/route");
    expect((await session.DELETE(request("/api/session", "DELETE", { origin: "https://evil.example" }))).status).toBe(403);
    setEnv({});
    const refused = await session.POST(request("/api/session", "POST", { body: { passcode: PASSCODE } }));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    const off = await session.GET(request("/api/session", "GET"));
    expect(off.headers.get("cache-control")).toBe("private, no-store");
    expect(await off.json()).toEqual({ editing: "off" });
  });

  it("uses a __Host- Secure cookie in production", async () => {
    setEnv({ DISPATCHER_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN });
    (process.env as Record<string, string>).NODE_ENV = "production";
    const session = await import("../../app/api/session/route");
    const login = await session.POST(request("/api/session", "POST", { body: { passcode: PASSCODE } }));
    expect(login.status).toBe(200);
    const header = login.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^__Host-berth_dispatcher=/);
    expect(header).toMatch(/Secure/i);
  });
});
