import { afterAll, expect, it } from "vitest";
import { resetDbForTests, db } from "../db";
import { createBerth, createVessel } from "../repo";
import { saveReservation } from "../reservation-service";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "berth-assignment-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it.each(["berth", "vessel", "event", "unchanged"])("keeps observations tied to source assignment: %s", async (change) => {
  resetDbForTests(`file:${join(dir, `${change}.db`)}`);
  const a = await createBerth({ name: "A", lengthFt: 100 });
  const b = await createBerth({ name: "B", lengthFt: 100 });
  const v = await createVessel({ name: "Boat", lengthFt: 50 });
  const w = await createVessel({ name: "Other boat", lengthFt: 50 });
  const row = await (await db()).execute({
    sql: "INSERT INTO reservations(berth_id,vessel_id,start_date,end_date,confirmed,known_dates,source,source_ref) VALUES(?,?,'2018-01-01','2018-01-05',0,'2018-01-01','import','2018!C9') RETURNING id",
    args: [a.id, v.id],
  });
  const result = await saveReservation({ berthId: change === "berth" ? b.id : a.id,
    vesselId: change === "event" ? null : change === "vessel" ? w.id : v.id,
    title: change === "event" ? "Sail day" : "", startDate: "2018-01-01", endDate: "2018-01-05" }, Number(row.rows[0].id));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.reservation.knownDates).toEqual(change === "unchanged" ? ["2018-01-01"] : []);
  expect(result.reservation.confirmed).toBe(false);
  expect(result.reservation.sourceRef).toBe("2018!C9");
});
