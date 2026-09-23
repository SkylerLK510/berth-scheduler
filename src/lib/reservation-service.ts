// Saving a reservation = run the checks, then write. For a real save both steps run
// inside one write transaction, so two coordinators saving overlapping bookings at the
// same moment can't both pass the check: SQLite allows one writer at a time, and the
// second save re-runs its checks after the first one commits (see withWriteTransaction).

import { findProblems, hasBlockingProblems } from "./conflicts";
import { withWriteTransaction } from "./db";
import { createReservation, getBerth, getReservation, getVessel, reservationsTouching, updateReservation, type Executor } from "./repo";
import type { Berth, Problem, ReservationInput, ReservationView, Vessel } from "./types";

type Failure = { ok: false; status: 400 | 404 | 409; errors: string[]; problems: Problem[] };

export type CheckResult =
  | Failure
  | {
      ok: true;
      problems: Problem[];
      blocking: boolean;
      berth: Berth;
      vessel: Vessel | null;
      /** How the reservation would be stored: confirmed, or still carrying estimated days. */
      confirmed: boolean;
      knownDates: string[];
    };

export type SaveResult = Failure | { ok: true; reservation: ReservationView; problems: Problem[] };

const fail = (status: Failure["status"], message: string, problems: Problem[] = []): Failure => ({ ok: false, status, errors: [message], problems });

/**
 * Work out what saving `input` would mean: the problems it would cause, and whether the
 * stay stays unconfirmed. New bookings and edits with confirmDates are confirmed. Editing
 * an unconfirmed imported stay without confirming keeps it unconfirmed, with its known
 * days trimmed to the new date range.
 */
async function evaluate(conn: Executor, input: ReservationInput, id: number | null): Promise<CheckResult> {
  const berth = await getBerth(input.berthId, conn);
  if (!berth) return fail(400, "That berth doesn't exist.");
  const vessel = input.vesselId == null ? null : await getVessel(input.vesselId, conn);
  if (input.vesselId != null && !vessel) return fail(400, "That vessel doesn't exist.");
  const existing = id == null ? null : await getReservation(id, conn);
  if (id != null && !existing) return fail(404, "Reservation not found.");

  let confirmed = true;
  let knownDates: string[] = [];
  if (existing && !existing.confirmed && !input.confirmDates) {
    confirmed = false;
    // Observations identify a particular vessel at a particular berth. Moving the
    // booking cannot turn those source observations into evidence for its new assignment.
    if (existing.berthId === input.berthId && existing.vesselId === input.vesselId) {
      knownDates = existing.knownDates.filter((d) => d >= input.startDate && d <= input.endDate);
    }
  }

  const others = await reservationsTouching(
    { berthId: berth.id, vesselId: vessel?.id ?? null, startDate: input.startDate, endDate: input.endDate, excludeId: id },
    conn,
  );
  const problems = findProblems(
    {
      id,
      berthId: berth.id,
      berthName: berth.name,
      berthLengthFt: berth.lengthFt,
      vesselId: vessel?.id ?? null,
      vesselName: vessel?.name ?? null,
      vesselLengthFt: vessel?.lengthFt ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      confirmed,
      knownDates,
    },
    others,
  );
  return { ok: true, problems, blocking: hasBlockingProblems(problems), berth, vessel, confirmed, knownDates };
}

/** Dry run for the form's live feedback. Nothing is written. */
export async function checkReservation(conn: Executor, input: ReservationInput, id: number | null): Promise<CheckResult> {
  return evaluate(conn, input, id);
}

/**
 * Create (id = null) or update a reservation. Blocking problems stop the save unless
 * `input.override` is set with a reason, in which case the reason is stored with the row.
 */
export async function saveReservation(input: ReservationInput, id: number | null): Promise<SaveResult> {
  return withWriteTransaction<SaveResult>(async (tx) => {
    const check = await evaluate(tx, input, id);
    if (!check.ok) return { commit: false, value: check };
    if (check.blocking && !input.override) {
      return { commit: false, value: fail(409, "Fix the problems below or override them.", check.problems) };
    }

    const record = {
      berthId: check.berth.id,
      vesselId: check.vessel?.id ?? null,
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      notes: input.notes ?? "",
      confirmed: check.confirmed,
      knownDates: check.knownDates,
      overrideReason: check.blocking ? (input.overrideReason ?? null) : null,
    };
    const reservation = id == null ? await createReservation(record, tx) : await updateReservation(id, record, tx);
    if (!reservation) return { commit: false, value: fail(404, "Reservation not found.") };
    return { commit: true, value: { ok: true, reservation, problems: check.problems } };
  });
}
