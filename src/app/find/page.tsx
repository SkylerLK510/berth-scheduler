"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { BerthAvailability } from "@/app/api/availability/route";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";
import { addDays, formatRange, rangeLength, todayIso } from "@/lib/dates";
import type { ReservationView, Vessel } from "@/lib/types";

interface Availability {
  startDate: string;
  endDate: string;
  lengthFt: number | null;
  berths: BerthAvailability[];
}

const STATUS_RANK = { free: 0, maybe: 1, busy: 2 };
const FIT_RANK = { fits: 0, unknown: 1, too_long: 2 };

/** Usable berths first (not busy, not too short), then free before maybe, then fits before unknown. */
function rank(b: BerthAvailability): number {
  const unusable = b.status === "busy" || b.fit === "too_long" ? 10 : 0;
  return unusable + STATUS_RANK[b.status] * 3 + FIT_RANK[b.fit];
}

function stayLabel(r: ReservationView) {
  return `${r.vesselName ?? r.title} (${formatRange(r.startDate, r.endDate)})`;
}

export default function FindPage() {
  const { canEdit } = useDispatcher();
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [vesselId, setVesselId] = useState("");
  const [lengthFt, setLengthFt] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(addDays(todayIso(), 2));
  const [result, setResult] = useState<Availability | null>(null);
  // The chosen vessel's own bookings in the window, keyed by the query they answer.
  const [elsewhere, setElsewhere] = useState<{ key: string; stays: ReservationView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Vessel[]>("/api/vessels").then(setVessels).catch((err) => setError(errorMessage(err)));
  }, []);

  const valid = startDate && endDate && endDate >= startDate;
  const query = new URLSearchParams({ startDate, endDate });
  if (vesselId) query.set("vesselId", vesselId);
  else if (lengthFt) query.set("lengthFt", lengthFt);
  const url = valid ? `/api/availability?${query}` : null;

  // Search as the inputs change. `active` drops a reply that arrives after they changed again.
  useEffect(() => {
    if (!url) return;
    let active = true;
    const timer = setTimeout(() => {
      api<Availability>(url)
        .then((r) => {
          if (!active) return;
          setError(null);
          setResult(r);
        })
        .catch((err) => active && setError(errorMessage(err)));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [url]);

  // Availability is per berth. Separately, check whether the vessel itself is already booked somewhere then.
  const elsewhereKey = valid && vesselId ? `/api/reservations?${new URLSearchParams({ vesselId, from: startDate, to: endDate })}` : null;
  useEffect(() => {
    if (!elsewhereKey) return;
    let active = true;
    api<ReservationView[]>(elsewhereKey)
      .then((stays) => active && setElsewhere({ key: elsewhereKey, stays }))
      .catch(() => active && setElsewhere(null));
    return () => {
      active = false;
    };
  }, [elsewhereKey]);
  const vesselBusy = elsewhereKey && elsewhere?.key === elsewhereKey ? elsewhere.stays : [];

  // Only show results that match the current inputs, never a previous search.
  const vessel = vessels.find((v) => String(v.id) === vesselId);
  const expectedLength = vessel ? vessel.lengthFt : lengthFt ? Number(lengthFt) : null;
  const current =
    result && valid && result.startDate === startDate && result.endDate === endDate && result.lengthFt === expectedLength ? result : null;
  const sorted = current ? [...current.berths].sort((a, b) => rank(a) - rank(b) || a.berthName.localeCompare(b.berthName)) : [];

  const bookHref = (b: BerthAvailability) => {
    const p = new URLSearchParams({ berthId: String(b.berthId), date: startDate, endDate });
    if (vesselId) p.set("vesselId", vesselId);
    return `/reservations/new?${p}`;
  };

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Find a berth</h1>
        <p className="text-sm text-slate-500">Pick a vessel (or just its length) and the days you need. Every berth is checked for the whole stay and for fit.</p>
      </div>

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="vessel">
            Vessel
          </label>
          <select
            id="vessel"
            className="input"
            value={vesselId}
            onChange={(e) => {
              setVesselId(e.target.value);
              if (e.target.value) setLengthFt("");
            }}
          >
            <option value="">Not on file / any vessel</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} {v.lengthFt != null ? `(${v.lengthFt}')` : "(length unknown)"}
              </option>
            ))}
          </select>
        </div>
        <div className="w-32">
          <label className="label" htmlFor="len">
            or length (ft)
          </label>
          <input
            id="len"
            className="input"
            type="number"
            min="1"
            step="any"
            value={vessel ? (vessel.lengthFt ?? "") : lengthFt}
            placeholder={vessel ? "unknown" : "e.g. 180"}
            disabled={!!vessel}
            onChange={(e) => setLengthFt(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="start">
            First day
          </label>
          <input
            id="start"
            type="date"
            className="input"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              if (endDate < e.target.value) setEndDate(e.target.value);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="end">
            Last day
          </label>
          <input id="end" type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!valid && <p className="text-sm text-amber-700">Choose a last day on or after the first day.</p>}
      {valid && !current && !error && <p className="text-sm text-slate-500">Checking every berth…</p>}

      {current && (
        <>
          <p className="text-sm text-slate-600">
            {formatRange(startDate, endDate)} · {rangeLength(startDate, endDate)} day{rangeLength(startDate, endDate) === 1 ? "" : "s"}
            {current.lengthFt != null ? ` · ${current.lengthFt}' vessel` : vessel ? " · vessel length unknown, so fit can't be checked" : ""}
          </p>
          {vesselBusy.length > 0 && (
            <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              {vessel?.name} is already booked in these dates:{" "}
              {vesselBusy.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && ", "}
                  <Link href={`/reservations/${r.id}`} className="underline">
                    {r.berthName} ({formatRange(r.startDate, r.endDate)})
                  </Link>
                  {!r.confirmed && " (unconfirmed dates)"}
                </span>
              ))}
              . A berth below can be free while the vessel is somewhere else.
            </p>
          )}
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Berth</th>
                  <th>Berth availability</th>
                  <th>Fit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => (
                  <tr key={b.berthId} className={b.status === "busy" || b.fit === "too_long" ? "text-slate-400" : ""}>
                    <td className="whitespace-nowrap">
                      <span className="font-medium">{b.berthName}</span> {b.berthLengthFt != null ? `${b.berthLengthFt}'` : <span className="text-slate-400">length not set</span>}
                    </td>
                    <td>
                      {b.status === "free" && <span className="font-medium text-emerald-700">Berth free every day</span>}
                      {b.status === "maybe" && (
                        <span className="text-amber-800" title="These imported stays overlap only on days estimated from the spreadsheet.">
                          Maybe: overlaps estimated days of {b.maybe.map(stayLabel).join(", ")}
                        </span>
                      )}
                      {b.status === "busy" && (
                        <span className="text-red-700">
                          Taken:{" "}
                          {b.busy.map((r, i) => (
                            <span key={r.id}>
                              {i > 0 && ", "}
                              <Link href={`/reservations/${r.id}`} className="underline">
                                {stayLabel(r)}
                              </Link>
                            </span>
                          ))}
                          {b.maybe.length > 0 && <span className="text-amber-800">; maybe also {b.maybe.map(stayLabel).join(", ")}</span>}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {b.fit === "fits" && <span className="text-emerald-700">✓ fits</span>}
                      {b.fit === "too_long" && <span className="font-medium text-amber-700">✗ too short</span>}
                      {b.fit === "unknown" && <span className="text-slate-400">? unknown</span>}
                    </td>
                    <td className="text-right">
                      {b.status !== "busy" && b.fit !== "too_long" &&
                        (canEdit ? (
                          <Link href={bookHref(b)} className={b.status === "free" ? "btn-primary" : "btn"}>
                            Book
                          </Link>
                        ) : (
                          <SignInLink className="whitespace-nowrap text-xs text-sky-700 underline">Sign in to book</SignInLink>
                        ))}
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-slate-500">
                      No berths yet. Add them on the <Link href="/berths" className="underline">Berths page</Link>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            &ldquo;Maybe&rdquo; means the only overlap is with days estimated from the old spreadsheet, which recorded when a vessel was listed but not when it
            left. Booking there is allowed, with a possible-conflict warning.
          </p>
        </>
      )}
    </div>
  );
}
