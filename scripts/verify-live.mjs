// Signed-in checks against a running deployment, using disposable test data.
// Everything it creates is named "ZZ Verify <run id>", dated in 2099, and deleted by `cleanup`.
//
//   BERTH_PASSCODE=... node scripts/verify-live.mjs https://your-app.vercel.app run
//     signs in, races 10 identical bookings (exactly one may win), races two edits onto the
//     same days (exactly one may win), leaves one marker booking, signs out, and checks the
//     old cookie is dead. Saves the run's ids to .verify-live.json (git-ignored).
//   node scripts/verify-live.mjs https://your-app.vercel.app persisted
//     after a redeploy: checks the marker booking is still there (no sign-in needed).
//   BERTH_PASSCODE=... node scripts/verify-live.mjs https://your-app.vercel.app cleanup
//     deletes everything the run created.
//
// The passcode is read from the environment only, never from arguments, and never printed.
// Add --local to allow http://localhost. About 30 requests per run.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const STATE = ".verify-live.json";
const [rawTarget, phase] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const local = process.argv.includes("--local");
const target = new URL(rawTarget ?? "");
if (target.pathname !== "/" || target.search || target.hash || target.username) throw new Error("Give only the app origin, e.g. https://app.vercel.app");
if (target.protocol !== "https:" && !(local && ["localhost", "127.0.0.1"].includes(target.hostname))) throw new Error("HTTPS is required (use --local for localhost).");
if (!["run", "persisted", "cleanup"].includes(phase)) throw new Error("Phase must be run, persisted or cleanup.");

let failures = 0;
function check(label, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!passed) failures++;
}

let cookie = "";
async function call(path, method = "GET", body) {
  const response = await fetch(new URL(path, target), {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: { Origin: target.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, data, headers: response.headers };
}

async function signIn() {
  const passcode = process.env.BERTH_PASSCODE;
  if (!passcode) throw new Error("Set BERTH_PASSCODE in the environment (it is never printed).");
  const response = await fetch(new URL("/api/session", target), {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { Origin: target.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("berth_dispatcher="));
  if (response.status !== 200 || !setCookie) throw new Error(`Sign-in failed with status ${response.status}. Stopping so wrong guesses don't count toward the lockout.`);
  cookie = setCookie.split(";")[0];
  check("signed in", true);
}

async function signOut() {
  const oldCookie = cookie;
  const out = await call("/api/session", "DELETE");
  check("signed out", out.status === 200);
  cookie = oldCookie;
  const replay = await call("/api/vessels", "POST", { name: "ZZ Verify replay", lengthFt: 1 });
  check("old cookie refused after sign-out", replay.status === 401, `status ${replay.status}`);
  cookie = "";
}

async function run() {
  if (existsSync(STATE)) throw new Error(`${STATE} exists from an earlier run. Run cleanup first.`);
  const id = `${Date.now().toString(36)}`;
  const state = { target: target.origin, id, berthId: null, vesselIds: [], reservationIds: [], markerId: null };
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

  await signIn();
  const berth = await call("/api/berths", "POST", { name: `ZZ Verify ${id}`, lengthFt: 100, notes: "Disposable deployment check" });
  check("create test berth", berth.status === 201);
  state.berthId = berth.data?.id ?? null;
  for (const n of [1, 2]) {
    const vessel = await call("/api/vessels", "POST", { name: `ZZ Verify ${id} vessel ${n}`, lengthFt: 50 });
    check(`create test vessel ${n}`, vessel.status === 201);
    if (vessel.data?.id) state.vesselIds.push(vessel.data.id);
  }
  save();
  if (!state.berthId || state.vesselIds.length !== 2) throw new Error("Setup failed; run cleanup.");
  const [v1, v2] = state.vesselIds;
  const booking = (vesselId, startDate, endDate) => ({ berthId: state.berthId, vesselId, title: "", startDate, endDate, notes: `ZZ Verify ${id}` });

  // 10 bookings for the same berth and days at once: the transaction must let exactly one through.
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) => call("/api/reservations", "POST", booking(i % 2 ? v2 : v1, "2099-06-10", "2099-06-12"))));
  const won = race.filter((r) => r.status === 201);
  won.forEach((r) => state.reservationIds.push(r.data.reservation.id));
  save();
  check("10 simultaneous bookings: exactly one saved", won.length === 1, `${won.length} saved`);
  check("the rest refused as conflicts (409)", race.filter((r) => r.status === 409).length === 9, race.map((r) => r.status).join(","));

  // Two separate stays edited onto the same days at once: exactly one edit may win.
  const a = await call("/api/reservations", "POST", booking(v1, "2099-07-01", "2099-07-02"));
  const b = await call("/api/reservations", "POST", booking(v2, "2099-07-05", "2099-07-06"));
  for (const r of [a, b]) if (r.status === 201) state.reservationIds.push(r.data.reservation.id);
  save();
  check("create two separate stays", a.status === 201 && b.status === 201);
  const edits = await Promise.all([
    call(`/api/reservations/${a.data.reservation.id}`, "PATCH", booking(v1, "2099-07-20", "2099-07-21")),
    call(`/api/reservations/${b.data.reservation.id}`, "PATCH", booking(v2, "2099-07-20", "2099-07-21")),
  ]);
  const editStatuses = edits.map((r) => r.status).sort().join(",");
  check("two simultaneous edits onto the same days: exactly one saved", editStatuses === "200,409", editStatuses);

  // Marker for the persistence check after a redeploy.
  const marker = await call("/api/reservations", "POST", booking(v1, "2099-09-01", "2099-09-03"));
  check("create persistence marker", marker.status === 201);
  if (marker.status === 201) {
    state.markerId = marker.data.reservation.id;
    state.reservationIds.push(state.markerId);
  }
  save();

  await signOut();
  console.log(`Saved ids to ${STATE}. Redeploy, then run "persisted", then "cleanup".`);
}

async function persisted() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  if (state.target !== target.origin) throw new Error(`${STATE} belongs to ${state.target}.`);
  const marker = await call(`/api/reservations/${state.markerId}`);
  check("marker booking survived", marker.status === 200 && marker.data?.notes === `ZZ Verify ${state.id}`, `status ${marker.status}`);
  if (!local) {
    const health = await call("/api/health");
    check("hosted storage", health.data?.storage === "remote" && health.data?.durable === true);
  }
}

async function cleanup() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  if (state.target !== target.origin) throw new Error(`${STATE} belongs to ${state.target}.`);
  await signIn();
  for (const rid of state.reservationIds) {
    const r = await call(`/api/reservations/${rid}`, "DELETE");
    check(`delete reservation ${rid}`, r.status === 200 || r.status === 404);
  }
  for (const vid of state.vesselIds) {
    const r = await call(`/api/vessels/${vid}`, "DELETE");
    check(`delete vessel ${vid}`, r.status === 200 || r.status === 404);
  }
  if (state.berthId) {
    const r = await call(`/api/berths/${state.berthId}`, "DELETE");
    check(`delete berth ${state.berthId}`, r.status === 200 || r.status === 404);
  }
  await signOut();
  if (!failures) rmSync(STATE);
}

try {
  await { run, persisted, cleanup }[phase]();
} catch (err) {
  console.log(`STOPPED ${err instanceof Error ? err.message : err}`);
  failures++;
}
console.log(`${failures} failed checks.`);
process.exitCode = failures ? 1 : 0;
