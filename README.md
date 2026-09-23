# Berth Scheduler

Take-home assignment for **Columbia Software Solutions (CSS)**.

A reservation system for a marine research waterfront. Vessels and events (a community sail day, a donor reception) reserve a berth for a range of days, and the app does the two checks the dock coordinator used to do by eye: is the berth already taken on any of those days, and does the vessel actually fit.

**Live:** https://berth-scheduler-sigma.vercel.app. Anyone can browse; making changes needs an account, which an admin invites you to.

## What it does

- **Month schedule.** Berths down the side, days across, one bar per stay, built from the same layout as the old spreadsheet.
- **Reservations for vessels and events.** A booking is a berth plus whole days, first and last day inclusive. Events use a title instead of a vessel and block a berth the same way.
- **Checks on every save.** A booking that overlaps another on the same berth, or a vessel longer than the berth, is refused with the reason. The coordinator can still save it by overriding with a written reason, which is stored and shown in the audit.
- **Spreadsheet import.** One year's sheet at a time, with a preview that lists every assumption the importer made before anything is written.
- **Audit.** One request checks the whole schedule for double-bookings, vessels that don't fit, a vessel booked at two berths at once, and bookings saved with an override.

## Running it locally

Requires Node 20.9 or newer.

```bash
npm install
cp .env.example .env.local   # then fill in the values, or set DEV_OPEN_WRITES=1 to skip sign-in locally
npm run dev
```

Open http://localhost:3000. Data is stored in `local.db` (SQLite) in the project folder, created on first use. To load the 2018 sample, use the Import page, or post it to the API:

```bash
node -e 'fetch("http://localhost:3000/api/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({csv:require("fs").readFileSync("public/sample/dock-schedule-2018.csv","utf8")})}).then(r=>r.json()).then(console.log)'
```

## Tests

```bash
npm test          # Vitest: parser, overlap rules, and database tests on real SQLite files
npm run lint
npx tsc --noEmit
npm run build
```

The database tests cover the parts that are easy to get wrong: two saves racing for the same berth (only one wins), two edits moving different stays onto the same days, confirming an imported stay, re-importing the same sheet, stays that cross into the next year's sheet, and an import that fails halfway (nothing is kept). These concurrency tests run against local SQLite files. The same checks were also run against the live deployment and its hosted Turso database: 10 bookings for the same berth and days sent at once saved exactly one and refused the other nine as conflicts, two stays moved onto the same days at once saved exactly one move, and the test data survived a redeploy.

## Deploying (Vercel + Turso)

Vercel functions have no persistent disk, so a SQLite file there would be lost. Production uses [Turso](https://turso.tech), which is hosted libSQL (SQLite compatible), so the same SQL runs in both places. The app refuses to start on Vercel without it.

1. Create the database with the Turso CLI:
   ```bash
   turso db create berth-scheduler
   turso db show --url berth-scheduler        # -> TURSO_DATABASE_URL
   turso db tokens create berth-scheduler     # -> TURSO_AUTH_TOKEN
   ```
2. Import the GitHub repo in Vercel and add these environment variables (Production), then deploy. The tables are created on first request.
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` from step 1
   - `APP_ORIGIN`: the exact production URL Vercel assigns, e.g. `https://berth-scheduler-sigma.vercel.app` (no trailing slash)
   - `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_TOKEN`: for creating the first admin, once. Make the token with `openssl rand -hex 32`.
3. Open `/api/health` on the deployment. It should report `"storage": "remote"`. The nav should show "Sign in"; if it says "View only", `APP_ORIGIN` is missing or wrong.
4. Open `/setup`, enter the setup token and that email, and choose your name and password. That creates the first admin and closes setup for good. Then remove `BOOTSTRAP_TOKEN` and `BOOTSTRAP_ADMIN_EMAIL` from Vercel.
5. Invite dispatchers from the People page, and load the 2018 sample from the Import page.

`vercel.json` runs the server functions in Tokyo (`hnd1`), next to the Turso database's region. A save makes several round trips inside one write transaction, so the functions should sit in the same region as the database; if you create the database somewhere else, change the region to match.

Preview deployments have their own URLs, so writes there are refused unless that URL is added to `APP_ORIGIN` (comma-separated).

Two scripts check a deployment:

- `node scripts/check-deployment.mjs https://<app>` sends anonymous requests only: storage is hosted, visitors are read-only, every write and every people-management route is refused without a session, and the security headers are set.
- `BERTH_EMAIL=... BERTH_PASSWORD=... node scripts/verify-live.mjs https://<app> run` signs in with a dispatcher account and uses disposable data (named "ZZ Verify…", dated 2099) to race 10 identical bookings and two conflicting edits, where exactly one may win each time. Redeploy, then run it with `persisted` to check the data survived, then `cleanup` to delete it.

## Design decisions

### Data model

| Table | Holds |
| --- | --- |
| `berths` | name, usable length in feet (optional), display order |
| `vessels` | name, length overall in feet (optional) |
| `reservations` | berth, vessel _or_ event title, first and last day, notes, override reason, and where it came from (entered here or imported, with the source cells) |
| `day_notes` | free text pinned to a day and optionally a berth, like "Fuel truck" or "Fueling @0800". Notes never block a berth. |

### Booking rules

- **Days are whole and inclusive.** Two bookings on the same berth conflict if they share any day. That includes one leaving on the 10th and another arriving on the 10th, because the data has days and not times, so the app can't tell whether the berth is clear in time. If the coordinator knows it is (departs 0800, arrival 1400), they override with that reason.
- **Fit means length overall is no more than the berth length.** If either length is unknown the booking is allowed with a warning, since most vessels in the imported history have no length yet.
- **Events** block a berth exactly like a vessel. There is no fit check for them.
- **A vessel booked at two berths on the same days** is a warning, not an error, because shifting berths mid-stay is normal.
- **Overrides need a reason.** The reason is saved with the booking and it keeps showing up in the audit.
- **Concurrent saves.** The conflict check and the write run in one SQLite write transaction, so two people saving overlapping bookings at the same moment can't both succeed. The second one waits, re-runs its checks and sees the first booking.

### Importing the spreadsheet

The export only keeps the cell where a vessel's name was typed. The merged cells that showed how long a stay lasted are gone, and there are no vessel lengths. The importer doesn't make up either.

- **Stays have known days and estimated days.** A stay is assumed to last at most until the day before the next vessel listed in the same berth row, or to the end of the month. Only the days the sheet shows are treated as known. Every imported stay starts out _unconfirmed_ until a coordinator ticks "dates confirmed".
- **Estimated days produce warnings, not errors.** A new booking that overlaps a known day of an imported stay is refused. One that only overlaps its estimated days is saved with a "possible conflict" warning.
- **Continuations across months.** A long stay is re-listed at the top of each month's grid. A vessel listed on the 1st in the same berth it held at the end of the previous month is one continuous stay. Repeat listings inside a month are separate visits. Joining adds no certainty: a stay listed on Jan 18 and re-listed on Feb 1 is known on those two days only, and the days between stay estimated.
- **Names beside the grid.** Names in column B (R/V Golden Horizon at Inner Channel, October to December) sit beside the day columns, so no day is known. They are imported as possibly there all month.
- **Text that isn't a vessel.** Anything on a berth row without a vessel prefix (R/V, OSV, F/V, M/V, S/V, M/Y, Tug, Barge) becomes a note on that berth. Rows with no berth label (rows 42, 54, 66, 78, 90 and 151 in the sample) become notes not tied to any berth, dated with the grid above them.
- **Cells past the end of a month** (row 77 has an entry under June 31) are skipped with a warning.
- **Re-importing is safe.** Each stay remembers its source cells (like `2018!T9`), so importing the same sheet again adds nothing, even after stays were edited. Stays that run into December 31 are joined with the next year's January 1 listing when that sheet is imported, in either order, again keeping only the listed days as known.
- **One year per file.** The attached sample covers 2018 only. Each year's sheet is imported separately.

Every one of these decisions is listed in the import preview as a diagnostic, with its row number, before anything is written.

## API

All endpoints take and return JSON. Errors come back as `{ "errors": [...] }`, plus `problems` for booking conflicts.

| Method and path | What it does |
| --- | --- |
| `GET /api/schedule?from=&to=` | Berths, reservations, notes and conflict ids for a date window (drives the grid) |
| `GET /api/reservations?from=&to=&berthId=&vesselId=&q=&unconfirmed=1` | List and filter reservations |
| `POST /api/reservations` | Create. `409` with `problems` if it conflicts or doesn't fit, unless `override: true` and `overrideReason` |
| `POST /api/reservations/check` | Same checks as a save, without saving (for live form feedback) |
| `GET/PATCH/DELETE /api/reservations/:id` | Read, edit (`confirmDates: true` confirms an imported stay), delete |
| `GET /api/availability?startDate=&endDate=&vesselId=` | Every berth as free, maybe or busy for those dates, plus whether the vessel fits. `lengthFt=` works for a vessel not on file |
| `GET /api/issues` | Audit of the whole schedule |
| `POST /api/import` | `{ csv, year?, dryRun? }`. With `dryRun` it returns the parsed result and diagnostics without writing |
| `GET/POST /api/berths`, `GET/PATCH/DELETE /api/berths/:id` | Manage berths (a berth with reservations can't be deleted) |
| `GET/POST /api/vessels`, `GET/PATCH/DELETE /api/vessels/:id` | Manage vessels |
| `GET/POST /api/notes`, `DELETE /api/notes/:id` | Day notes |
| `GET /api/summary`, `GET /api/health` | Counts and years with data; database reachability and storage type |
| `GET/POST/DELETE /api/session` | Who is signed in; sign in with `{ email, password }`; sign out |
| `GET/POST /api/setup` | Whether first-admin setup is open; create the first admin with the operator's token (once) |
| `GET/POST /api/invites`, `DELETE /api/invites/:id` | Admins: pending links; create an invitation or reset link; cancel one |
| `POST /api/invites/inspect`, `POST /api/invites/accept` | Who a link is for; use it to set a password and sign in |
| `GET /api/users`, `PATCH /api/users/:id` | Admins: everyone with an account; change a role, revoke or restore access |

## Accounts and security

**Anyone can view** the schedule, reservations, issues and berth availability. **Changing anything needs an account.** There are two roles: a **dispatcher** can change bookings, confirm dates, override conflicts, and edit berths, vessels, notes and imports (including the import preview). An **admin** can do all of that and also manage people. The server enforces this on every write, not just the UI. Accounts only decide *who* may write; the double-booking check still runs inside the save transaction, so two people saving at once are still protected.

**Getting people in:**

- **The first admin** is created at `/setup` with a token only the server operator knows (`BOOTSTRAP_TOKEN`) and exactly the configured email (`BOOTSTRAP_ADMIN_EMAIL`). Setup closes for good once used: a permanent marker in the database, not a count of admins. The first visitor to the site never becomes an admin.
- **Everyone else is invited** from the People page. An admin enters an email and role and gets a link to pass on (no email is sent). The link works once, expires in 72 hours, and is stored only as a hash. Its token sits after the `#`, so browsers never send it to the server as part of a URL.
- **Forgotten passwords:** an admin creates a reset link the same way. A reset changes only the password: it never changes a role or re-enables a revoked account, and it signs the person out everywhere else.
- **Revoking access** signs the person out at once and cancels their pending links. So does a role change, so an old link can't undo it.
- **There is always an admin.** The last active admin can't be demoted or revoked. To hand over: invite the new admin, then change your own role. Two admins demoting each other at the same moment can't both succeed, because the check and the change share one transaction, which also re-checks that the acting admin is still an admin.

**Under the hood:**

- Passwords are hashed with scrypt (N=2^17, r=8, p=1, the OWASP recommendation), outside any database lock. Sign-in checks a dummy hash when the email doesn't exist, so response times don't reveal which accounts exist.
- Sessions are random tokens in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` and `__Host-` prefixed in production). The database stores only a SHA-256 hash, with a 12-hour expiry. Every request re-reads the account, so revoking or demoting someone takes effect immediately, and signing out deletes the session on the server (a copied cookie stops working).
- Wrong guesses are limited in the database, shared by every server instance: 5 per account and 100 overall per 15 minutes for sign-in, and 10 for setup. Each attempt reserves its slot before the password is checked, so parallel guesses can't slip past. Someone who keeps guessing at one account can keep that account paused while they do; per-client limits need a trusted client IP.
- Every change, sign-in, sign-out, setup and link use must come from `APP_ORIGIN` (https in production), so other sites can't submit forms on someone's behalf.
- It fails closed: without a valid `APP_ORIGIN` in production, every change and sign-in is refused (503). `DEV_OPEN_WRITES=1` skips sign-in only when running `next dev`. The old `DISPATCHER_PASSCODE` and `SESSION_SECRET` are ignored, and the passcode-era session tables are dropped on upgrade, so no passcode session survives. Bookings, berths, vessels and notes are untouched.
- A test finds every data-changing handler under `src/app/api` by importing the route modules, and checks each one refuses a visitor without a session (401), a request from another origin (403), and a server without configuration (503). People-management routes are also checked to refuse dispatchers (403).
- In production, unexpected errors return a generic message; the details go to the server log. Security headers forbid framing, set `nosniff` and a strict referrer policy, and drop `X-Powered-By`. Queries are parameterised, and imports are capped at 5 MB and parsed as text.

## Not handled yet

- A history of who changed what. Accounts make it possible; bookings don't record their author yet.
- Email delivery for invitations. Admins pass links on themselves.
- Arrival and departure times, which would allow same-day turnovers without an override.
- Beam, draft and depth checks, rafting two small boats on one berth, and capacity for grouped berths like the small craft slips.
- Recurring events.
- A migration tool. The schema is created on first use, with small built-in upgrade steps (adding `known_dates`, dropping the passcode-era session tables). A real migration tool should replace that before the schema changes again.

## License

MIT. See [LICENSE](LICENSE).
