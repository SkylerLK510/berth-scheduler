// Anonymous smoke checks only: no credentials, imports, or valid write payloads.
// Usage: node scripts/check-deployment.mjs https://your-app.vercel.app
// Local verification: append --local (does not require remote database storage).
const target = new URL(process.argv[2] ?? "http://localhost:3100");
const local = process.argv.includes("--local");
if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
  throw new Error("Provide only the app origin, without credentials, path, or query.");
}
if (target.protocol !== "https:" && !(local && target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))) {
  throw new Error("HTTPS is required except for explicit --local loopback checks.");
}
let failures = 0;
function check(label, passed) {
  console.log(`${passed ? "PASS" : "FAIL"} ${label}`);
  if (!passed) failures++;
}
async function call(path, method = "GET", origin = target.origin) {
  return fetch(new URL(path, target), {
    method, redirect: "manual", signal: AbortSignal.timeout(15000),
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}
const health = await call("/api/health");
const info = health.ok ? await health.json() : {};
check("database reachable and durable", health.status === 200 && info.ok === true && info.durable === true);
if (!local) check("hosted database storage", info.storage === "remote");
const session = await call("/api/session");
const visitor = session.ok ? await session.json() : {};
check("anonymous visitor is read-only and sign-in is configured", session.status === 200 && visitor.editing === "viewer");
check("session status cannot be cached", (session.headers.get("cache-control") ?? "").includes("no-store"));
check("security headers present", health.headers.get("x-frame-options") === "DENY" && health.headers.get("x-content-type-options") === "nosniff" && !health.headers.has("x-powered-by"));
// IDs deliberately invalid, payloads deliberately empty, in case a guard regresses.
for (const [path, methods] of [
  ["/api/berths", ["POST"]], ["/api/berths/0", ["PATCH", "DELETE"]],
  ["/api/vessels", ["POST"]], ["/api/vessels/0", ["PATCH", "DELETE"]],
  ["/api/reservations", ["POST"]], ["/api/reservations/0", ["PATCH", "DELETE"]],
  ["/api/notes", ["POST"]], ["/api/notes/0", ["DELETE"]], ["/api/import", ["POST"]],
  ["/api/users", ["GET"]], ["/api/users/0", ["PATCH"]], ["/api/invites", ["GET", "POST"]], ["/api/invites/0", ["DELETE"]],
]) {
  for (const method of methods) {
    const response = await call(path, method);
    check(`anonymous ${method} ${path} refused`, response.status === 401);
  }
}
const forged = await call("/api/session", "POST", "https://untrusted.example");
check("cross-origin sign-in refused", forged.status === 403);
const forgedSetup = await call("/api/setup", "POST", "https://untrusted.example");
check("cross-origin setup refused", forgedSetup.status === 403);
const setup = await call("/api/setup");
check("setup status readable and private", setup.status === 200 && (setup.headers.get("cache-control") ?? "").includes("no-store"));
console.log(`${failures} failed checks. This smoke check does not certify security or test concurrent saves.`);
process.exitCode = failures ? 1 : 0;
