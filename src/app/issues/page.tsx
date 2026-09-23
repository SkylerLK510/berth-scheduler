"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/client";
import { certainOverlapDays, hasEstimatedDays, type OverlapPair } from "@/lib/conflicts";
import { formatRange } from "@/lib/dates";
import type { Berth, ReservationView, Vessel } from "@/lib/types";

interface Issues {
  totals: { reservations: number; vessels: number; berths: number };
  doubleBookings: OverlapPair[];
  possibleDoubleBookings: OverlapPair[];
  vesselsInTwoPlaces: OverlapPair[];
  doesNotFit: ReservationView[];
  fitUnknownCount: number;
  overridden: ReservationView[];
  unconfirmedCount: number;
  vesselsWithoutLength: Vessel[];
  berthsWithoutLength: Berth[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A reservation as a link, with its dates and an "unconfirmed" marker when part of it is a guess. */
function Stay({ r, showBerth = false }: { r: ReservationView; showBerth?: boolean }) {
  return (
    <span>
      <Link href={`/reservations/${r.id}`} className="font-medium text-sky-800 underline">
        {r.vesselName ?? r.title}
      </Link>{" "}
      <span className="text-slate-500">
        {showBerth && `${r.berthName}, `}
        {formatRange(r.startDate, r.endDate)}
      </span>
      {!r.confirmed && (
        <span
          className="ml-1 rounded border border-dashed border-sky-400 bg-sky-50 px-1 text-xs text-sky-800"
          title={hasEstimatedDays(r) ? "Imported; some days are estimated" : "Imported; dates not confirmed"}
        >
          unconfirmed
        </span>
      )}
    </span>
  );
}

/** The days two stays share. */
function overlapRange({ a, b }: OverlapPair): string {
  const start = a.startDate > b.startDate ? a.startDate : b.startDate;
  const end = a.endDate < b.endDate ? a.endDate : b.endDate;
  return formatRange(start, end);
}

function Section({
  title,
  count,
  tone,
  label,
  intro,
  children,
}: {
  title: string;
  count: number;
  tone: "red" | "amber" | "slate";
  /** Badge text instead of the count, for sections that mix different kinds of thing. */
  label?: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  const badge = count === 0 ? "bg-emerald-100 text-emerald-800" : tone === "red" ? "bg-red-100 text-red-800" : tone === "amber" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700";
  return (
    <section className="card p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {title}
        <span className={`rounded-full px-2 text-xs font-medium ${badge}`}>{count === 0 ? "none" : (label ?? count)}</span>
      </h2>
      <p className="mt-1 text-sm text-slate-500">{intro}</p>
      {count > 0 && <div className="mt-3">{children}</div>}
    </section>
  );
}

function PairList({ pairs, showBerth = false }: { pairs: OverlapPair[]; showBerth?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {pairs.map((p) => (
        <li key={`${p.a.id}-${p.b.id}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
          {!showBerth && <span className="w-40 shrink-0 font-medium text-slate-700">{p.a.berthName}</span>}
          <Stay r={p.a} showBerth={showBerth} />
          <span className="text-slate-400">and</span>
          <Stay r={p.b} showBerth={showBerth} />
          <span className="text-xs text-slate-500">
            {p.overlap === "definite"
              ? `Known conflict days: ${certainOverlapDays(p.a, p.b).map((d) => formatRange(d.start, d.end)).join(", ")}`
              : `Possible overlap: ${overlapRange(p)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function IssuesPage() {
  const [issues, setIssues] = useState<Issues | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Issues>("/api/issues").then(setIssues).catch((err) => setError(errorMessage(err)));
  }, []);

  if (error) return <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!issues) return <p className="text-sm text-slate-500">Checking the whole schedule…</p>;

  const certainElsewhere = issues.vesselsInTwoPlaces.filter((p) => p.overlap === "definite");
  const possibleElsewhere = issues.vesselsInTwoPlaces.filter((p) => p.overlap === "possible");
  const needsAction = issues.doubleBookings.length + issues.doesNotFit.length + certainElsewhere.length;

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Issues</h1>
        <p className="text-sm text-slate-500">
          The checks that used to mean scanning the grid by hand, run over all {plural(issues.totals.reservations, "reservation")}.{" "}
          {needsAction === 0 ? "Nothing is certainly wrong." : `${plural(needsAction, "problem")} certainly need${needsAction === 1 ? "s" : ""} fixing.`}
        </p>
      </div>

      <Section
        title="Double-booked"
        count={issues.doubleBookings.length}
        tone="red"
        intro="Two bookings on the same berth on a day both are certain to be there."
      >
        <PairList pairs={issues.doubleBookings} />
      </Section>

      <Section title="Too long for the berth" count={issues.doesNotFit.length} tone="red" intro="The vessel's length overall is more than the berth length.">
        <ul className="divide-y divide-slate-100 text-sm">
          {issues.doesNotFit.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-2 py-2">
              <Stay r={r} showBerth />
              <span className="text-amber-800">
                {r.vesselLengthFt}&apos; in a {r.berthLengthFt}&apos; berth
              </span>
              {r.overrideReason && <span className="text-xs text-slate-500">override: “{r.overrideReason}”</span>}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Vessel in two places"
        count={issues.vesselsInTwoPlaces.length}
        tone={certainElsewhere.length ? "red" : "amber"}
        intro="The same vessel booked at two berths on overlapping days."
      >
        {certainElsewhere.length > 0 && <PairList pairs={certainElsewhere} showBerth />}
        {possibleElsewhere.length > 0 && (
          <>
            <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">Only on estimated days</p>
            <PairList pairs={possibleElsewhere} showBerth />
          </>
        )}
      </Section>

      <Section
        title="Possibly double-booked"
        count={issues.possibleDoubleBookings.length}
        tone="amber"
        intro="These overlap only on days estimated from the spreadsheet, which only recorded the day a name was typed. Check the real dates and confirm them."
      >
        <PairList pairs={issues.possibleDoubleBookings} />
      </Section>

      <Section title="Saved with an override" count={issues.overridden.length} tone="slate" intro="Bookings someone saved despite a conflict or fit problem, with their reason.">
        <ul className="divide-y divide-slate-100 text-sm">
          {issues.overridden.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-2 py-2">
              <Stay r={r} showBerth />
              <span className="text-slate-600">“{r.overrideReason}”</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Missing information"
        count={issues.unconfirmedCount + issues.fitUnknownCount + issues.vesselsWithoutLength.length + issues.berthsWithoutLength.length}
        tone="slate"
        label="to fill in"
        intro="Gaps that stop the checks above from being certain."
      >
        <ul className="space-y-2 text-sm">
          {issues.unconfirmedCount > 0 && (
            <li>
              <Link href="/reservations?unconfirmed=1" className="font-medium text-sky-800 underline">
                {plural(issues.unconfirmedCount, "imported stay")}
              </Link>{" "}
              still {issues.unconfirmedCount === 1 ? "has" : "have"} unconfirmed dates.
            </li>
          )}
          {issues.fitUnknownCount > 0 && (
            <li>
              {plural(issues.fitUnknownCount, "vessel booking")} can&apos;t be fit-checked because a vessel or berth length is missing.
            </li>
          )}
          {issues.vesselsWithoutLength.length > 0 && (
            <li>
              <Link href="/vessels" className="font-medium text-sky-800 underline">
                {plural(issues.vesselsWithoutLength.length, "vessel")}
              </Link>{" "}
              without a length: <span className="text-slate-600">{issues.vesselsWithoutLength.map((v) => v.name).join(", ")}</span>
            </li>
          )}
          {issues.berthsWithoutLength.length > 0 && (
            <li>
              <Link href="/berths" className="font-medium text-sky-800 underline">
                {plural(issues.berthsWithoutLength.length, "berth")}
              </Link>{" "}
              without a length: <span className="text-slate-600">{issues.berthsWithoutLength.map((b) => b.name).join(", ")}</span>
            </li>
          )}
        </ul>
      </Section>
    </div>
  );
}
