import { describe, expect, it } from "vitest";
import {
  certainDays,
  dateRuns,
  checkFit,
  classifyOverlap,
  findDoubleBookings,
  findProblems,
  findVesselsInTwoPlaces,
  hasBlockingProblems,
  hasEstimatedDays,
  rangesOverlap,
  type Candidate,
} from "../conflicts";
import type { ReservationView } from "../types";

function reservation(overrides: Partial<ReservationView>): ReservationView {
  return {
    id: 1,
    berthId: 1,
    berthName: "North Pier East",
    berthLengthFt: 240,
    vesselId: 10,
    vesselName: "R/V Golden Compass",
    vesselLengthFt: 200,
    title: "",
    startDate: "2018-06-10",
    endDate: "2018-06-20",
    notes: "",
    source: "manual",
    sourceRef: null,
    confirmed: true,
    knownDates: [],
    overrideReason: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** An imported stay: listed on Jun 10 only, assumed to last at most until Jun 20. */
const imported = (overrides: Partial<ReservationView> = {}) =>
  reservation({ source: "import", confirmed: false, knownDates: ["2018-06-10"], ...overrides });

const draft: Candidate = {
  berthId: 1,
  berthName: "North Pier East",
  berthLengthFt: 240,
  vesselId: 11,
  vesselName: "OSV Amber Reef",
  vesselLengthFt: 180,
  startDate: "2018-06-18",
  endDate: "2018-06-25",
};

describe("rangesOverlap (inclusive whole days)", () => {
  const june = { start: "2018-06-10", end: "2018-06-20" };

  it("detects partial, contained and identical overlaps", () => {
    expect(rangesOverlap(june, { start: "2018-06-18", end: "2018-06-25" })).toBe(true);
    expect(rangesOverlap(june, { start: "2018-06-01", end: "2018-06-12" })).toBe(true);
    expect(rangesOverlap(june, { start: "2018-06-12", end: "2018-06-14" })).toBe(true);
    expect(rangesOverlap(june, { start: "2018-06-01", end: "2018-06-30" })).toBe(true);
    expect(rangesOverlap(june, june)).toBe(true);
  });

  it("counts a shared first or last day as an overlap", () => {
    expect(rangesOverlap(june, { start: "2018-06-20", end: "2018-06-22" })).toBe(true);
    expect(rangesOverlap(june, { start: "2018-06-05", end: "2018-06-10" })).toBe(true);
  });

  it("does not count back-to-back ranges as overlapping", () => {
    expect(rangesOverlap(june, { start: "2018-06-21", end: "2018-06-22" })).toBe(false);
    expect(rangesOverlap(june, { start: "2018-06-01", end: "2018-06-09" })).toBe(false);
  });

  it("works across month and year boundaries because ISO dates sort as text", () => {
    expect(rangesOverlap({ start: "2018-12-28", end: "2019-01-03" }, { start: "2019-01-03", end: "2019-01-05" })).toBe(true);
    expect(rangesOverlap({ start: "2018-12-28", end: "2018-12-31" }, { start: "2019-01-01", end: "2019-01-05" })).toBe(false);
  });
});

describe("certain vs estimated days", () => {
  it("treats a confirmed stay as fully known", () => {
    expect(certainDays(reservation({}))).toEqual([{ start: "2018-06-10", end: "2018-06-20" }]);
    expect(hasEstimatedDays(reservation({}))).toBe(false);
  });

  it("only trusts the listed days of an unconfirmed import", () => {
    expect(certainDays(imported())).toEqual([{ start: "2018-06-10", end: "2018-06-10" }]);
    expect(hasEstimatedDays(imported())).toBe(true);
    expect(certainDays(imported({ knownDates: [] }))).toEqual([]);
    // an import whose range is exactly its listed days has nothing estimated, but is still unconfirmed
    expect(hasEstimatedDays(imported({ endDate: "2018-06-10" }))).toBe(false);
  });

  it("classifies overlaps as definite, possible or none", () => {
    const confirmed = (startDate: string, endDate: string) => ({ startDate, endDate });
    expect(classifyOverlap(confirmed("2018-06-09", "2018-06-10"), imported())).toBe("definite"); // hits the listed day
    expect(classifyOverlap(confirmed("2018-06-15", "2018-06-25"), imported())).toBe("possible"); // only the guessed tail
    expect(classifyOverlap(confirmed("2018-06-21", "2018-06-25"), imported())).toBe("none");
    expect(classifyOverlap(confirmed("2018-06-10", "2018-06-10"), imported({ knownDates: [] }))).toBe("possible");
    expect(classifyOverlap(reservation({}), reservation({ id: 2, startDate: "2018-06-20", endDate: "2018-06-30" }))).toBe("definite");
  });

  it("keeps the gap between two sightings estimated", () => {
    // Listed on Jun 10 and again on Jun 20: only those two days are certain.
    const seenTwice = imported({ knownDates: ["2018-06-10", "2018-06-20"] });
    const confirmed = (startDate: string, endDate: string) => ({ startDate, endDate });
    expect(certainDays(seenTwice)).toEqual([
      { start: "2018-06-10", end: "2018-06-10" },
      { start: "2018-06-20", end: "2018-06-20" },
    ]);
    expect(classifyOverlap(confirmed("2018-06-15", "2018-06-15"), seenTwice)).toBe("possible");
    expect(classifyOverlap(confirmed("2018-06-20", "2018-06-22"), seenTwice)).toBe("definite");
    // two unconfirmed stays whose sightings interleave never share a certain day
    expect(classifyOverlap(imported({ knownDates: ["2018-06-15"] }), seenTwice)).toBe("possible");
  });

  it("merges consecutive known days into runs", () => {
    expect(dateRuns(["2018-06-12", "2018-06-10", "2018-06-11", "2018-06-11", "2018-07-01"])).toEqual([
      { start: "2018-06-10", end: "2018-06-12" },
      { start: "2018-07-01", end: "2018-07-01" },
    ]);
  });
});

describe("checkFit", () => {
  it("compares lengths and reports unknowns", () => {
    expect(checkFit(200, 240)).toBe("fits");
    expect(checkFit(240, 240)).toBe("fits");
    expect(checkFit(240.5, 240)).toBe("too_long");
    expect(checkFit(null, 240)).toBe("unknown");
    expect(checkFit(200, null)).toBe("unknown");
  });
});

describe("findProblems", () => {
  it("flags a double-booked berth as an error", () => {
    const problems = findProblems(draft, [reservation({})]);
    expect(problems.map((p) => [p.code, p.severity, p.reservationId])).toEqual([["BERTH_CONFLICT", "error", 1]]);
    expect(problems[0].message).toBe("North Pier East is already booked by R/V Golden Compass (Jun 10–20, 2018)");
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  it("is clean when the dates don't overlap", () => {
    expect(findProblems(draft, [reservation({ endDate: "2018-06-17" })])).toEqual([]);
  });

  it("ignores the reservation being edited", () => {
    expect(findProblems({ ...draft, id: 1 }, [reservation({ id: 1 })])).toEqual([]);
  });

  it("warns without blocking when the overlap is only on estimated days of an import", () => {
    const problems = findProblems(draft, [imported()]);
    expect(problems.map((p) => [p.code, p.severity])).toEqual([["POSSIBLE_CONFLICT", "warning"]]);
    expect(problems[0].message).toContain("dates partly estimated");
    expect(hasBlockingProblems(problems)).toBe(false);
  });

  it("blocks when the overlap includes a day the spreadsheet actually shows", () => {
    const problems = findProblems({ ...draft, startDate: "2018-06-08", endDate: "2018-06-12" }, [imported()]);
    expect(problems.map((p) => p.code)).toEqual(["BERTH_CONFLICT"]);
  });

  it("flags a vessel that is too long for the berth", () => {
    const problems = findProblems({ ...draft, vesselLengthFt: 300 }, []);
    expect(problems.map((p) => p.code)).toEqual(["DOES_NOT_FIT"]);
    expect(problems[0].message).toBe("OSV Amber Reef is 300' but North Pier East is only 240'");
  });

  it("warns instead of blocking when a length is unknown", () => {
    const problems = findProblems({ ...draft, vesselLengthFt: null }, []);
    expect(problems.map((p) => [p.code, p.message])).toEqual([["FIT_UNKNOWN", "Can't check fit: OSV Amber Reef has no length on record"]]);
    expect(hasBlockingProblems(problems)).toBe(false);
  });

  it("warns when the same vessel is booked somewhere else on those days", () => {
    const elsewhere = reservation({ id: 5, berthId: 2, berthName: "South Float West", vesselId: 11 });
    const problems = findProblems(draft, [elsewhere]);
    expect(problems.map((p) => [p.code, p.severity])).toEqual([["VESSEL_ELSEWHERE", "warning"]]);
  });

  it("applies the berth check, but not the fit check, to events", () => {
    const event: Candidate = { ...draft, vesselId: null, vesselName: null, vesselLengthFt: null };
    expect(findProblems(event, [])).toEqual([]);
    expect(findProblems(event, [reservation({})]).map((p) => p.code)).toEqual(["BERTH_CONFLICT"]);
    // and an event blocks a vessel the same way
    expect(findProblems(draft, [reservation({ vesselId: null, vesselName: null, title: "Community sail day" })]).map((p) => p.message)).toEqual([
      "North Pier East is already booked by Community sail day (Jun 10–20, 2018)",
    ]);
  });
});

describe("whole-schedule audit", () => {
  const a = reservation({ id: 1, startDate: "2018-06-01", endDate: "2018-06-10" });
  const b = reservation({ id: 2, vesselId: 11, vesselName: "OSV Amber Reef", startDate: "2018-06-10", endDate: "2018-06-15" });
  const c = reservation({ id: 3, vesselId: 12, vesselName: "Tug Blue Fathom", startDate: "2018-06-16", endDate: "2018-06-20" });
  const d = reservation({ id: 4, berthId: 2, berthName: "South Float West", vesselId: 10, startDate: "2018-06-05", endDate: "2018-06-06" });
  const e = imported({ id: 5, vesselId: 13, vesselName: "R/V Long Ketch", startDate: "2018-06-12", endDate: "2018-06-18", knownDates: ["2018-06-12"] });

  it("lists every overlapping pair per berth, split into definite and possible", () => {
    const pairs = findDoubleBookings([c, b, a, d, e]);
    expect(pairs.map((p) => [p.a.id, p.b.id, p.overlap])).toEqual([
      [1, 2, "definite"],
      [2, 5, "definite"], // b (Jun 10-15, confirmed) covers e's listed day, Jun 12
      [5, 3, "possible"], // c starts Jun 16, inside e's estimated tail only
    ]);
  });

  it("lists vessels booked at two berths at once", () => {
    const pairs = findVesselsInTwoPlaces([a, b, c, d, e]);
    expect(pairs.map((p) => [p.a.id, p.b.id, p.overlap])).toEqual([[1, 4, "definite"]]);
  });
});
