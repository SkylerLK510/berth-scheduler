"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import ScheduleGrid from "@/components/ScheduleGrid";
import { api, errorMessage } from "@/lib/client";
import { daysInMonth, MONTH_NAMES, toIsoDate } from "@/lib/dates";
import type { DataSummary } from "@/lib/repo";
import type { Berth, DayNote, ReservationView } from "@/lib/types";

interface ScheduleData {
  from: string;
  to: string;
  berths: Berth[];
  reservations: ReservationView[];
  notes: DayNote[];
  conflictIds: number[];
  possibleConflictIds: number[];
}

function SchedulePage() {
  const router = useRouter();
  const params = useSearchParams();
  const { canEdit } = useDispatcher();
  const now = new Date();
  const year = Number(params.get("y")) || now.getFullYear();
  const month = Number(params.get("m")) || now.getMonth() + 1;

  const from = toIsoDate(year, month, 1);
  const to = toIsoDate(year, month, daysInMonth(year, month));

  const [data, setData] = useState<ScheduleData | null>(null);
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<ScheduleData>(`/api/schedule?from=${from}&to=${to}`), api<DataSummary>("/api/summary")])
      .then(([schedule, sum]) => {
        if (cancelled) return;
        setError(null);
        setData(schedule);
        setSummary(sum);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const go = (y: number, m: number) => {
    if (m < 1) {
      y -= 1;
      m = 12;
    } else if (m > 12) {
      y += 1;
      m = 1;
    }
    router.push(`/?y=${y}&m=${m}`);
  };

  const years = new Set<number>([now.getFullYear(), year, ...(summary?.years ?? [])]);
  const conflictCount = data?.conflictIds.length ?? 0;
  const possibleCount = data?.possibleConflictIds.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => go(year, month - 1)} aria-label="Previous month">
          ←
        </button>
        <select className="input w-auto" value={month} onChange={(e) => go(year, Number(e.target.value))} aria-label="Month">
          {MONTH_NAMES.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={year} onChange={(e) => go(Number(e.target.value), month)} aria-label="Year">
          {[...years].sort().map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => go(year, month + 1)} aria-label="Next month">
          →
        </button>
        <button className="btn" onClick={() => go(now.getFullYear(), now.getMonth() + 1)}>
          Today
        </button>
        <div className="ml-auto flex items-center gap-2">
          {conflictCount > 0 && (
            <Link href="/issues" className="rounded-md bg-red-100 px-2.5 py-1 text-sm font-medium text-red-800">
              {conflictCount} double-booked this month
            </Link>
          )}
          {possibleCount > 0 && (
            <Link href="/issues" className="rounded-md border border-dashed border-red-400 px-2.5 py-1 text-sm font-medium text-red-700">
              {possibleCount} possibly double-booked
            </Link>
          )}
          {canEdit ? (
            <Link href={`/reservations/new?date=${from}`} className="btn-primary">
              + New reservation
            </Link>
          ) : (
            <SignInLink className="btn">Sign in to book</SignInLink>
          )}
        </div>
      </div>

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {data ? (
        <ScheduleGrid {...data} canEdit={canEdit} />
      ) : (
        !error && <p className="text-sm text-slate-500">Loading schedule…</p>
      )}

      {summary && summary.reservations === 0 && (
        <div className="card p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-800">Nothing on the schedule yet.</p>
          <p className="mt-1">
            Import a year from the old spreadsheet on the <Link href="/import" className="text-sky-700 underline">Import page</Link> (the 2018 sample is one
            click away), or add berths and reservations by hand.
          </p>
        </div>
      )}
      {summary && summary.reservations > 0 && data && data.reservations.length === 0 && (
        <p className="text-sm text-slate-500">
          No reservations in {MONTH_NAMES[month - 1]} {year}. Years with data:{" "}
          {summary.years.map((y, i) => (
            <span key={y}>
              {i > 0 && ", "}
              <Link href={`/?y=${y}&m=1`} className="text-sky-700 underline">
                {y}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <SchedulePage />
    </Suspense>
  );
}
