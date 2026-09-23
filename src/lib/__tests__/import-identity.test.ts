import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, resetDbForTests } from "../db";
import { importSchedule } from "../importer";
import { listReservations } from "../repo";
import { saveReservation } from "../reservation-service";
import { parseScheduleCsv } from "../schedule-csv";
const dir = mkdtempSync(join(tmpdir(), "berth-import-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it("keeps source identity when imported stays and notes move outside their original year", async () => {
  resetDbForTests(`file:${join(dir, "test.db")}`);
  const parsed = parseScheduleCsv(readFileSync(join(__dirname, "../../../public/sample/dock-schedule-2018.csv"), "utf8"));
  await importSchedule(parsed);
  const [stay] = await listReservations({});
  const saved = await saveReservation({ berthId: stay.berthId, vesselId: stay.vesselId, title: stay.title,
    startDate: "2026-01-01", endDate: "2026-01-02" }, stay.id);
  expect(saved.ok).toBe(true);
  await (await db()).execute("UPDATE day_notes SET date = '2026-01-01' WHERE source = 'import'");
  const result = await importSchedule(parsed);
  expect(result.reservationsAdded).toBe(0);
  expect(result.reservationsSkipped).toBe(parsed.reservations.length);
  expect(result.notesAdded).toBe(0);
  expect(result.notesSkipped).toBe(parsed.notes.length);
});
