// All SQL for berths, vessels, reservations and notes lives here. The API routes
// and services call these functions and never build queries themselves.
//
// Functions that may run inside a transaction take an optional `conn`; without it
// they use the shared client.

import type { InArgs, Row, Transaction } from "@libsql/client";
import { db } from "./db";
import type { Berth, DayNote, Reservation, ReservationView, Vessel } from "./types";

/** Anything that can run a statement: the shared client, or an open transaction. */
export type Executor = Pick<Transaction, "execute">;

async function executor(conn?: Executor): Promise<Executor> {
  return conn ?? (await db());
}

// ---- row mapping -----------------------------------------------------------

const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? "" : String(v));
const strOrNull = (v: unknown) => (v == null ? null : String(v));
/** known_dates is stored as comma-separated ISO dates. */
const splitDates = (v: unknown) => (v ? String(v).split(",").filter(Boolean) : []);
export const joinDates = (dates: string[]) => (dates.length ? [...new Set(dates)].sort().join(",") : null);

function toBerth(r: Row): Berth {
  return { id: Number(r.id), name: str(r.name), lengthFt: num(r.length_ft), sortOrder: Number(r.sort_order), notes: str(r.notes) };
}

function toVessel(r: Row): Vessel {
  return { id: Number(r.id), name: str(r.name), lengthFt: num(r.length_ft), notes: str(r.notes) };
}

function toReservation(r: Row): ReservationView {
  return {
    id: Number(r.id),
    berthId: Number(r.berth_id),
    vesselId: num(r.vessel_id),
    title: str(r.title),
    startDate: str(r.start_date),
    endDate: str(r.end_date),
    notes: str(r.notes),
    source: str(r.source) as Reservation["source"],
    sourceRef: strOrNull(r.source_ref),
    confirmed: Number(r.confirmed) === 1,
    knownDates: splitDates(r.known_dates),
    overrideReason: strOrNull(r.override_reason),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    berthName: str(r.berth_name),
    berthLengthFt: num(r.berth_length_ft),
    vesselName: strOrNull(r.vessel_name),
    vesselLengthFt: num(r.vessel_length_ft),
  };
}

function toNote(r: Row): DayNote {
  return {
    id: Number(r.id),
    berthId: num(r.berth_id),
    date: str(r.date),
    text: str(r.text),
    source: str(r.source) as DayNote["source"],
    sourceRef: strOrNull(r.source_ref),
  };
}

const RESERVATION_SELECT = `
  SELECT r.*, b.name AS berth_name, b.length_ft AS berth_length_ft,
         v.name AS vessel_name, v.length_ft AS vessel_length_ft
  FROM reservations r
  JOIN berths b ON b.id = r.berth_id
  LEFT JOIN vessels v ON v.id = r.vessel_id`;

// ---- berths ----------------------------------------------------------------

export async function listBerths(conn?: Executor): Promise<Berth[]> {
  const rs = await (await executor(conn)).execute("SELECT * FROM berths ORDER BY sort_order, id");
  return rs.rows.map(toBerth);
}

export async function getBerth(id: number, conn?: Executor): Promise<Berth | null> {
  const rs = await (await executor(conn)).execute({ sql: "SELECT * FROM berths WHERE id = ?", args: [id] });
  return rs.rows[0] ? toBerth(rs.rows[0]) : null;
}

export interface BerthInput {
  name: string;
  lengthFt: number | null;
  notes?: string;
  sortOrder?: number;
}

export async function createBerth(input: BerthInput): Promise<Berth> {
  const rs = await (await db()).execute({
    sql: `INSERT INTO berths (name, length_ft, sort_order, notes)
          VALUES (?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM berths)), ?) RETURNING *`,
    args: [input.name, input.lengthFt, input.sortOrder ?? null, input.notes ?? ""],
  });
  return toBerth(rs.rows[0]);
}

export async function updateBerth(id: number, input: BerthInput): Promise<Berth | null> {
  const rs = await (await db()).execute({
    sql: "UPDATE berths SET name = ?, length_ft = ?, notes = ?, sort_order = COALESCE(?, sort_order) WHERE id = ? RETURNING *",
    args: [input.name, input.lengthFt, input.notes ?? "", input.sortOrder ?? null, id],
  });
  return rs.rows[0] ? toBerth(rs.rows[0]) : null;
}

/** Deletes a berth that has no reservations. Its notes go with it. */
export async function deleteBerth(id: number): Promise<{ deleted: boolean; reservations: number }> {
  const conn = await db();
  const count = Number((await conn.execute({ sql: "SELECT COUNT(*) AS n FROM reservations WHERE berth_id = ?", args: [id] })).rows[0].n);
  if (count > 0) return { deleted: false, reservations: count };
  const [, rs] = await conn.batch(
    [
      { sql: "DELETE FROM day_notes WHERE berth_id = ? AND NOT EXISTS (SELECT 1 FROM reservations WHERE berth_id = ?)", args: [id, id] },
      { sql: "DELETE FROM berths WHERE id = ? AND NOT EXISTS (SELECT 1 FROM reservations WHERE berth_id = ?)", args: [id, id] },
    ],
    "write",
  );
  return { deleted: rs.rowsAffected > 0, reservations: 0 };
}

// ---- vessels ---------------------------------------------------------------

export async function listVessels(conn?: Executor): Promise<Vessel[]> {
  const rs = await (await executor(conn)).execute("SELECT * FROM vessels ORDER BY name COLLATE NOCASE");
  return rs.rows.map(toVessel);
}

export async function getVessel(id: number, conn?: Executor): Promise<Vessel | null> {
  const rs = await (await executor(conn)).execute({ sql: "SELECT * FROM vessels WHERE id = ?", args: [id] });
  return rs.rows[0] ? toVessel(rs.rows[0]) : null;
}

export interface VesselInput {
  name: string;
  lengthFt: number | null;
  notes?: string;
}

export async function createVessel(input: VesselInput): Promise<Vessel> {
  const rs = await (await db()).execute({
    sql: "INSERT INTO vessels (name, length_ft, notes) VALUES (?, ?, ?) RETURNING *",
    args: [input.name, input.lengthFt, input.notes ?? ""],
  });
  return toVessel(rs.rows[0]);
}

export async function updateVessel(id: number, input: VesselInput): Promise<Vessel | null> {
  const rs = await (await db()).execute({
    sql: "UPDATE vessels SET name = ?, length_ft = ?, notes = ? WHERE id = ? RETURNING *",
    args: [input.name, input.lengthFt, input.notes ?? "", id],
  });
  return rs.rows[0] ? toVessel(rs.rows[0]) : null;
}

/** Deletes a vessel that has no reservations. */
export async function deleteVessel(id: number): Promise<{ deleted: boolean; reservations: number }> {
  const conn = await db();
  const count = Number((await conn.execute({ sql: "SELECT COUNT(*) AS n FROM reservations WHERE vessel_id = ?", args: [id] })).rows[0].n);
  if (count > 0) return { deleted: false, reservations: count };
  const rs = await conn.execute({
    sql: "DELETE FROM vessels WHERE id = ? AND NOT EXISTS (SELECT 1 FROM reservations WHERE vessel_id = ?)",
    args: [id, id],
  });
  return { deleted: rs.rowsAffected > 0, reservations: 0 };
}

// ---- reservations ----------------------------------------------------------

export interface ReservationFilter {
  from?: string; // include reservations that touch [from, to]
  to?: string;
  berthId?: number;
  vesselId?: number;
  q?: string; // matches vessel name or title
  /** Only imported stays whose dates nobody has confirmed yet. */
  unconfirmed?: boolean;
}

export async function listReservations(filter: ReservationFilter = {}): Promise<ReservationView[]> {
  const where: string[] = [];
  const args: InArgs = [];
  if (filter.from) {
    where.push("r.end_date >= ?");
    args.push(filter.from);
  }
  if (filter.to) {
    where.push("r.start_date <= ?");
    args.push(filter.to);
  }
  if (filter.berthId != null) {
    where.push("r.berth_id = ?");
    args.push(filter.berthId);
  }
  if (filter.vesselId != null) {
    where.push("r.vessel_id = ?");
    args.push(filter.vesselId);
  }
  if (filter.q) {
    where.push("(v.name LIKE ? OR r.title LIKE ?)");
    args.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  if (filter.unconfirmed) where.push("r.confirmed = 0");
  const sql = `${RESERVATION_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.start_date, b.sort_order, r.id`;
  const rs = await (await db()).execute({ sql, args });
  return rs.rows.map(toReservation);
}

export async function getReservation(id: number, conn?: Executor): Promise<ReservationView | null> {
  const rs = await (await executor(conn)).execute({ sql: `${RESERVATION_SELECT} WHERE r.id = ?`, args: [id] });
  return rs.rows[0] ? toReservation(rs.rows[0]) : null;
}

/**
 * Everything that could clash with a reservation on `berthId` (or, for a vessel,
 * anywhere else) during [start, end]. The conflict rules themselves live in conflicts.ts.
 */
export async function reservationsTouching(
  params: { berthId: number; vesselId: number | null; startDate: string; endDate: string; excludeId?: number | null },
  conn?: Executor,
): Promise<ReservationView[]> {
  const args: InArgs = [params.startDate, params.endDate, params.berthId];
  let sql = `${RESERVATION_SELECT} WHERE r.end_date >= ? AND r.start_date <= ? AND (r.berth_id = ?`;
  if (params.vesselId != null) {
    sql += " OR r.vessel_id = ?";
    args.push(params.vesselId);
  }
  sql += ")";
  if (params.excludeId != null) {
    sql += " AND r.id <> ?";
    args.push(params.excludeId);
  }
  const rs = await (await executor(conn)).execute({ sql, args });
  return rs.rows.map(toReservation);
}

export interface ReservationRecord {
  berthId: number;
  vesselId: number | null;
  title: string;
  startDate: string;
  endDate: string;
  notes: string;
  confirmed: boolean;
  knownDates: string[];
  overrideReason: string | null;
}

/** Inserts a reservation entered through the app. Imported stays are written by importer.ts. */
export async function createReservation(input: ReservationRecord, conn?: Executor): Promise<ReservationView> {
  const c = await executor(conn);
  const rs = await c.execute({
    sql: `INSERT INTO reservations (berth_id, vessel_id, title, start_date, end_date, notes, source, confirmed, known_dates, override_reason)
          VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?) RETURNING id`,
    args: [
      input.berthId,
      input.vesselId,
      input.title,
      input.startDate,
      input.endDate,
      input.notes,
      input.confirmed ? 1 : 0,
      joinDates(input.knownDates),
      input.overrideReason,
    ],
  });
  return (await getReservation(Number(rs.rows[0].id), c))!;
}

/** Updates a reservation. source and source_ref are kept, so an imported stay remembers where it came from. */
export async function updateReservation(id: number, input: ReservationRecord, conn?: Executor): Promise<ReservationView | null> {
  const c = await executor(conn);
  const rs = await c.execute({
    sql: `UPDATE reservations
          SET berth_id = ?, vessel_id = ?, title = ?, start_date = ?, end_date = ?, notes = ?,
              confirmed = ?, known_dates = ?, override_reason = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      input.berthId,
      input.vesselId,
      input.title,
      input.startDate,
      input.endDate,
      input.notes,
      input.confirmed ? 1 : 0,
      joinDates(input.knownDates),
      input.overrideReason,
      id,
    ],
  });
  return rs.rowsAffected > 0 ? getReservation(id, c) : null;
}

export async function deleteReservation(id: number): Promise<boolean> {
  const rs = await (await db()).execute({ sql: "DELETE FROM reservations WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}

// ---- day notes -------------------------------------------------------------

export async function listNotes(from: string, to: string): Promise<DayNote[]> {
  const rs = await (await db()).execute({
    sql: "SELECT * FROM day_notes WHERE date >= ? AND date <= ? ORDER BY date, id",
    args: [from, to],
  });
  return rs.rows.map(toNote);
}

export async function createNote(input: { berthId: number | null; date: string; text: string }): Promise<DayNote> {
  const rs = await (await db()).execute({
    sql: "INSERT INTO day_notes (berth_id, date, text, source) VALUES (?, ?, ?, 'manual') RETURNING *",
    args: [input.berthId, input.date, input.text],
  });
  return toNote(rs.rows[0]);
}

export async function deleteNote(id: number): Promise<boolean> {
  const rs = await (await db()).execute({ sql: "DELETE FROM day_notes WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}

// ---- summary ---------------------------------------------------------------

export interface DataSummary {
  reservations: number;
  /** Imported stays whose dates nobody has confirmed yet. */
  unconfirmed: number;
  berths: number;
  vessels: number;
  vesselsWithoutLength: number;
  /** Years that have at least one reservation, ascending. */
  years: number[];
}

export async function dataSummary(): Promise<DataSummary> {
  const conn = await db();
  const counts = (
    await conn.execute(`
      SELECT (SELECT COUNT(*) FROM reservations) AS reservations,
             (SELECT COUNT(*) FROM reservations WHERE confirmed = 0) AS unconfirmed,
             (SELECT COUNT(*) FROM berths) AS berths,
             (SELECT COUNT(*) FROM vessels) AS vessels,
             (SELECT COUNT(*) FROM vessels WHERE length_ft IS NULL) AS vessels_without_length`)
  ).rows[0];
  const years = await conn.execute(`
    SELECT CAST(substr(start_date, 1, 4) AS INTEGER) AS y FROM reservations
    UNION SELECT CAST(substr(end_date, 1, 4) AS INTEGER) FROM reservations
    ORDER BY y`);
  return {
    reservations: Number(counts.reservations),
    unconfirmed: Number(counts.unconfirmed),
    berths: Number(counts.berths),
    vessels: Number(counts.vessels),
    vesselsWithoutLength: Number(counts.vessels_without_length),
    years: years.rows.map((r) => Number(r.y)),
  };
}
