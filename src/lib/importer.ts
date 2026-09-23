// Writes a parsed spreadsheet into the database, in one transaction.
//
// * Idempotent: every imported stay and note remembers its source cells ("2018!C9").
//   A cell that was already imported is skipped, even if the stay was edited since.
// * Year boundaries: each sheet covers one year, so a stay listed on January 1 may be
//   the continuation of one imported from the previous year's sheet (and a stay that
//   runs to December 31 may continue in the next one). Unconfirmed neighbours like that
//   are joined into a single stay, whichever year is imported first.
// * Nothing imported is confirmed. See schedule-csv.ts for what that means.

import type { InStatement, Row, Transaction } from "@libsql/client";
import { addDays } from "./dates";
import { withWriteTransaction } from "./db";
import { joinDates } from "./repo";
import type { Diagnostic, ParsedReservation, ParsedSchedule } from "./schedule-csv";

export interface ImportResult {
  year: number;
  berthsCreated: number;
  vesselsCreated: number;
  reservationsAdded: number;
  reservationsJoined: number; // joined onto a stay imported from a neighbouring year
  reservationsSkipped: number; // cells already imported
  notesAdded: number;
  notesSkipped: number;
  diagnostics: Diagnostic[];
}

interface Neighbour {
  id: number;
  berthId: number;
  vesselId: number;
  startDate: string;
  endDate: string;
  knownDates: string[];
  sourceRef: string;
}

const splitRefs = (ref: unknown) =>
  String(ref ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function importSchedule(parsed: ParsedSchedule): Promise<ImportResult> {
  return withWriteTransaction(async (tx) => ({ commit: true, value: await importInto(tx, parsed) }));
}

async function idsByName(tx: Transaction, table: "berths" | "vessels"): Promise<Map<string, number>> {
  const rs = await tx.execute(`SELECT id, name FROM ${table}`);
  return new Map(rs.rows.map((r) => [String(r.name).toLowerCase(), Number(r.id)]));
}

async function importInto(tx: Transaction, parsed: ParsedSchedule): Promise<ImportResult> {
  const { year } = parsed;
  const result: ImportResult = {
    year,
    berthsCreated: 0,
    vesselsCreated: 0,
    reservationsAdded: 0,
    reservationsJoined: 0,
    reservationsSkipped: 0,
    notesAdded: 0,
    notesSkipped: 0,
    diagnostics: [...parsed.diagnostics],
  };

  // Berths and vessels are matched by name (case-insensitive); new ones are added.
  let berthIds = await idsByName(tx, "berths");
  const newBerths = parsed.berths.filter((b) => !berthIds.has(b.name.toLowerCase()));
  if (newBerths.length) {
    await tx.batch(
      newBerths.map((b) => ({
        sql: "INSERT INTO berths (name, length_ft, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM berths))",
        args: [b.name, b.lengthFt],
      })),
    );
    berthIds = await idsByName(tx, "berths");
    result.berthsCreated = newBerths.length;
  }

  let vesselIds = await idsByName(tx, "vessels");
  const newVessels = parsed.vessels.filter((name) => !vesselIds.has(name.toLowerCase()));
  if (newVessels.length) {
    await tx.batch(newVessels.map((name) => ({ sql: "INSERT INTO vessels (name) VALUES (?)", args: [name] })));
    vesselIds = await idsByName(tx, "vessels");
    result.vesselsCreated = newVessels.length;
  }

  // Imported stays that touch this year or its two boundary days: used both to skip cells
  // that were already imported and to find neighbours across December 31 / January 1.
  const nearby = await tx.execute({
    sql: `SELECT id, berth_id, vessel_id, start_date, end_date, known_dates, source_ref, confirmed
          FROM reservations WHERE source = 'import' AND end_date >= ? AND start_date <= ?`,
    args: [`${year - 1}-12-31`, `${year + 1}-01-01`],
  });
  // Source identity survives edits, including moving a stay into another year.
  // Date filtering is appropriate for joining neighbours, not deduplicating imports.
  const allImported = await tx.execute("SELECT source_ref FROM reservations WHERE source = 'import'");
  const importedCells = new Set(allImported.rows.flatMap((r) => splitRefs(r.source_ref)));
  const neighbours: Neighbour[] = nearby.rows.filter((r) => Number(r.confirmed) === 0 && r.vessel_id != null).map(toNeighbour);

  const statements: InStatement[] = [];
  for (const stay of parsed.reservations) {
    const refs = stay.cells.map((cell) => `${year}!${cell}`);
    if (refs.some((ref) => importedCells.has(ref))) {
      result.reservationsSkipped++;
      continue;
    }
    refs.forEach((ref) => importedCells.add(ref));

    const berthId = berthIds.get(stay.berthName.toLowerCase())!;
    const vesselId = vesselIds.get(stay.vesselName.toLowerCase())!;
    const same = (n: Neighbour) => n.berthId === berthId && n.vesselId === vesselId;
    const before = neighbours.find((n) => same(n) && addDays(n.endDate, 1) === stay.startDate && stay.startDate === `${year}-01-01`);
    const after = neighbours.find((n) => same(n) && addDays(stay.endDate, 1) === n.startDate && stay.endDate === `${year}-12-31`);

    if (before || after) {
      statements.push(...joinStatements(stay, refs, before, after, neighbours));
      result.reservationsJoined++;
      continue;
    }

    statements.push({
      sql: `INSERT INTO reservations (berth_id, vessel_id, title, start_date, end_date, notes, source, source_ref, confirmed, known_dates)
            VALUES (?, ?, '', ?, ?, '', 'import', ?, 0, ?)`,
      args: [berthId, vesselId, stay.startDate, stay.endDate, refs.join(", "), joinDates(stay.knownDates)],
    });
    result.reservationsAdded++;
  }

  const existingNotes = await tx.execute("SELECT source_ref FROM day_notes WHERE source = 'import'");
  const importedNoteCells = new Set(existingNotes.rows.map((r) => String(r.source_ref)));
  for (const note of parsed.notes) {
    const ref = `${year}!${note.cell}`;
    if (importedNoteCells.has(ref)) {
      result.notesSkipped++;
      continue;
    }
    importedNoteCells.add(ref);
    const berthId = note.berthName ? (berthIds.get(note.berthName.toLowerCase()) ?? null) : null;
    statements.push({
      sql: "INSERT INTO day_notes (berth_id, date, text, source, source_ref) VALUES (?, ?, ?, 'import', ?)",
      args: [berthId, note.date, note.text, ref],
    });
    result.notesAdded++;
  }

  if (statements.length) await tx.batch(statements);
  return result;
}

function toNeighbour(r: Row): Neighbour {
  return {
    id: Number(r.id),
    berthId: Number(r.berth_id),
    vesselId: Number(r.vessel_id),
    startDate: String(r.start_date),
    endDate: String(r.end_date),
    knownDates: r.known_dates ? String(r.known_dates).split(",") : [],
    sourceRef: String(r.source_ref ?? ""),
  };
}

/**
 * Join `stay` onto the unconfirmed stay that ends the day before it (from the previous
 * year's sheet) and/or the one that starts the day after it (from the next year's sheet).
 * The in-memory neighbours are updated too, so later stays in this import see the result.
 */
function joinStatements(stay: ParsedReservation, refs: string[], before: Neighbour | undefined, after: Neighbour | undefined, neighbours: Neighbour[]): InStatement[] {
  const parts = [before, { ...stay, sourceRef: refs.join(", ") }, after].filter(Boolean) as Array<{
    startDate: string;
    endDate: string;
    knownDates: string[];
    sourceRef: string;
  }>;
  const merged = {
    startDate: parts[0].startDate,
    endDate: parts[parts.length - 1].endDate,
    // Only the days each part actually showed; the join itself adds no certainty.
    knownDates: [...new Set(parts.flatMap((p) => p.knownDates))].sort(),
    sourceRef: parts.map((p) => p.sourceRef).join(", "),
  };

  const keep = (before ?? after)!;
  const statements: InStatement[] = [
    {
      sql: `UPDATE reservations SET start_date = ?, end_date = ?, known_dates = ?, source_ref = ?, updated_at = datetime('now')
            WHERE id = ?`,
      args: [merged.startDate, merged.endDate, joinDates(merged.knownDates), merged.sourceRef, keep.id],
    },
  ];
  Object.assign(keep, merged);
  if (before && after) {
    statements.push({ sql: "DELETE FROM reservations WHERE id = ?", args: [after.id] });
    neighbours.splice(neighbours.indexOf(after), 1);
  }
  return statements;
}
