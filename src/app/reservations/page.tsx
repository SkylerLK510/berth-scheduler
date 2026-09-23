"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";
import { checkFit, hasEstimatedDays } from "@/lib/conflicts";
import { formatDate, formatRange, rangeLength } from "@/lib/dates";
import type { DataSummary } from "@/lib/repo";
import type { Berth, ReservationView } from "@/lib/types";

/** Hover text for an unconfirmed stay: which days the sheet showed, and where it came from. */
function unconfirmedTitle(r: ReservationView): string {
  const known = r.knownDates.filter((d) => d >= r.startDate && d <= r.endDate);
  return [
    "Imported dates nobody has checked yet.",
    known.length ? `The sheet shows ${known.map(formatDate).join(", ")}.` : "The sheet shows no specific day.",
    hasEstimatedDays(r) ? "The other days are estimated." : null,
    r.sourceRef ? `Cells: ${r.sourceRef}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function ReservationsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { canEdit } = useDispatcher();
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [berths, setBerths] = useState<Berth[]>([]);
  const [rows, setRows] = useState<ReservationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [year, setYear] = useState<string>("");
  const [berthId, setBerthId] = useState<string>("");
  const [q, setQ] = useState("");
  // ?unconfirmed=1 lets other pages (Issues) link straight to the stays that need checking.
  const [arrivedUnconfirmed] = useState(params.get("unconfirmed") === "1");
  const [unconfirmed, setUnconfirmed] = useState(arrivedUnconfirmed);

  const toggleUnconfirmed = (on: boolean) => {
    setUnconfirmed(on);
    router.replace(on ? "/reservations?unconfirmed=1" : "/reservations", { scroll: false });
  };

  useEffect(() => {
    Promise.all([api<DataSummary>("/api/summary"), api<Berth[]>("/api/berths")])
      .then(([s, b]) => {
        setSummary(s);
        setBerths(b);
        // Unconfirmed stays can be in any year, so arriving with the filter on shows all of them.
        if (arrivedUnconfirmed) setYear("all");
        else if (s.years.length && !s.years.includes(new Date().getFullYear())) setYear(String(s.years[s.years.length - 1]));
        else setYear(String(new Date().getFullYear()));
      })
      .catch((err) => setError(errorMessage(err)));
  }, [arrivedUnconfirmed]);

  useEffect(() => {
    if (!year) return;
    const query = new URLSearchParams();
    if (year !== "all") {
      query.set("from", `${year}-01-01`);
      query.set("to", `${year}-12-31`);
    }
    if (berthId) query.set("berthId", berthId);
    if (q.trim()) query.set("q", q.trim());
    if (unconfirmed) query.set("unconfirmed", "1");
    // `active` drops a reply that arrives after the filters changed again, so an older, slower
    // request can't overwrite the rows for the newer filters.
    let active = true;
    const timer = setTimeout(() => {
      api<ReservationView[]>(`/api/reservations?${query}`)
        .then((r) => {
          if (!active) return;
          setError(null);
          setRows(r);
        })
        .catch((err) => active && setError(errorMessage(err)));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [year, berthId, q, unconfirmed]);

  const years = new Set<number>([new Date().getFullYear(), ...(summary?.years ?? [])]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-xl font-semibold">Reservations</h1>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <select className="input w-auto" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
            {[...years].sort().map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
            <option value="all">All years</option>
          </select>
          <select className="input w-auto" value={berthId} onChange={(e) => setBerthId(e.target.value)} aria-label="Berth">
            <option value="">All berths</option>
            {berths.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <input className="input w-56" placeholder="Search vessel or event…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-1.5 py-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={unconfirmed} onChange={(e) => toggleUnconfirmed(e.target.checked)} />
            Unconfirmed only{summary ? ` (${summary.unconfirmed})` : ""}
          </label>
          {canEdit ? (
            <Link href="/reservations/new" className="btn-primary">
              + New reservation
            </Link>
          ) : (
            <SignInLink className="btn">Sign in to book</SignInLink>
          )}
        </div>
      </div>

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Dates</th>
              <th>Days</th>
              <th>Vessel / event</th>
              <th>Berth</th>
              <th>Fit</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => {
              const fit = r.vesselId != null ? checkFit(r.vesselLengthFt, r.berthLengthFt) : null;
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap">{formatRange(r.startDate, r.endDate)}</td>
                  <td>{rangeLength(r.startDate, r.endDate)}</td>
                  <td>
                    <span className="font-medium">{r.vesselName ?? r.title}</span>
                    {r.vesselName && r.title && <span className="text-slate-500"> – {r.title}</span>}
                    {r.vesselId == null && <span className="ml-1 rounded bg-violet-100 px-1.5 text-xs text-violet-800">event</span>}
                    {!r.confirmed && (
                      <span className="ml-1 rounded border border-dashed border-sky-400 bg-sky-50 px-1.5 text-xs text-sky-800" title={unconfirmedTitle(r)}>
                        unconfirmed
                      </span>
                    )}
                    {r.overrideReason && <span className="ml-1 rounded bg-amber-100 px-1.5 text-xs text-amber-800" title={r.overrideReason}>override</span>}
                  </td>
                  <td>
                    {r.berthName} <span className="text-slate-400">{r.berthLengthFt != null ? `${r.berthLengthFt}'` : ""}</span>
                  </td>
                  <td>
                    {fit === "fits" && <span className="text-emerald-700">✓ {`${r.vesselLengthFt}'`}</span>}
                    {fit === "too_long" && <span className="font-medium text-amber-700">✗ {`${r.vesselLengthFt}' is too long`}</span>}
                    {fit === "unknown" && <span className="text-slate-400">? unknown</span>}
                    {fit === null && <span className="text-slate-300">–</span>}
                  </td>
                  <td className="text-slate-500">{r.source === "import" ? "spreadsheet" : "manual"}</td>
                  <td className="text-right">
                    <Link href={`/reservations/${r.id}`} className="text-sky-700 underline">
                      {canEdit ? "edit" : "view"}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-500">
                  {unconfirmed ? "No unconfirmed reservations match. Every imported stay in view has been checked." : "No reservations match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows && <p className="text-xs text-slate-500">{rows.length} reservation{rows.length === 1 ? "" : "s"}</p>}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <ReservationsPage />
    </Suspense>
  );
}
