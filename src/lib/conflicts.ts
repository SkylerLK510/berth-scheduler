// The two checks the dock coordinator used to do by eye:
//   1. is this berth already taken on any of these days? (double-booking)
//   2. is the vessel short enough for the berth? (fit)
// These are pure functions so they are easy to unit test; the service layer feeds
// them the relevant rows from the database.
//
// Imported stays complicate (1): the old spreadsheet only records the day a vessel
// was listed, so part of each imported stay is a guess. A clash on days the sheet
// actually shows is a real conflict; a clash that only touches guessed days is
// reported as a possible conflict instead of blocking the booking.

import { addDays, formatRange } from "./dates";
import type { Problem, ReservationView } from "./types";

export interface DateRange {
  start: string;
  end: string;
}

/** Inclusive ranges overlap when each one starts no later than the other ends. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** The fields the overlap rules need. Anything not marked unconfirmed counts as confirmed. */
export interface Stay {
  startDate: string;
  endDate: string;
  confirmed?: boolean;
  /** For unconfirmed stays, the individual days the sheet shows the vessel there. */
  knownDates?: string[];
}

/** Sorted, de-duplicated dates -> runs of consecutive days. */
export function dateRuns(dates: string[]): DateRange[] {
  const runs: DateRange[] = [];
  for (const d of [...new Set(dates)].sort()) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.end, 1) === d) last.end = d;
    else runs.push({ start: d, end: d });
  }
  return runs;
}

/**
 * Days the stay certainly occupies: all of them once confirmed, otherwise only the days the
 * sheet showed. A stay listed on Jan 18 and again on Feb 1 is certain on those two days only,
 * not on everything in between.
 */
export function certainDays(stay: Stay): DateRange[] {
  if (stay.confirmed !== false) return [{ start: stay.startDate, end: stay.endDate }];
  return dateRuns((stay.knownDates ?? []).filter((d) => d >= stay.startDate && d <= stay.endDate));
}

/** True when some of the stay's days are estimates rather than known. */
export function hasEstimatedDays(stay: Stay): boolean {
  const known = certainDays(stay);
  return known.length !== 1 || known[0].start !== stay.startDate || known[0].end !== stay.endDate;
}

export type Overlap = "none" | "definite" | "possible";

/** Exact shared known days, without filling gaps between spreadsheet observations. */
export function certainOverlapDays(a: Stay, b: Stay): DateRange[] {
  const intersections: DateRange[] = [];
  const right = certainDays(b);
  for (const x of certainDays(a)) {
    for (const y of right) {
      if (rangesOverlap(x, y)) {
        intersections.push({ start: x.start > y.start ? x.start : y.start, end: x.end < y.end ? x.end : y.end });
      }
    }
  }
  return intersections;
}

/**
 * "definite" when a certain day of one stay is a certain day of the other, "possible" when the
 * date ranges overlap only through estimated days, "none" when they don't touch at all.
 */
export function classifyOverlap(a: Stay, b: Stay): Overlap {
  if (!rangesOverlap({ start: a.startDate, end: a.endDate }, { start: b.startDate, end: b.endDate })) return "none";
  const cb = certainDays(b);
  return certainDays(a).some((x) => cb.some((y) => rangesOverlap(x, y))) ? "definite" : "possible";
}

export type FitStatus = "fits" | "too_long" | "unknown";

export function checkFit(vesselLengthFt: number | null, berthLengthFt: number | null): FitStatus {
  if (vesselLengthFt == null || berthLengthFt == null) return "unknown";
  return vesselLengthFt <= berthLengthFt ? "fits" : "too_long";
}

/** The reservation being checked (an unsaved draft or an edit). */
export interface Candidate extends Stay {
  id?: number | null; // present when editing, so it doesn't conflict with itself
  berthId: number;
  berthName: string;
  berthLengthFt: number | null;
  vesselId: number | null;
  vesselName: string | null;
  vesselLengthFt: number | null;
}

function describe(r: ReservationView): string {
  const who = r.vesselName ?? r.title;
  return `${who} (${formatRange(r.startDate, r.endDate)}${hasEstimatedDays(r) ? ", dates partly estimated" : ""})`;
}

/**
 * Compare a candidate reservation against the existing reservations that could
 * possibly clash with it (same berth, or same vessel) and list every problem found.
 */
export function findProblems(candidate: Candidate, existing: ReservationView[]): Problem[] {
  const problems: Problem[] = [];

  for (const other of existing) {
    if (candidate.id != null && other.id === candidate.id) continue;
    const overlap = classifyOverlap(candidate, other);
    if (overlap === "none") continue;

    if (other.berthId === candidate.berthId) {
      problems.push(
        overlap === "definite"
          ? {
              code: "BERTH_CONFLICT",
              severity: "error",
              message: `${candidate.berthName} is already booked by ${describe(other)}`,
              reservationId: other.id,
            }
          : {
              code: "POSSIBLE_CONFLICT",
              severity: "warning",
              message: `${candidate.berthName} may be double-booked with ${describe(other)}. The overlap is only on dates estimated from the spreadsheet, so check them.`,
              reservationId: other.id,
            },
      );
    } else if (candidate.vesselId != null && other.vesselId === candidate.vesselId) {
      problems.push({
        code: "VESSEL_ELSEWHERE",
        severity: "warning",
        message:
          overlap === "definite"
            ? `${candidate.vesselName} is also booked at ${other.berthName} (${formatRange(other.startDate, other.endDate)})`
            : `${candidate.vesselName} may still be at ${other.berthName} (${formatRange(other.startDate, other.endDate)}, dates partly estimated)`,
        reservationId: other.id,
      });
    }
  }

  if (candidate.vesselId != null) {
    const fit = checkFit(candidate.vesselLengthFt, candidate.berthLengthFt);
    if (fit === "too_long") {
      problems.push({
        code: "DOES_NOT_FIT",
        severity: "error",
        message: `${candidate.vesselName} is ${candidate.vesselLengthFt}' but ${candidate.berthName} is only ${candidate.berthLengthFt}'`,
      });
    } else if (fit === "unknown") {
      const missing =
        candidate.vesselLengthFt == null
          ? `${candidate.vesselName} has no length on record`
          : `${candidate.berthName} has no length on record`;
      problems.push({ code: "FIT_UNKNOWN", severity: "warning", message: `Can't check fit: ${missing}` });
    }
  }

  return problems;
}

export function hasBlockingProblems(problems: Problem[]): boolean {
  return problems.some((p) => p.severity === "error");
}

// ---- whole-schedule audit ----------------------------------------------------

export interface OverlapPair {
  a: ReservationView;
  b: ReservationView;
  overlap: "definite" | "possible";
}

function groupBy<K>(items: ReservationView[], key: (r: ReservationView) => K): Map<K, ReservationView[]> {
  const groups = new Map<K, ReservationView[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

function overlappingPairs(groups: Map<unknown, ReservationView[]>, include: (a: ReservationView, b: ReservationView) => boolean): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (const group of groups.values()) {
    const list = [...group].sort((x, y) => x.startDate.localeCompare(y.startDate) || x.id - y.id);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // sorted by start, so once j starts after i ends nothing later can overlap i
        if (list[j].startDate > list[i].endDate) break;
        if (!include(list[i], list[j])) continue;
        const overlap = classifyOverlap(list[i], list[j]);
        if (overlap !== "none") pairs.push({ a: list[i], b: list[j], overlap });
      }
    }
  }
  return pairs;
}

/**
 * Every pair of reservations that share a berth on overlapping days. This is the
 * check that used to be done by scanning the grid. O(n^2) per berth in the worst
 * case, which is fine for a few hundred bookings a year.
 */
export function findDoubleBookings(reservations: ReservationView[]): OverlapPair[] {
  return overlappingPairs(groupBy(reservations, (r) => r.berthId), () => true);
}

/** A vessel booked at two different berths on overlapping days. */
export function findVesselsInTwoPlaces(reservations: ReservationView[]): OverlapPair[] {
  const withVessel = reservations.filter((r) => r.vesselId != null);
  return overlappingPairs(groupBy(withVessel, (r) => r.vesselId), (a, b) => a.berthId !== b.berthId);
}
