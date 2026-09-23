// Integration tests against real SQLite files: the transactional save, two coordinators
// racing for the same berth, the confirm-dates flow, and the importer.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, resetDbForTests } from "../db";
import { importSchedule } from "../importer";
import { createBerth, createVessel, dataSummary, getReservation, listNotes, listReservations } from "../repo";
import { checkReservation, saveReservation } from "../reservation-service";
import { parseScheduleCsv } from "../schedule-csv";
import type { ReservationInput } from "../types";

const dir = mkdtempSync(join(tmpdir(), "berth-test-"));
let dbCount = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Point the app at a brand-new database file. */
function freshDb() {
  resetDbForTests(`file:${join(dir, `test-${++dbCount}.db`)}`);
}

const sampleCsv = readFileSync(join(__dirname, "../../../public/sample/dock-schedule-2018.csv"), "utf8");

describe("saveReservation", () => {
  let berthId = 0;
  let smallBerthId = 0;
  let vesselA = 0;
  let vesselB = 0;
  let longVessel = 0;

  beforeEach(async () => {
    freshDb();
    berthId = (await createBerth({ name: "North Pier East", lengthFt: 240 })).id;
    smallBerthId = (await createBerth({ name: "Inner Channel", lengthFt: 55 })).id;
    vesselA = (await createVessel({ name: "R/V Alpha", lengthFt: 200 })).id;
    vesselB = (await createVessel({ name: "OSV Beta", lengthFt: 180 })).id;
    longVessel = (await createVessel({ name: "M/V Gamma", lengthFt: 300 })).id;
  });

  const input = (overrides: Partial<ReservationInput> = {}): ReservationInput => ({
    berthId,
    vesselId: vesselA,
    title: "",
    startDate: "2026-06-10",
    endDate: "2026-06-20",
    notes: "",
    ...overrides,
  });

  /** Insert an unconfirmed imported stay directly, as the importer would. */
  async function insertImported(start: string, end: string, knownDates: string[], vesselId = vesselA) {
    const rs = await (await db()).execute({
      sql: `INSERT INTO reservations (berth_id, vessel_id, start_date, end_date, source, source_ref, confirmed, known_dates)
            VALUES (?, ?, ?, ?, 'import', '2026!C9', 0, ?) RETURNING id`,
      args: [berthId, vesselId, start, end, knownDates.join(",") || null],
    });
    return Number(rs.rows[0].id);
  }

  it("saves a clean reservation as confirmed, with no problems", async () => {
    const result = await saveReservation(input(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);
    expect(result.reservation).toMatchObject({ berthName: "North Pier East", vesselName: "R/V Alpha", confirmed: true, source: "manual" });
  });

  it("refuses a booking that overlaps by a single day, and allows the back-to-back one", async () => {
    await saveReservation(input(), null);
    const clash = await saveReservation(input({ vesselId: vesselB, startDate: "2026-06-20", endDate: "2026-06-25" }), null);
    expect(clash).toMatchObject({ ok: false, status: 409 });
    if (!clash.ok) expect(clash.problems.map((p) => p.code)).toEqual(["BERTH_CONFLICT"]);
    expect((await saveReservation(input({ vesselId: vesselB, startDate: "2026-06-21", endDate: "2026-06-25" }), null)).ok).toBe(true);
  });

  it("refuses an event on a berth that is taken, the same as a vessel", async () => {
    await saveReservation(input(), null);
    const event = await saveReservation(input({ vesselId: null, title: "Community sail day", startDate: "2026-06-14", endDate: "2026-06-14" }), null);
    expect(event).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a vessel that is too long for the berth, and records the reason when overridden", async () => {
    const tooLong = await saveReservation(input({ vesselId: longVessel }), null);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.problems.map((p) => p.code)).toEqual(["DOES_NOT_FIT"]);

    const forced = await saveReservation(input({ vesselId: longVessel, override: true, overrideReason: "stern overhang cleared with dock ops" }), null);
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.reservation.overrideReason).toBe("stern overhang cleared with dock ops");
  });

  it("lets two coordinators race for the same berth and only one wins", async () => {
    const [a, b] = await Promise.all([
      saveReservation(input({ vesselId: vesselA }), null),
      saveReservation(input({ vesselId: vesselB, startDate: "2026-06-15", endDate: "2026-06-30" }), null),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    if (!loser.ok) expect(loser.problems.map((p) => p.code)).toEqual(["BERTH_CONFLICT"]);
    expect(await listReservations({ berthId })).toHaveLength(1);
  });

  it("stays consistent under a burst of ten simultaneous overlapping creates", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => saveReservation(input({ startDate: `2026-07-${String(10 + i).padStart(2, "0")}`, endDate: "2026-07-25" }), null)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await listReservations({ berthId })).toHaveLength(1);
  });

  it("serializes two simultaneous edits that move different stays onto the same days", async () => {
    const a = await saveReservation(input({ startDate: "2026-06-01", endDate: "2026-06-05" }), null);
    const b = await saveReservation(input({ vesselId: vesselB, startDate: "2026-06-20", endDate: "2026-06-25" }), null);
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const [ea, eb] = await Promise.all([
      saveReservation(input({ startDate: "2026-06-10", endDate: "2026-06-15" }), a.reservation.id),
      saveReservation(input({ vesselId: vesselB, startDate: "2026-06-12", endDate: "2026-06-18" }), b.reservation.id),
    ]);
    expect([ea.ok, eb.ok].sort()).toEqual([false, true]);
    const rows = await listReservations({ berthId });
    expect(rows).toHaveLength(2);
    expect(rows[0].endDate < rows[1].startDate).toBe(true); // still no overlap in the table
  });

  it("checks an edit against everything except itself", async () => {
    const first = await saveReservation(input(), null);
    const second = await saveReservation(input({ vesselId: vesselB, startDate: "2026-06-21", endDate: "2026-06-25" }), null);
    if (!first.ok || !second.ok) throw new Error("setup failed");

    const extended = await saveReservation(input({ endDate: "2026-06-22" }), first.reservation.id);
    expect(extended.ok).toBe(false);
    if (!extended.ok) expect(extended.problems[0].reservationId).toBe(second.reservation.id);
    expect((await saveReservation(input(), first.reservation.id)).ok).toBe(true);
  });

  it("warns, without blocking, when the vessel is already at another berth", async () => {
    await saveReservation(input({ berthId: smallBerthId, vesselId: vesselB, override: true, overrideReason: "test setup" }), null);
    const result = await saveReservation(input({ vesselId: vesselB }), null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.problems.map((p) => p.code)).toEqual(["VESSEL_ELSEWHERE"]);
  });

  it("does not let an import's estimated days block a booking, but does let its listed day", async () => {
    await insertImported("2026-06-01", "2026-06-14", ["2026-06-01"]);
    const onTail = await saveReservation(input({ vesselId: vesselB, startDate: "2026-06-05", endDate: "2026-06-08" }), null);
    expect(onTail.ok).toBe(true);
    if (onTail.ok) expect(onTail.problems.map((p) => p.code)).toEqual(["POSSIBLE_CONFLICT"]);

    const onListedDay = await saveReservation(input({ vesselId: vesselB, startDate: "2026-05-30", endDate: "2026-06-01" }), null);
    expect(onListedDay.ok).toBe(false);
  });

  it("keeps an imported stay unconfirmed through ordinary edits, and confirms it only when asked", async () => {
    const id = await insertImported("2026-07-01", "2026-07-09", ["2026-07-01"]);
    expect((await dataSummary()).unconfirmed).toBe(1);

    const edited = await saveReservation(input({ startDate: "2026-07-01", endDate: "2026-07-09", notes: "moved fenders" }), id);
    expect(edited.ok).toBe(true);
    let row = await getReservation(id);
    expect(row).toMatchObject({ confirmed: false, knownDates: ["2026-07-01"], notes: "moved fenders", sourceRef: "2026!C9" });

    const confirmed = await saveReservation(input({ startDate: "2026-07-01", endDate: "2026-07-05", confirmDates: true }), id);
    expect(confirmed.ok).toBe(true);
    row = await getReservation(id);
    expect(row).toMatchObject({ confirmed: true, knownDates: [], endDate: "2026-07-05", source: "import", sourceRef: "2026!C9" });
    expect((await dataSummary()).unconfirmed).toBe(0);
  });

  it("dry-run checks never write", async () => {
    const check = await checkReservation(await db(), input(), null);
    expect(check).toMatchObject({ ok: true, blocking: false, confirmed: true });
    expect(await listReservations()).toHaveLength(0);
  });
});

describe("importSchedule", () => {
  beforeEach(() => freshDb());

  it("loads the 2018 sample as unconfirmed stays, with notes, and is idempotent", async () => {
    const parsed = parseScheduleCsv(sampleCsv);
    const first = await importSchedule(parsed);
    expect(first).toMatchObject({ year: 2018, berthsCreated: 8, vesselsCreated: 23, reservationsAdded: 70, reservationsSkipped: 0, notesAdded: 33 });

    const summary = await dataSummary();
    expect(summary).toMatchObject({ reservations: 70, unconfirmed: 70, berths: 8, vessels: 23, vesselsWithoutLength: 23, years: [2018] });

    const compass = (await listReservations({ q: "GOLDEN COMPASS", from: "2018-01-18", to: "2018-01-18" }))[0];
    expect(compass).toMatchObject({ startDate: "2018-01-18", endDate: "2018-04-12", knownDates: ["2018-01-18", "2018-02-01", "2018-03-01", "2018-04-01"], confirmed: false, source: "import" });
    expect(compass.sourceRef).toBe("2018!T9, 2018!C21, 2018!C33, 2018!C45");

    const unassigned = (await listNotes("2018-01-01", "2018-12-31")).filter((n) => n.berthId === null);
    expect(unassigned.length).toBe(28);

    const again = await importSchedule(parseScheduleCsv(sampleCsv));
    expect(again).toMatchObject({ berthsCreated: 0, vesselsCreated: 0, reservationsAdded: 0, reservationsSkipped: 70, notesAdded: 0, notesSkipped: 33 });
    expect((await dataSummary()).reservations).toBe(70);
  });

  it("does not re-add a stay that was edited or confirmed after the first import", async () => {
    await importSchedule(parseScheduleCsv(sampleCsv));
    const stay = (await listReservations({ q: "Far Tide" }))[0];
    const saved = await saveReservation(
      { berthId: stay.berthId, vesselId: stay.vesselId, title: "", startDate: stay.startDate, endDate: "2018-01-15", confirmDates: true },
      stay.id,
    );
    expect(saved.ok).toBe(true);
    const again = await importSchedule(parseScheduleCsv(sampleCsv));
    expect(again.reservationsAdded).toBe(0);
    expect(await listReservations({ q: "Far Tide" })).toHaveLength(1);
  });

  // R/V GOLDEN COMPASS is listed at North Pier West on Dec 1 2018 (cell C142) and runs to the
  // end of the 2018 sheet. The 2019 sheet below lists it again on Jan 1 (cell C6).
  const days31 = Array.from({ length: 31 }, (_, i) => i + 1).join(",");
  const next = [
    "Harborview Marine Research Center",
    "2019 Pier & Dock Schedule",
    "",
    `January,,${days31}`,
    ",,T,W,TR",
    `North Pier West - 410',,R/V GOLDEN COMPASS${",".repeat(17)}Tug BLUE FATHOM`,
  ].join("\n");

  it("joins a stay that crosses into the next year's sheet, whichever sheet is imported first", async () => {
    const expected = { startDate: "2018-12-01", endDate: "2019-01-17", knownDates: ["2018-12-01", "2019-01-01"], confirmed: false };

    await importSchedule(parseScheduleCsv(sampleCsv));
    const joined = await importSchedule(parseScheduleCsv(next));
    expect(joined).toMatchObject({ reservationsAdded: 1, reservationsJoined: 1 }); // the tug is new, the Compass is joined
    let compass = await listReservations({ q: "GOLDEN COMPASS", from: "2018-12-31", to: "2019-01-01" });
    expect(compass).toHaveLength(1);
    expect(compass[0]).toMatchObject(expected);
    expect(compass[0].sourceRef).toBe("2018!C142, 2019!C6");

    // re-importing either sheet changes nothing
    expect(await importSchedule(parseScheduleCsv(next))).toMatchObject({ reservationsAdded: 0, reservationsJoined: 0, reservationsSkipped: 2 });
    expect(await importSchedule(parseScheduleCsv(sampleCsv))).toMatchObject({ reservationsAdded: 0, reservationsJoined: 0 });

    // same result the other way round
    freshDb();
    await importSchedule(parseScheduleCsv(next));
    expect(await importSchedule(parseScheduleCsv(sampleCsv))).toMatchObject({ reservationsAdded: 69, reservationsJoined: 1 });
    compass = await listReservations({ q: "GOLDEN COMPASS", from: "2018-12-31", to: "2019-01-01" });
    expect(compass).toHaveLength(1);
    expect(compass[0]).toMatchObject(expected);
  });

  it("adds no certainty when joining across the year: days between the Dec 1 and Jan 1 listings stay estimated, even after an edit", async () => {
    await importSchedule(parseScheduleCsv(sampleCsv));
    await importSchedule(parseScheduleCsv(next));
    const [compass] = await listReservations({ q: "GOLDEN COMPASS", from: "2018-12-31", to: "2019-01-01" });
    const sailDay = { berthId: compass.berthId, vesselId: null, title: "Community sail day", startDate: "2018-12-15", endDate: "2018-12-15" };

    const inGap = await saveReservation(sailDay, null);
    expect(inGap.ok).toBe(true);
    if (inGap.ok) expect(inGap.problems.map((p) => p.code)).toEqual(["POSSIBLE_CONFLICT"]);
    expect((await saveReservation({ ...sailDay, startDate: "2019-01-01", endDate: "2019-01-01" }, null)).ok).toBe(false); // a listed day

    // shorten the stay without confirming: known days outside the new range drop, the rest stay, and re-importing adds nothing
    const edited = await saveReservation({ berthId: compass.berthId, vesselId: compass.vesselId, title: "", startDate: "2018-12-01", endDate: "2018-12-31" }, compass.id);
    expect(edited.ok).toBe(true);
    expect(await getReservation(compass.id)).toMatchObject({ confirmed: false, knownDates: ["2018-12-01"], sourceRef: "2018!C142, 2019!C6" });
    expect(await importSchedule(parseScheduleCsv(sampleCsv))).toMatchObject({ reservationsAdded: 0, reservationsJoined: 0 });
    expect(await importSchedule(parseScheduleCsv(next))).toMatchObject({ reservationsAdded: 0, reservationsJoined: 0 });
  });

  it("rolls back completely if any statement fails", async () => {
    const parsed = parseScheduleCsv(sampleCsv);
    // an invalid stay (end before start) violates a CHECK constraint half-way through the batch
    parsed.reservations.splice(35, 0, { ...parsed.reservations[0], startDate: "2018-06-10", endDate: "2018-06-01", cells: ["ZZ999"] });
    await expect(importSchedule(parsed)).rejects.toThrow();
    const summary = await dataSummary();
    expect(summary).toMatchObject({ reservations: 0, berths: 0, vessels: 0 });
  });
});

describe("schema migration", () => {
  it("gives legacy unconfirmed stays no known dates, since the old range may include gaps and edited ends", async () => {
    const url = `file:${join(dir, "old-schema.db")}`;
    const old = createClient({ url });
    await old.executeMultiple(`
      CREATE TABLE berths (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, length_ft REAL, sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '');
      CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, berth_id INTEGER NOT NULL, vessel_id INTEGER, title TEXT NOT NULL DEFAULT '',
        start_date TEXT NOT NULL, end_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT,
        confirmed INTEGER NOT NULL DEFAULT 1, known_start TEXT, known_end TEXT, override_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO berths (name) VALUES ('North Pier West');
      INSERT INTO reservations (berth_id, title, start_date, end_date, source, confirmed, known_start, known_end)
        VALUES (1, 'joined', '2018-01-18', '2018-04-12', 'import', 0, '2018-01-18', '2018-04-01'),
               (1, 'single', '2018-05-01', '2018-05-09', 'import', 0, '2018-05-01', '2018-05-01'),
               (1, 'none', '2018-06-01', '2018-06-30', 'import', 0, NULL, NULL);
    `);
    old.close();

    resetDbForTests(url);
    const byTitle = new Map((await listReservations()).map((r) => [r.title, r.knownDates]));
    expect([...byTitle.values()]).toEqual([[], [], []]);
    // so a booking inside the old range is a possible conflict, never a definite one
    const check = await checkReservation(await db(), { berthId: 1, vesselId: null, title: "Sail day", startDate: "2018-01-25", endDate: "2018-01-25" }, null);
    expect(check.ok && check.problems.map((p) => p.code)).toEqual(["POSSIBLE_CONFLICT"]);
  });
});
