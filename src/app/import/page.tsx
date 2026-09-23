"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client";
import { formatDate, formatRange, rangeLength } from "@/lib/dates";
import type { ImportResult } from "@/lib/importer";
import type { ParsedSchedule } from "@/lib/schedule-csv";

const SAMPLE_URL = "/sample/dock-schedule-2018.csv";

interface Source {
  name: string;
  csv: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warn" }) {
  return (
    <div className="card px-3 py-2">
      <div className={`text-lg font-semibold ${tone === "warn" ? "text-amber-700" : "text-slate-900"}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function ImportPage() {
  const [source, setSource] = useState<Source | null>(null);
  const [year, setYear] = useState("");
  const [previewResult, setPreview] = useState<{ key: string; data: ParsedSchedule } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // An incomplete year pauses preview; clearing it restores the sheet year.
  const yearOverride = year.length === 4 ? year : undefined;
  const yearComplete = year === "" || year.length === 4;
  const requestKey = source && yearComplete ? JSON.stringify({ csv: source.csv, year: yearOverride }) : null;
  const preview = requestKey && previewResult?.key === requestKey ? previewResult.data : null;
  const loadingSource = useRef(0);
  const importInFlight = useRef(false);

  // Preview (dry run) whenever the file or the year changes. Nothing is written.
  useEffect(() => {
    if (!requestKey) return;
    let active = true;
    const timer = setTimeout(() => {
      setPreviewing(true);
      api<ParsedSchedule>("/api/import", { method: "POST", json: { ...JSON.parse(requestKey), dryRun: true } })
        .then((p) => {
          if (!active) return;
          setError(null);
          setPreview({ key: requestKey, data: p });
        })
        .catch((err) => {
          if (!active) return;
          setPreview(null);
          setError(errorMessage(err));
        })
        .finally(() => active && setPreviewing(false));
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [requestKey]);

  function choose(next: Source) {
    setResult(null);
    setPreview(null);
    setError(null);
    setSource(next);
  }

  async function pickFile(file: File | undefined) {
    if (!file || importInFlight.current) return;
    const version = ++loadingSource.current;
    setPreview(null);
    setSource(null);
    setResult(null);
    try {
      const csv = await file.text();
      if (version === loadingSource.current) choose({ name: file.name, csv });
    } catch (err) {
      if (version === loadingSource.current) setError(errorMessage(err));
    }
  }

  async function useSample() {
    if (importInFlight.current) return;
    const version = ++loadingSource.current;
    setPreview(null);
    setSource(null);
    setResult(null);
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(`Couldn't load the sample (${response.status}).`);
      const csv = await response.text();
      if (version !== loadingSource.current) return;
      if (fileInput.current) fileInput.current.value = "";
      choose({ name: "Dock Schedule – Synthetic Sample 2018.csv", csv });
    } catch (err) {
      if (version === loadingSource.current) setError(errorMessage(err));
    }
  }

  async function runImport() {
    if (!requestKey || !preview || previewing || importInFlight.current) return;
    importInFlight.current = true;
    setImporting(true);
    setError(null);
    try {
      setResult(await api<ImportResult>("/api/import", { method: "POST", json: JSON.parse(requestKey) }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      importInFlight.current = false;
      setImporting(false);
    }
  }

  const warnings = preview?.diagnostics.filter((d) => d.level === "warning") ?? [];
  const infos = preview?.diagnostics.filter((d) => d.level === "info") ?? [];
  const estimatedStays = preview?.reservations.filter((r) => r.knownDates.length < rangeLength(r.startDate, r.endDate)).length ?? 0;

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Import the old spreadsheet</h1>
        <p className="mt-1 text-sm text-slate-600">
          Export one year of the dock schedule as CSV and load it here. You&apos;ll see exactly what the importer read, and every judgement call it made, before
          anything is saved.
        </p>
      </div>

      <div className="card flex flex-wrap items-end gap-4 p-4">
        <div>
          <label className="label" htmlFor="file">
            CSV file
          </label>
          <input ref={fileInput} id="file" disabled={importing} type="file" accept=".csv,text/csv" className="text-sm" onChange={(e) => pickFile(e.target.files?.[0])} />
        </div>
        <div className="text-sm text-slate-400">or</div>
        <button type="button" className="btn" disabled={importing} onClick={useSample}>
          Use the 2018 sample
        </button>
        <div>
          <label className="label" htmlFor="year">
            Year (optional)
          </label>
          <input
            id="year"
            disabled={importing}
            className="input w-28"
            inputMode="numeric"
            placeholder="from sheet"
            value={year}
            onChange={(e) => {
              setResult(null);
              setYear(e.target.value.replace(/\D/g, "").slice(0, 4));
            }}
          />
        </div>
        {source && <p className="w-full text-xs text-slate-500">Loaded: {source.name}</p>}
      </div>

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!yearComplete && <p className="text-sm text-slate-500">Finish the four-digit year or clear it to use the sheet year.</p>}
      {previewing && yearComplete && !preview && <p className="text-sm text-slate-500">Reading the file…</p>}

      {result && (
        <div className="card space-y-2 border-emerald-300 bg-emerald-50 p-4 text-sm">
          <p className="font-medium text-emerald-900">
            {result.reservationsAdded + result.reservationsJoined + result.notesAdded === 0
              ? `Nothing new: this ${result.year} sheet was already imported.`
              : `Imported ${result.year}.`}
          </p>
          <p className="text-emerald-900">
            {plural(result.reservationsAdded, "stay")} added
            {result.reservationsJoined > 0 && `, ${plural(result.reservationsJoined, "stay")} joined onto one from the neighbouring year`}
            {result.reservationsSkipped > 0 && `, ${plural(result.reservationsSkipped, "stay")} skipped because those cells were already imported`}.{" "}
            {plural(result.notesAdded, "note")} added{result.notesSkipped > 0 && `, ${result.notesSkipped} already there`}. {plural(result.berthsCreated, "new berth")},{" "}
            {plural(result.vesselsCreated, "new vessel")}.
          </p>
          <p className="text-emerald-900">
            Every imported stay is <strong>unconfirmed</strong> until someone checks its dates.{" "}
            <Link href={`/?y=${result.year}&m=1`} className="underline">
              Open January {result.year}
            </Link>{" "}
            ·{" "}
            <Link href="/reservations?unconfirmed=1" className="underline">
              Stays to check
            </Link>
          </p>
        </div>
      )}

      {preview && (
        <div className={`space-y-5 ${previewing ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
            <Stat label="year" value={preview.year} />
            <Stat label="berths" value={preview.berths.length} />
            <Stat label="vessels" value={preview.vessels.length} />
            <Stat label="stays" value={preview.reservations.length} />
            <Stat label="notes" value={preview.notes.length} />
            <Stat label="warnings" value={warnings.length} tone={warnings.length ? "warn" : undefined} />
          </div>

          {!result && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary" onClick={runImport} disabled={importing || previewing}>
                {importing ? "Importing…" : `Import ${preview.year}`}
              </button>
              <p className="text-xs text-slate-500">
                Safe to repeat: cells that were already imported are skipped, even if those stays were edited since. {estimatedStays} of{" "}
                {preview.reservations.length} stays include estimated days and all of them arrive unconfirmed.
              </p>
            </div>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">What the importer decided</h2>
            <ul className="card divide-y divide-slate-100 text-sm">
              {[...warnings, ...infos].map((d, i) => (
                <li key={i} className="flex gap-3 px-3 py-2">
                  <span
                    className={`h-fit shrink-0 rounded px-1.5 text-xs font-medium ${d.level === "warning" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                  >
                    {d.level === "warning" ? "warning" : "info"}
                  </span>
                  <span className="w-16 shrink-0 text-xs text-slate-400">{d.row ? `row ${d.row}` : ""}</span>
                  <span className="text-slate-700">{d.message}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Stays ({preview.reservations.length})</h2>
            <div className="card max-h-[32rem] overflow-auto">
              <table className="table">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    <th>Berth</th>
                    <th>Vessel</th>
                    <th>Dates</th>
                    <th>Shown in the sheet</th>
                    <th>Cells</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.reservations.map((r) => {
                    const days = rangeLength(r.startDate, r.endDate);
                    return (
                      <tr key={r.cells.join(" ")}>
                        <td className="whitespace-nowrap">{r.berthName}</td>
                        <td className="whitespace-nowrap font-medium">{r.vesselName}</td>
                        <td className="whitespace-nowrap">
                          {formatRange(r.startDate, r.endDate)} <span className="text-slate-400">({days})</span>
                        </td>
                        <td>
                          {r.knownDates.length ? r.knownDates.map(formatDate).join(", ") : <span className="text-slate-400">no specific day</span>}
                          {r.knownDates.length < days && <span className="text-slate-400"> · {days - r.knownDates.length} estimated</span>}
                        </td>
                        <td className="font-mono text-xs text-slate-500">{r.cells.join(" ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Notes ({preview.notes.length})</h2>
            <p className="text-xs text-slate-500">Text that isn&apos;t a vessel booking. Notes show on the schedule but never block a berth.</p>
            <div className="card max-h-80 overflow-auto">
              <table className="table">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    <th>Date</th>
                    <th>Berth</th>
                    <th>Text</th>
                    <th>Cell</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.notes.map((n) => (
                    <tr key={n.cell}>
                      <td className="whitespace-nowrap">{formatDate(n.date)}</td>
                      <td className="whitespace-nowrap">{n.berthName ?? <span className="text-slate-400">none</span>}</td>
                      <td>{n.text}</td>
                      <td className="font-mono text-xs text-slate-500">{n.cell}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
