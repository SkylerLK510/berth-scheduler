// Shared domain types used by the database layer, the API routes and the UI.

export interface Berth {
  id: number;
  name: string;
  /** Usable length in feet. null = not recorded (e.g. a group of small-craft slips). */
  lengthFt: number | null;
  sortOrder: number;
  notes: string;
}

export interface Vessel {
  id: number;
  name: string;
  /** Length overall in feet. null = unknown, so fit can't be checked yet. */
  lengthFt: number | null;
  notes: string;
}

export interface Reservation {
  id: number;
  berthId: number;
  /** null for events that aren't a vessel, like a community sail day. */
  vesselId: number | null;
  /** Event name, or an optional label for a vessel stay. */
  title: string;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  notes: string;
  source: "manual" | "import";
  /** Spreadsheet cells an imported stay was read from, e.g. "2018!T9, 2018!C21". */
  sourceRef: string | null;
  /** false for imported stays that nobody has checked yet (their dates are partly guessed). */
  confirmed: boolean;
  /**
   * For unconfirmed stays: the individual days the spreadsheet shows the vessel at the berth,
   * sorted. Every other day of the stay is an estimate. Empty when no day is certain.
   */
  knownDates: string[];
  /** Set when the reservation was saved despite a conflict or fit problem. */
  overrideReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A reservation joined with the names it refers to, which is what the UI mostly wants. */
export interface ReservationView extends Reservation {
  berthName: string;
  berthLengthFt: number | null;
  vesselName: string | null;
  vesselLengthFt: number | null;
}

/** A free-text annotation pinned to a day (and optionally a berth). Never counts as a booking. */
export interface DayNote {
  id: number;
  berthId: number | null;
  date: string;
  text: string;
  source: "manual" | "import";
  sourceRef: string | null;
}

/** What the caller sends when creating or updating a reservation. */
export interface ReservationInput {
  berthId: number;
  vesselId: number | null;
  title: string;
  startDate: string;
  endDate: string;
  notes?: string;
  /** Save even if there are blocking problems. Requires overrideReason. */
  override?: boolean;
  overrideReason?: string;
  /** Mark an imported stay's dates as checked. Without this an edit keeps it unconfirmed. */
  confirmDates?: boolean;
}

export type ProblemCode =
  | "BERTH_CONFLICT" // the berth is certainly taken on at least one of these days
  | "POSSIBLE_CONFLICT" // the overlap is only on days estimated from the spreadsheet
  | "DOES_NOT_FIT" // vessel is longer than the berth
  | "FIT_UNKNOWN" // vessel or berth length not recorded, so fit can't be checked
  | "VESSEL_ELSEWHERE"; // same vessel is booked at a different berth on overlapping days

export interface Problem {
  code: ProblemCode;
  /** Errors block saving unless overridden; warnings are informational. */
  severity: "error" | "warning";
  message: string;
  /** The other reservation involved, when there is one. */
  reservationId?: number;
}
