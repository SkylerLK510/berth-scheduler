// Parser for the facility's existing spreadsheet, exported as CSV.
//
// The sheet is one grid per month:
//
//   January,,1,2,3,...,31          <- month header, day numbers start in column C
//   ,,M,T,W,...                    <- day-of-week row (ignored, the year gives us the calendar)
//   North Pier West - 410',,R/V X  <- one row per berth, vessel name in the day it was listed
//   ...
//   ,,,,,,,Fuel truck              <- rows with no berth label hold free-form notes
//
// What the export does NOT contain matters as much as what it does:
//   * No departure dates. Only the cell where a vessel's name was typed survives, so we
//     know the day it was listed and nothing about when it left. Each stay is stretched
//     to the day before the next vessel listed in the same berth row (or the end of the
//     month), which is the longest it could have lasted without the sheet showing a
//     double-booking. The days the sheet actually shows are kept as knownDates and
//     everything is imported as unconfirmed, so the guessed days never count as certain
//     occupancy.
//   * No vessel lengths. Vessels are created without one; nothing is invented.
// Every judgement call is reported in `diagnostics`, which the import preview shows.

import { hasEstimatedDays } from "./conflicts";
import { addDays, daysInMonth, MONTH_NAMES, toIsoDate } from "./dates";

export interface ParsedBerth {
  name: string;
  lengthFt: number | null;
}

export interface ParsedReservation {
  berthName: string;
  vesselName: string;
  /** Full date range, including estimated days. */
  startDate: string;
  endDate: string;
  /** The individual days the sheet shows the vessel there. Empty when none are certain. */
  knownDates: string[];
  /** A1 references of the cells the stay was built from, e.g. ["T9", "C21"]. */
  cells: string[];
}

export interface ParsedNote {
  berthName: string | null;
  date: string;
  text: string;
  cell: string;
}

export interface Diagnostic {
  level: "info" | "warning";
  /** 1-based row number in the CSV, when the finding is about one row. */
  row?: number;
  message: string;
}

export interface ParsedSchedule {
  year: number;
  berths: ParsedBerth[];
  vessels: string[];
  reservations: ParsedReservation[];
  notes: ParsedNote[];
  diagnostics: Diagnostic[];
}

/** Minimal RFC 4180 parser: handles quoted fields, doubled quotes, CRLF and LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "North Pier West - 410'" -> { name: "North Pier West", lengthFt: 410 }; "North Finger Piers:" -> no length. */
export function parseBerthLabel(label: string): ParsedBerth {
  const m = label.match(/^(.*?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:'|ft|feet)?\s*$/i);
  if (m) return { name: m[1].trim(), lengthFt: Number(m[2]) };
  return { name: label.replace(/:\s*$/, "").trim(), lengthFt: null };
}

// Vessel names in the sheet carry a designation prefix. Anything else on a berth
// row ("Fuel truck", "Fueling @0800", "Departure 0800") is treated as a note.
const VESSEL_PREFIX = /^(R\/V|OSV|F\/V|M\/V|S\/V|M\/Y|Tug|Barge|USCGC|RV|MV)\b\s*\S/i;

export function looksLikeVesselName(text: string): boolean {
  return VESSEL_PREFIX.test(text.trim());
}

/** 0-based column index -> spreadsheet letter (0 = A, 26 = AA). */
export function columnLetter(index: number): string {
  let s = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

function monthIndex(cell: string): number {
  const name = cell.trim().toLowerCase();
  return MONTH_NAMES.findIndex((m) => m.toLowerCase() === name);
}

function isMonthHeader(row: string[]): boolean {
  return row.length > 2 && monthIndex(row[0]) >= 0 && row[2].trim() === "1";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ParseOptions {
  /** Use this year instead of the one found in the sheet's title rows. */
  year?: number;
}

export function parseScheduleCsv(text: string, options: ParseOptions = {}): ParsedSchedule {
  const rows = parseCsv(text);
  const diagnostics: Diagnostic[] = [];
  const info = (message: string, row?: number) => diagnostics.push({ level: "info", row, message });
  const warn = (message: string, row?: number) => diagnostics.push({ level: "warning", row, message });

  const headerIndexes = rows.map((r, i) => (isMonthHeader(r) ? i : -1)).filter((i) => i >= 0);
  if (headerIndexes.length === 0) {
    throw new Error("No month grids found. Expected rows like 'January,,1,2,3,...' with berths listed underneath.");
  }

  // The year appears in the title rows above the first month ("2018 Pier & Dock Schedule").
  let year = options.year ?? null;
  if (year == null) {
    for (let i = 0; i < headerIndexes[0]; i++) {
      const m = rows[i].join(" ").match(/\b(19|20)\d{2}\b/);
      if (m) {
        year = Number(m[0]);
        info(`Year ${year} read from row ${i + 1} ("${rows[i].find((c) => c.trim())?.trim()}").`, i + 1);
        break;
      }
    }
  } else {
    info(`Year set to ${year} by the person importing.`);
  }
  if (year == null) {
    throw new Error("Couldn't find the year in the sheet's title. Enter it manually and try again.");
  }
  info(`${plural(headerIndexes.length, "month grid")} found: ${headerIndexes.map((i) => rows[i][0].trim()).join(", ")}.`);

  const berths = new Map<string, ParsedBerth>(); // keyed by lower-case name, insertion order = sheet order
  const vessels = new Map<string, string>(); // lower-case -> first spelling seen
  const stays: ParsedReservation[] = [];
  const notes: ParsedNote[] = [];
  let vesselCells = 0;

  const canonicalVessel = (name: string) => {
    const key = name.toLowerCase();
    if (!vessels.has(key)) vessels.set(key, name);
    return vessels.get(key)!;
  };

  for (let h = 0; h < headerIndexes.length; h++) {
    const headerRow = rows[headerIndexes[h]];
    const month = monthIndex(headerRow[0]) + 1;
    const monthName = MONTH_NAMES[month - 1];
    const blockStart = headerIndexes[h] + 2; // skip the day-of-week row
    const blockEnd = h + 1 < headerIndexes.length ? headerIndexes[h + 1] : rows.length;
    const monthDays = daysInMonth(year, month);
    const monthEnd = toIsoDate(year, month, monthDays);

    // Columns C onward are days 1..N. Trust the calendar, and warn if the sheet disagrees.
    const listedDays = headerRow.slice(2).filter((c) => c.trim() !== "").length;
    if (listedDays !== monthDays) {
      warn(`${monthName}: the sheet lists ${listedDays} day columns but ${monthName} ${year} has ${monthDays} days. Calendar days were used.`, headerIndexes[h] + 1);
    }

    let lastLabeledRow = -1;
    for (let r = blockStart; r < blockEnd; r++) if (rows[r]?.[0]?.trim()) lastLabeledRow = r;

    // Vessel cells per berth for this month, so each stay can be sized against the next one.
    const listings = new Map<string, Array<{ day: number; name: string; cell: string }>>();
    const seenLabels = new Set<string>();

    for (let r = blockStart; r < blockEnd; r++) {
      const row = rows[r];
      if (!row || row.every((c) => c.trim() === "")) continue;
      const rowNumber = r + 1;

      const label = row[0].trim();
      let berthName: string | null = null;
      if (label) {
        const parsed = parseBerthLabel(label);
        const key = parsed.name.toLowerCase();
        if (!berths.has(key)) berths.set(key, parsed);
        berthName = berths.get(key)!.name;
        if (seenLabels.has(key) && row.slice(1).some((c) => c.trim())) {
          info(`${monthName}: "${label}" appears twice; both rows were read as the same berth.`, rowNumber);
        }
        seenLabels.add(key);
      }

      const unlabeled: string[] = [];
      let unlabeledVesselNames = 0;

      for (let c = 1; c < row.length; c++) {
        const text = row[c].trim().replace(/\s+/g, " ");
        if (!text) continue;
        const cell = `${columnLetter(c)}${rowNumber}`;

        // Column B sits between the berth label and day 1, so a name there has no day.
        const besideGrid = c === 1;
        const day = besideGrid ? 1 : c - 1;
        if (day > monthDays) {
          warn(`${monthName}: "${text}" sits in column ${columnLetter(c)}, past the last day of the month. It was skipped.`, rowNumber);
          continue;
        }
        const date = toIsoDate(year, month, day);
        const noteText = besideGrid ? `${text} (written beside the grid, no day)` : text;

        if (berthName && looksLikeVesselName(text)) {
          const name = canonicalVessel(text);
          vesselCells++;
          if (besideGrid) {
            // No day at all: treat it as possibly there all month, with every day estimated.
            stays.push({ berthName, vesselName: name, startDate: date, endDate: monthEnd, knownDates: [], cells: [cell] });
            info(`${monthName}: "${text}" is written beside the grid (column B) on ${berthName}, not under a day. Imported as possibly there all month, with every day marked as estimated.`, rowNumber);
          } else {
            const list = listings.get(berthName) ?? [];
            list.push({ day, name, cell });
            listings.set(berthName, list);
          }
        } else if (berthName) {
          // Service entries on a berth row ("Fueling @0800", "Bunker barge") are notes, not bookings.
          notes.push({ berthName, date, text: noteText, cell });
          info(`${monthName} ${day}: "${text}" on ${berthName} doesn't look like a vessel name. Kept as a note, not a booking.`, rowNumber);
        } else {
          notes.push({ berthName: null, date, text: noteText, cell });
          unlabeled.push(besideGrid ? `${text} (no day)` : `${text} (${monthName.slice(0, 3)} ${day})`);
          if (looksLikeVesselName(text)) unlabeledVesselNames++;
        }
      }

      if (unlabeled.length) {
        const where =
          r < lastLabeledRow
            ? `inside the ${monthName} grid`
            : h + 1 < headerIndexes.length
              ? `between the ${monthName} and ${rows[headerIndexes[h + 1]][0].trim()} grids`
              : `below the ${monthName} grid`;
        const vesselPart =
          unlabeledVesselNames === 0
            ? ""
            : unlabeledVesselNames === 1
              ? " One of them looks like a vessel name, but with no berth it can't be a booking."
              : ` ${unlabeledVesselNames === unlabeled.length ? "All" : unlabeledVesselNames} of them look like vessel names, but with no berth they can't be bookings.`;
        info(
          `Row ${rowNumber} has no berth label (${where}). Its ${plural(unlabeled.length, "entry", "entries")} were kept as notes, dated using ${monthName}'s columns: ${unlabeled.join("; ")}.${vesselPart}`,
          rowNumber,
        );
      }
    }

    // Stretch each listing to the day before the next listing in the same row, or the end of
    // the month. Only the listed day itself is known.
    for (const [berthName, list] of listings) {
      list.sort((a, b) => a.day - b.day);
      for (let i = 0; i < list.length; i++) {
        const start = toIsoDate(year, month, list[i].day);
        const lastDay = i + 1 < list.length ? list[i + 1].day - 1 : monthDays;
        stays.push({
          berthName,
          vesselName: list[i].name,
          startDate: start,
          endDate: toIsoDate(year, month, Math.max(lastDay, list[i].day)),
          knownDates: [start],
          cells: [list[i].cell],
        });
      }
    }
  }

  const reservations = joinMonthContinuations(stays);
  const joined = stays.length - reservations.length;
  const estimated = reservations.filter((r) => hasEstimatedDays({ ...r, confirmed: false })).length;

  info(
    `${plural(reservations.length, "stay")} built from ${plural(vesselCells, "vessel cell")}. The sheet only records the day a vessel was listed, so each stay is assumed to ` +
      `last at most until the day before the next vessel in the same berth row (or the end of the month). ${estimated} of them include estimated days. ` +
      `All are imported as unconfirmed until someone checks the dates.`,
  );
  if (joined) {
    info(`${plural(joined, "month-to-month continuation")} joined: a vessel listed on the 1st in the same berth it occupied at the end of the previous month is read as one continuous stay.`);
  }
  const jan1 = reservations.filter((r) => r.startDate === `${year}-01-01`).length;
  const dec31 = reservations.filter((r) => r.endDate === `${year}-12-31`).length;
  if (jan1 || dec31) {
    info(
      `${plural(jan1, "stay starts", "stays start")} on January 1 and ${plural(dec31, "runs", "run")} to December 31, so they may continue from or into ` +
        `the neighbouring year. Importing that year's sheet joins them.`,
    );
  }
  info(`${plural(vessels.size, "vessel name")} found. The sheet has no vessel lengths, so vessels are created without one and fit can't be checked until lengths are entered.`);
  if (notes.length) info(`${plural(notes.length, "note")} kept (service entries on berth rows, and rows with no berth label). Notes never block a berth.`);

  return { year, berths: [...berths.values()], vessels: [...vessels.values()], reservations, notes, diagnostics };
}

/**
 * The sheet has one grid per month, so a long stay is re-listed at the top of every month.
 * A stay that runs to the last day of a month, followed by the same vessel listed on the
 * 1st of the next month in the same berth row, is one continuous stay. Repeat listings
 * inside a month are separate visits and stay separate. Joining never adds certainty: the
 * joined stay knows only the days its parts knew, and the days between them stay estimated.
 */
export function joinMonthContinuations(stays: ParsedReservation[]): ParsedReservation[] {
  const sorted = [...stays].sort(
    (a, b) => a.berthName.localeCompare(b.berthName) || a.vesselName.localeCompare(b.vesselName) || a.startDate.localeCompare(b.startDate),
  );
  const joined: ParsedReservation[] = [];
  for (const stay of sorted) {
    const prev = joined[joined.length - 1];
    const continues =
      prev &&
      prev.berthName === stay.berthName &&
      prev.vesselName === stay.vesselName &&
      stay.startDate.endsWith("-01") &&
      addDays(prev.endDate, 1) === stay.startDate;
    if (continues) {
      prev.endDate = stay.endDate;
      prev.knownDates = [...prev.knownDates, ...stay.knownDates];
      prev.cells = [...prev.cells, ...stay.cells];
    } else {
      joined.push({ ...stay, knownDates: [...stay.knownDates], cells: [...stay.cells] });
    }
  }
  return joined.sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.berthName.localeCompare(b.berthName) || a.vesselName.localeCompare(b.vesselName),
  );
}
