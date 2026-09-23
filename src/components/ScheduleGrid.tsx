"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { certainDays, checkFit, hasEstimatedDays } from "@/lib/conflicts";
import { addDays, formatDate, formatRange, parseIsoDate, rangeLength, todayIso } from "@/lib/dates";
import type { Berth, DayNote, ReservationView } from "@/lib/types";

interface Props {
  from: string;
  to: string;
  berths: Berth[];
  reservations: ReservationView[];
  notes: DayNote[];
  conflictIds: number[];
  possibleConflictIds: number[];
  /** Whether clicking an empty day opens a new booking (dispatchers only). */
  canEdit: boolean;
}

const LABEL_WIDTH = "200px";
const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];
/** How many day columns a note label covers, so short notes stay readable. */
const NOTE_SPAN = 3;

/** Bar colours. `solid` fills known days; `tint` sits under the hatching on estimated days. */
const TONES = {
  vessel: { solid: "#0ea5e9", tint: "#e0f2fe", border: "border-sky-700" },
  event: { solid: "#8b5cf6", tint: "#ede9fe", border: "border-violet-600" },
  conflict: { solid: "#ef4444", tint: "#fee2e2", border: "border-red-600" },
  tooLong: { solid: "#fbbf24", tint: "#fef3c7", border: "border-amber-600" },
};
type Tone = (typeof TONES)[keyof typeof TONES];

function weekday(iso: string): number {
  const { year, month, day } = parseIsoDate(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Greedy lane assignment: overlapping items get stacked instead of drawn on top of each other. */
function assignLanes(items: { id: number; start: string; end: string }[]): Map<number, number> {
  const lanes = new Map<number, number>();
  const laneEnds: string[] = [];
  for (const item of [...items].sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)) {
    let lane = laneEnds.findIndex((end) => end < item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    lanes.set(item.id, lane);
  }
  return lanes;
}

const laneCount = (lanes: Map<number, number>) => (lanes.size ? Math.max(...lanes.values()) + 1 : 0);

/** Days a note label covers, used both for lane assignment and for drawing it. */
const noteSpan = (n: DayNote) => ({ id: n.id, start: n.date, end: addDays(n.date, NOTE_SPAN - 1) });

/**
 * Background for a bar spanning visible days [first, last]. Known days are solid; estimated
 * days are a light tint with diagonal hatching, so a guessed stay reads as "maybe" at a glance.
 */
function barBackground(r: ReservationView, first: string, last: string, tone: Tone): CSSProperties {
  if (!hasEstimatedDays(r)) return { backgroundColor: tone.solid };

  const hatch = `repeating-linear-gradient(135deg, ${tone.solid}55 0 3px, transparent 3px 7px)`;
  // One solid band per run of known days, as percentages of the visible bar width.
  const total = rangeLength(first, last);
  const bands = certainDays(r)
    .map((k) => ({ start: k.start > first ? k.start : first, end: k.end < last ? k.end : last }))
    .filter((k) => k.start <= k.end)
    .map((k) => {
      const from = ((rangeLength(first, k.start) - 1) / total) * 100;
      const to = (rangeLength(first, k.end) / total) * 100;
      return `linear-gradient(to right, transparent ${from}%, ${tone.solid} ${from}% ${to}%, transparent ${to}%)`;
    });
  return { backgroundColor: tone.tint, backgroundImage: [...bands, hatch].join(", ") };
}

function NoteLabel({ note, column, row, dayCount }: { note: DayNote; column: number; row: number; dayCount: number }) {
  // Clamp the span so a note near the end of the month doesn't add columns to the grid.
  const span = Math.min(NOTE_SPAN, dayCount - column);
  return (
    <span
      title={`${note.date}: ${note.text}`}
      className="z-10 my-1 truncate rounded border border-amber-300 bg-amber-50 px-1 text-[11px] leading-5 text-amber-900"
      style={{ gridColumn: `${column + 2} / span ${span}`, gridRow: row }}
    >
      {note.text}
    </span>
  );
}

export default function ScheduleGrid({ from, to, berths, reservations, notes, conflictIds, possibleConflictIds, canEdit }: Props) {
  const router = useRouter();
  const dayCount = rangeLength(from, to);
  const days = Array.from({ length: dayCount }, (_, i) => addDays(from, i));
  const today = todayIso();
  const conflicts = new Set(conflictIds);
  const possibleConflicts = new Set(possibleConflictIds);
  const columns = `${LABEL_WIDTH} repeat(${dayCount}, minmax(30px, 1fr))`;
  const dayIndex = (iso: string) => rangeLength(from, iso) - 1;

  const unassignedNotes = notes.filter((n) => n.berthId == null);
  const unassignedLanes = assignLanes(unassignedNotes.map(noteSpan));

  return (
    <div className="card overflow-x-auto">
      <div style={{ minWidth: `calc(${LABEL_WIDTH} + ${dayCount * 30}px)` }}>
        {/* day header */}
        <div className="grid border-b border-slate-200 bg-slate-50 text-center text-xs" style={{ gridTemplateColumns: columns }}>
          <div className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-slate-500">Berth</div>
          {days.map((d) => {
            const wd = weekday(d);
            const weekend = wd === 0 || wd === 6;
            return (
              <div
                key={d}
                className={`border-l border-slate-100 py-1 ${weekend ? "bg-slate-100 text-slate-500" : "text-slate-700"} ${d === today ? "bg-sky-100 font-semibold text-sky-800" : ""}`}
                title={d}
              >
                <div className="text-[10px] leading-3 text-slate-400">{WEEKDAY[wd]}</div>
                <div className="leading-4">{parseIsoDate(d).day}</div>
              </div>
            );
          })}
        </div>

        {berths.length === 0 && <p className="p-6 text-sm text-slate-500">No berths yet. Add them on the Berths page or import a schedule.</p>}

        {berths.map((berth) => {
          const mine = reservations.filter((r) => r.berthId === berth.id);
          const lanes = assignLanes(mine.map((r) => ({ id: r.id, start: r.startDate, end: r.endDate })));
          const rows = Math.max(1, laneCount(lanes));
          const berthNotes = notes.filter((n) => n.berthId === berth.id);
          const noteLanes = assignLanes(berthNotes.map(noteSpan));
          const totalRows = rows + laneCount(noteLanes);

          return (
            <div key={berth.id} className="grid border-b border-slate-200" style={{ gridTemplateColumns: columns, gridAutoRows: "minmax(34px, auto)" }}>
              <div className="flex flex-col justify-center border-r border-slate-200 px-3 py-1" style={{ gridRow: `1 / span ${totalRows}` }}>
                <div className="truncate text-sm font-medium text-slate-800" title={berth.name}>
                  {berth.name}
                </div>
                <div className="text-xs text-slate-500">{berth.lengthFt != null ? `${berth.lengthFt}'` : "length not set"}</div>
              </div>

              {/* background cells: one per day per lane, click to add a reservation on that day.
                  Plain elements rather than links, so a month doesn't prefetch hundreds of URLs. */}
              {Array.from({ length: totalRows }, (_, row) =>
                days.map((d, i) => {
                  const wd = weekday(d);
                  const weekend = wd === 0 || wd === 6;
                  return (
                    <div
                      key={`${row}-${d}`}
                      onClick={canEdit ? () => router.push(`/reservations/new?berthId=${berth.id}&date=${d}`) : undefined}
                      title={canEdit ? `Add a reservation at ${berth.name} starting ${d}` : undefined}
                      className={`border-l border-slate-100 ${canEdit ? "cursor-pointer hover:bg-sky-50" : ""} ${weekend ? "bg-slate-50" : ""} ${d === today ? "bg-sky-50/60" : ""}`}
                      style={{ gridColumn: i + 2, gridRow: row + 1 }}
                    />
                  );
                }),
              )}

              {mine.map((r) => {
                const first = r.startDate < from ? from : r.startDate;
                const last = r.endDate > to ? to : r.endDate;
                const conflict = conflicts.has(r.id);
                const possibleConflict = possibleConflicts.has(r.id);
                const estimated = hasEstimatedDays(r);
                const fit = r.vesselId != null ? checkFit(r.vesselLengthFt, r.berthLengthFt) : "fits";
                const label = r.vesselName ?? r.title;
                const tone = conflict ? TONES.conflict : fit === "too_long" ? TONES.tooLong : r.vesselId == null ? TONES.event : TONES.vessel;
                // White text only works on a fully solid bar; hatched bars get dark text.
                const text = estimated || tone === TONES.tooLong ? "text-slate-900" : "text-white";
                const known = r.knownDates.filter((d) => d >= r.startDate && d <= r.endDate);
                const tooltip = [
                  `${label}${r.title && r.vesselName ? ` – ${r.title}` : ""}`,
                  formatRange(r.startDate, r.endDate),
                  estimated ? (known.length ? `Sheet shows ${known.map(formatDate).join(", ")}; other days are estimated` : "All days are estimated") : null,
                  conflict ? "DOUBLE-BOOKED" : null,
                  possibleConflict ? "Possible double-booking (on estimated days)" : null,
                  fit === "too_long" ? `Does not fit (${r.vesselLengthFt}' in a ${r.berthLengthFt}' berth)` : null,
                  fit === "unknown" ? "Fit not verified (length unknown)" : null,
                  r.overrideReason ? `Override: ${r.overrideReason}` : null,
                  r.sourceRef ? `From ${r.sourceRef}` : null,
                ]
                  .filter(Boolean)
                  .join("\n");
                return (
                  <Link
                    key={r.id}
                    href={`/reservations/${r.id}`}
                    title={tooltip}
                    className={`z-10 my-1 flex items-center gap-1 overflow-hidden rounded border px-1.5 text-xs font-medium shadow-sm ${tone.border} ${text} ${r.overrideReason ? "border-dashed" : ""} ${possibleConflict ? "outline-2 outline-offset-1 outline-red-600 outline-dashed" : ""}`}
                    style={{
                      ...barBackground(r, first, last, tone),
                      gridColumn: `${dayIndex(first) + 2} / ${dayIndex(last) + 3}`,
                      gridRow: (lanes.get(r.id) ?? 0) + 1,
                    }}
                  >
                    {r.startDate < from && <span aria-hidden>◀</span>}
                    <span className="truncate">
                      {conflict || possibleConflict || fit === "too_long" ? "⚠ " : fit === "unknown" ? "? " : ""}
                      {label}
                    </span>
                    {r.endDate > to && <span aria-hidden className="ml-auto">▶</span>}
                  </Link>
                );
              })}

              {berthNotes.map((n) => (
                <NoteLabel key={n.id} note={n} column={dayIndex(n.date)} row={rows + (noteLanes.get(n.id) ?? 0) + 1} dayCount={dayCount} />
              ))}
            </div>
          );
        })}

        {/* notes that aren't tied to a berth */}
        {unassignedNotes.length > 0 && (
          <div className="grid" style={{ gridTemplateColumns: columns, gridAutoRows: "minmax(30px, auto)" }}>
            <div className="border-r border-slate-200 px-3 py-2 text-xs font-medium text-slate-500" style={{ gridRow: `1 / span ${laneCount(unassignedLanes)}` }}>
              Notes
            </div>
            {days.map((d, i) => (
              <div key={d} className="border-l border-slate-100" style={{ gridColumn: i + 2, gridRow: `1 / span ${laneCount(unassignedLanes)}` }} />
            ))}
            {unassignedNotes.map((n) => (
              <NoteLabel key={n.id} note={n} column={dayIndex(n.date)} row={(unassignedLanes.get(n.id) ?? 0) + 1} dayCount={dayCount} />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-slate-200 px-3 py-2 text-xs text-slate-600">
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-sky-500 align-middle" /> vessel</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-violet-500 align-middle" /> event</span>
        <span>
          <i
            className="mr-1 inline-block h-3 w-5 rounded-sm border border-sky-700 align-middle"
            style={{ backgroundColor: TONES.vessel.tint, backgroundImage: `repeating-linear-gradient(135deg, ${TONES.vessel.solid}55 0 3px, transparent 3px 7px)` }}
          />{" "}
          estimated days (imported, not confirmed)
        </span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-red-500 align-middle" /> double-booked</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-white align-middle outline-2 outline-offset-1 outline-red-600 outline-dashed" /> possibly double-booked</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm bg-amber-400 align-middle" /> too long for berth</span>
        <span><i className="mr-1 inline-block h-3 w-3 rounded-sm border border-amber-300 bg-amber-50 align-middle" /> note</span>
        <span className="text-slate-400">? = vessel length unknown · dashed border = saved with an override {canEdit && "· click an empty day to book it"}</span>
      </div>
    </div>
  );
}
