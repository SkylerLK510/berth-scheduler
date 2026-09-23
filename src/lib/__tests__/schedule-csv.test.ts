import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyOverlap } from "../conflicts";
import { columnLetter, joinMonthContinuations, looksLikeVesselName, parseBerthLabel, parseCsv, parseScheduleCsv, type ParsedReservation } from "../schedule-csv";

const sample = readFileSync(join(__dirname, "../../../public/sample/dock-schedule-2018.csv"), "utf8");

describe("parseCsv", () => {
  it("handles quotes, embedded commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"c, d","say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["c, d", 'say "hi"'],
    ]);
  });
});

describe("parseBerthLabel", () => {
  it("splits the length off the name", () => {
    expect(parseBerthLabel("North Pier West - 410'")).toEqual({ name: "North Pier West", lengthFt: 410 });
    expect(parseBerthLabel("Inner Channel - 55'")).toEqual({ name: "Inner Channel", lengthFt: 55 });
    expect(parseBerthLabel("North Finger Piers:")).toEqual({ name: "North Finger Piers", lengthFt: null });
    expect(parseBerthLabel("Small craft slips (institution boats)")).toEqual({ name: "Small craft slips (institution boats)", lengthFt: null });
  });
});

describe("looksLikeVesselName", () => {
  it("recognises the designations used in the sheet and nothing else", () => {
    for (const name of ["R/V GOLDEN COMPASS", "OSV Far Tide", "F/V Salt Ketch", "M/V Deep Beacon", "S/V Swift Marlin", "M/Y Silver Ketch", "Tug BLUE FATHOM", "Barge Silver Voyager"]) {
      expect(looksLikeVesselName(name)).toBe(true);
    }
    for (const text of ["Fuel truck", "Bunker barge", "Fueling @0800", "Departure 0800", "ETA 1200", "Donor reception", "1030"]) {
      expect(looksLikeVesselName(text)).toBe(false);
    }
  });
});

describe("columnLetter", () => {
  it("matches spreadsheet column labels", () => {
    expect([0, 1, 2, 25, 26, 27, 31, 32, 701, 702].map(columnLetter)).toEqual(["A", "B", "C", "Z", "AA", "AB", "AF", "AG", "ZZ", "AAA"]);
  });
});

// A small sheet that exercises every rule. Day 1 is column C, so day N is column index N + 1.
function monthRow(label: string, entries: Record<number, string>, days: number, columnB = "") {
  const cells = Array.from({ length: days }, (_, i) => entries[i + 1] ?? "");
  return [label, columnB, ...cells].join(",");
}
const days31 = Array.from({ length: 31 }, (_, i) => i + 1).join(",");
const days28 = Array.from({ length: 28 }, (_, i) => i + 1).join(",");

const small = [
  "Harborview Marine Research Center", // row 1
  "2019 Pier & Dock Schedule", // row 2
  "", // row 3
  `January,,${days31}`, // row 4
  ",,T,W,TR", // row 5 (day-of-week, ignored)
  monthRow("Main Pier - 200'", { 1: "R/V Alpha", 5: "R/V Beta", 20: "R/V Alpha", 25: "R/V Alpha" }, 31), // row 6
  monthRow("Float - 60'", {}, 31, "Tug Resident"), // row 7
  monthRow("Slips", { 2: "Fueling @0800" }, 31), // row 8
  monthRow("", { 4: "Fuel truck", 9: "OSV Visitor" }, 31), // row 9
  "", // row 10
  `February,,${days28},,,`, // row 11
  ",,F,S,S", // row 12
  monthRow("Main Pier - 200'", { 1: "R/V Alpha", 10: "OSV Next" }, 28), // row 13
  monthRow("Float - 60'", {}, 28) + ",,Barge Late", // row 14: a name past the last day of February
  monthRow("Slips", {}, 28), // row 15
].join("\r\n");

describe("parseScheduleCsv on a small grid", () => {
  const parsed = parseScheduleCsv(small);
  const stays = (vessel: string) => parsed.reservations.filter((r) => r.vesselName === vessel);

  it("reads the year from the title rows and lists berths in sheet order", () => {
    expect(parsed.year).toBe(2019);
    expect(parsed.berths).toEqual([
      { name: "Main Pier", lengthFt: 200 },
      { name: "Float", lengthFt: 60 },
      { name: "Slips", lengthFt: null },
    ]);
  });

  it("stretches a stay to the day before the next vessel in the row, and only the listed day is known", () => {
    expect(stays("R/V Beta")).toEqual([
      { berthName: "Main Pier", vesselName: "R/V Beta", startDate: "2019-01-05", endDate: "2019-01-19", knownDates: ["2019-01-05"], cells: ["G6"] },
    ]);
  });

  it("keeps repeat listings inside a month as separate visits, but joins a re-listing on the 1st of the next month", () => {
    expect(stays("R/V Alpha").map((r) => [r.startDate, r.endDate, r.knownDates.join(" "), r.cells.join(" ")])).toEqual([
      ["2019-01-01", "2019-01-04", "2019-01-01", "C6"],
      ["2019-01-20", "2019-01-24", "2019-01-20", "V6"],
      // Jan 25 to month end, re-listed Feb 1, then OSV Next arrives Feb 10. Jan 26-31 stay estimated.
      ["2019-01-25", "2019-02-09", "2019-01-25 2019-02-01", "AA6 C13"],
    ]);
  });

  it("imports a name written beside the grid (column B) with every day estimated", () => {
    expect(stays("Tug Resident")).toEqual([
      { berthName: "Float", vesselName: "Tug Resident", startDate: "2019-01-01", endDate: "2019-01-31", knownDates: [], cells: ["B7"] },
    ]);
  });

  it("keeps non-vessel text and rows without a berth as notes, never as bookings", () => {
    expect(parsed.notes).toEqual([
      { berthName: "Slips", date: "2019-01-02", text: "Fueling @0800", cell: "D8" },
      { berthName: null, date: "2019-01-04", text: "Fuel truck", cell: "F9" },
      { berthName: null, date: "2019-01-09", text: "OSV Visitor", cell: "K9" },
    ]);
    expect(parsed.vessels).not.toContain("OSV Visitor");
    expect(parsed.reservations.some((r) => r.cells.some((c) => c.endsWith("9") && !c.endsWith("19")))).toBe(false);
  });

  it("reports every judgement call as a diagnostic, with a warning for a cell past the end of the month", () => {
    expect(parsed.diagnostics.filter((d) => d.level === "warning")).toEqual([
      { level: "warning", row: 14, message: 'February: "Barge Late" sits in column AF, past the last day of the month. It was skipped.' },
    ]);
    const messages = parsed.diagnostics.map((d) => d.message);
    expect(messages).toContain('Year 2019 read from row 2 ("2019 Pier & Dock Schedule").');
    expect(messages.some((m) => m.startsWith('January: "Tug Resident" is written beside the grid (column B) on Float'))).toBe(true);
    expect(messages.some((m) => m.includes('"Fueling @0800" on Slips doesn\'t look like a vessel name'))).toBe(true);
    expect(messages).toContain(
      "Row 9 has no berth label (between the January and February grids). Its 2 entries were kept as notes, dated using January's columns: " +
        "Fuel truck (Jan 4); OSV Visitor (Jan 9). One of them looks like a vessel name, but with no berth it can't be a booking.",
    );
    expect(messages.some((m) => m.startsWith("1 month-to-month continuation joined"))).toBe(true);
  });

  it("accepts a year override and rejects files without month grids", () => {
    expect(parseScheduleCsv(small, { year: 2020 }).year).toBe(2020);
    expect(() => parseScheduleCsv("a,b,c\n1,2,3")).toThrow(/No month grids/);
  });
});

describe("parseScheduleCsv on the real 2018 sample", () => {
  const parsed = parseScheduleCsv(sample);
  const stays = (vessel: string, berth?: string) =>
    parsed.reservations.filter((r) => r.vesselName === vessel && (!berth || r.berthName === berth));

  it("finds the year, the 12 month grids and all eight berths", () => {
    expect(parsed.year).toBe(2018);
    expect(parsed.diagnostics[1].message).toMatch(/^12 month grids found: January, .*, December\.$/);
    expect(parsed.berths.map((b) => [b.name, b.lengthFt])).toEqual([
      ["North Pier West", 410],
      ["North Pier Face", 75],
      ["North Pier East", 240],
      ["Inner Channel", 55],
      ["South Float West", 90],
      ["South Float East", 90],
      ["North Finger Piers", null],
      ["Small craft slips (institution boats)", null],
    ]);
  });

  it("builds 70 stays from 80 vessel cells and keeps 33 notes", () => {
    expect(parsed.reservations).toHaveLength(70);
    expect(parsed.reservations.reduce((n, r) => n + r.cells.length, 0)).toBe(80);
    expect(parsed.notes).toHaveLength(33);
    const lower = parsed.vessels.map((v) => v.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length); // de-duplicated regardless of case
  });

  it("rebuilds R/V GOLDEN COMPASS's stays at North Pier West, keeping which days are known", () => {
    expect(stays("R/V GOLDEN COMPASS", "North Pier West").map((r) => [r.startDate, r.endDate, r.knownDates.join(" "), r.cells.join(" ")])).toEqual([
      ["2018-01-01", "2018-01-17", "2018-01-01", "C9"],
      // listed Jan 18, then on the 1st of Feb, Mar and Apr; another visit starts Apr 13.
      // Only those four days are known; the weeks between them are estimated.
      ["2018-01-18", "2018-04-12", "2018-01-18 2018-02-01 2018-03-01 2018-04-01", "T9 C21 C33 C45"],
      ["2018-04-13", "2018-04-26", "2018-04-13", "O45"],
      ["2018-05-09", "2018-05-18", "2018-05-09", "K57"],
      ["2018-05-19", "2018-05-31", "2018-05-19", "U57"],
      ["2018-06-04", "2018-06-27", "2018-06-04", "F69"],
      ["2018-10-18", "2018-10-25", "2018-10-18", "T118"],
      ["2018-10-26", "2018-10-31", "2018-10-26", "AB118"],
      ["2018-12-01", "2018-12-31", "2018-12-01", "C142"],
    ]);
  });

  it("does not treat the unlisted days of a joined stay as certain (Jan 25 between Jan 18 and Feb 1)", () => {
    const compass = stays("R/V GOLDEN COMPASS", "North Pier West").find((r) => r.startDate === "2018-01-18")!;
    expect(classifyOverlap({ ...compass, confirmed: false }, { startDate: "2018-01-25", endDate: "2018-01-25" })).toBe("possible");
    expect(classifyOverlap({ ...compass, confirmed: false }, { startDate: "2018-02-01", endDate: "2018-02-01" })).toBe("definite");
  });

  it("keeps R/V Long Ketch's repeated May listings as separate visits", () => {
    expect(stays("R/V Long Ketch").filter((r) => r.startDate.startsWith("2018-05")).map((r) => [r.startDate, r.endDate])).toEqual([
      ["2018-05-03", "2018-05-07"],
      ["2018-05-08", "2018-05-14"],
      ["2018-05-15", "2018-05-23"],
      ["2018-05-24", "2018-05-31"],
    ]);
  });

  it("treats R/V Golden Horizon (column B, rows 121/133/145) as possibly there Oct-Dec with no known day", () => {
    expect(stays("R/V Golden Horizon")).toEqual([
      { berthName: "Inner Channel", vesselName: "R/V Golden Horizon", startDate: "2018-10-01", endDate: "2018-12-31", knownDates: [], cells: ["B121", "B133", "B145"] },
    ]);
  });

  it("never invents certainty: only listed days are known, and the known days sit inside the stay", () => {
    for (const r of parsed.reservations) {
      if (r.knownDates.length === 0) {
        expect(r.cells.every((c) => c.startsWith("B"))).toBe(true);
        continue;
      }
      // one known day per vessel cell, the first one is the stay's start, all inside the stay
      expect(r.knownDates).toHaveLength(r.cells.length);
      expect(r.knownDates[0]).toBe(r.startDate);
      expect(r.knownDates.every((d) => d >= r.startDate && d <= r.endDate)).toBe(true);
    }
  });

  it("never produces two stays on the same berth on the same day", () => {
    const byBerth = new Map<string, ParsedReservation[]>();
    for (const r of parsed.reservations) byBerth.set(r.berthName, [...(byBerth.get(r.berthName) ?? []), r]);
    for (const list of byBerth.values()) {
      list.sort((a, b) => a.startDate.localeCompare(b.startDate));
      for (let i = 1; i < list.length; i++) expect(list[i].startDate > list[i - 1].endDate).toBe(true);
    }
  });

  it("keeps the unlabeled rows (42, 54, 66, 78, 90) and the trailing row 151 as notes, and reports each one", () => {
    const rowsWithUnassignedNotes = [...new Set(parsed.notes.filter((n) => n.berthName === null).map((n) => Number(n.cell.replace(/^[A-Z]+/, ""))))];
    expect(rowsWithUnassignedNotes).toEqual([42, 54, 66, 78, 90, 151]);
    expect(parsed.reservations.some((r) => r.cells.some((c) => /^[A-Z]+(42|54|66|78|90|151)$/.test(c)))).toBe(false);

    const reported = parsed.diagnostics.filter((d) => d.message.startsWith(`Row ${d.row} has no berth label`)).map((d) => d.row);
    expect(reported).toEqual([42, 54, 66, 78, 90, 151]);
    const row151 = parsed.diagnostics.find((d) => d.row === 151)!;
    expect(row151.message).toContain("(below the December grid)");
    expect(row151.message).toContain("8 of them look like vessel names, but with no berth they can't be bookings.");
    expect(parsed.notes.filter((n) => n.cell.endsWith("151")).map((n) => n.text)).toEqual([
      "F/V Western Sound (written beside the grid, no day)",
      "R/V Long Ketch",
      "M/V GREY COMPASS",
      "Barge SILVER VOYAGER",
      "OSV AMBER REEF",
      "OSV Silver Tide",
      "M/V NORTHERN HARBOR",
      "R/V GOLDEN COMPASS",
      "Returns from sea trials",
    ]);
  });

  it("warns about the one cell past the end of a month (row 77, column AG, June 31)", () => {
    expect(parsed.diagnostics.filter((d) => d.level === "warning")).toEqual([
      { level: "warning", row: 77, message: 'June: "Bunkering 1000" sits in column AG, past the last day of the month. It was skipped.' },
    ]);
  });

  it("keeps service entries on berth rows as notes on that berth", () => {
    expect(parsed.notes.filter((n) => n.berthName === "North Finger Piers").map((n) => [n.date, n.text])).toEqual([
      ["2018-04-21", "Fuel truck"],
      ["2018-05-30", "Fueling @0800"],
    ]);
  });
});

describe("joinMonthContinuations", () => {
  const stay = (startDate: string, endDate: string, cell: string, berthName = "A"): ParsedReservation => ({
    berthName,
    vesselName: "R/V X",
    startDate,
    endDate,
    knownDates: [startDate],
    cells: [cell],
  });

  it("joins only a month-end stay with a listing on the 1st of the next month, same berth", () => {
    const joined = joinMonthContinuations([
      stay("2018-01-10", "2018-01-20", "L1"),
      stay("2018-01-21", "2018-01-31", "W1"), // same vessel next day, same month: a separate visit
      stay("2018-02-01", "2018-02-05", "C2"), // continues the Jan 21 stay
      stay("2018-02-01", "2018-02-05", "C3", "B"), // different berth
    ]);
    expect(joined.map((r) => [r.berthName, r.startDate, r.endDate, r.knownDates.join(" "), r.cells.join(" ")])).toEqual([
      ["A", "2018-01-10", "2018-01-20", "2018-01-10", "L1"],
      ["A", "2018-01-21", "2018-02-05", "2018-01-21 2018-02-01", "W1 C2"],
      ["B", "2018-02-01", "2018-02-05", "2018-02-01", "C3"],
    ]);
  });
});
