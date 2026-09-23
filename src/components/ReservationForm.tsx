"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import ProblemList from "@/components/ProblemList";
import { api, ApiError, errorMessage } from "@/lib/client";
import { formatDate, formatRange, rangeLength } from "@/lib/dates";
import type { Berth, Problem, ReservationView, Vessel } from "@/lib/types";

export interface FormValues {
  kind: "vessel" | "event";
  berthId: string;
  vesselId: string;
  title: string;
  startDate: string;
  endDate: string;
  notes: string;
}

interface Props {
  initial: FormValues;
  /** Present when editing an existing reservation. */
  reservationId?: number;
  overrideReason?: string | null;
  /** Present when editing an imported stay whose dates nobody has confirmed yet. */
  unconfirmed?: Original;
}

/** Where the spreadsheet put an unconfirmed stay, before any edits. */
interface Original {
  knownDates: string[];
  sourceRef: string | null;
  berthId: number;
  berthName: string;
  vesselId: number | null;
  vesselName: string | null;
}

/**
 * What the sheet says about an unconfirmed stay, kept apart from how it's assigned now, and
 * the confirm-dates checkbox. `known` is how the save would store it: the server's answer when
 * the live check has one, otherwise null while it's pending.
 */
function ImportedDates({
  original,
  moved,
  known,
  startDate,
  endDate,
  confirm,
  onConfirm,
}: {
  original: Original;
  moved: boolean;
  known: string[] | null;
  startDate: string;
  endDate: string;
  confirm: boolean;
  onConfirm: (on: boolean) => void;
}) {
  const valid = startDate && endDate && endDate >= startDate;
  const total = valid ? rangeLength(startDate, endDate) : 0;
  const who = original.vesselName ?? "this stay";

  return (
    <div className="rounded-md border border-dashed border-sky-400 bg-sky-50 p-3 text-sm text-slate-700">
      <p className="font-medium text-sky-900">Imported from the spreadsheet. These dates haven&apos;t been checked.</p>

      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">What the sheet shows</p>
      <p>
        {original.knownDates.length
          ? `${who} at ${original.berthName} on ${original.knownDates.map(formatDate).join(", ")}.`
          : `${who} at ${original.berthName}, with no specific day (the name was written beside the grid).`}{" "}
        The sheet only records the day a name was typed, not when the vessel left.
        {original.sourceRef && (
          <>
            {" "}
            Cells: <span className="font-mono text-xs">{original.sourceRef}</span>
          </>
        )}
      </p>

      {!confirm && (
        <>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">If you save without confirming</p>
          <p>
            {moved
              ? "The berth or vessel no longer matches the sheet, so none of its days count as known here. "
              : ""}
            {known == null || !valid
              ? "Checking which days stay known…"
              : known.length
                ? `Known: ${known.map(formatDate).join(", ")}. Estimated: the other ${total - known.length} of ${total} days.`
                : `Known: none. All ${total} days are estimated.`}
            {!moved && known != null && valid && known.length < original.knownDates.length && (
              <span className="text-amber-800"> Days the sheet shows outside {formatRange(startDate, endDate)} no longer count.</span>
            )}{" "}
            A clash on an estimated day is a possible conflict, not a real one.
          </p>
        </>
      )}

      <label className="mt-3 flex items-start gap-2 font-medium text-slate-900">
        <input type="checkbox" className="mt-0.5" checked={confirm} onChange={(e) => onConfirm(e.target.checked)} />
        I&apos;ve checked these dates
      </label>
      {confirm && (
        <p className="mt-1 text-xs text-slate-600">
          Saving marks every day from {valid ? formatRange(startDate, endDate) : "the start to the end"} as certain, so a clash on any of them is a real conflict.
          The checks below already count them that way.
        </p>
      )}
    </div>
  );
}

export default function ReservationForm({ initial, reservationId, overrideReason, unconfirmed }: Props) {
  const router = useRouter();
  const { canEdit } = useDispatcher();
  const [values, setValues] = useState<FormValues>(initial);
  const [berths, setBerths] = useState<Berth[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  // Result of the last live check, tagged with the inputs it was for.
  const [check, setCheck] = useState<{ key: string; problems: Problem[]; knownDates?: string[]; error?: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [override, setOverride] = useState(Boolean(overrideReason));
  const [reason, setReason] = useState(overrideReason ?? "");
  const [confirmDates, setConfirmDates] = useState(false);

  useEffect(() => {
    Promise.all([api<Berth[]>("/api/berths"), api<Vessel[]>("/api/vessels")])
      .then(([b, v]) => {
        setBerths(b);
        setVessels(v);
      })
      .catch((err) => setErrors([errorMessage(err)]));
  }, []);

  const set = (patch: Partial<FormValues>) => setValues((v) => ({ ...v, ...patch }));

  const payload = () => ({
    berthId: Number(values.berthId),
    vesselId: values.kind === "vessel" && values.vesselId ? Number(values.vesselId) : null,
    title: values.title,
    startDate: values.startDate,
    endDate: values.endDate,
    notes: values.notes,
    confirmDates: unconfirmed != null && confirmDates,
  });

  const complete = values.berthId && values.startDate && values.endDate && (values.kind === "event" ? values.title.trim() : values.vesselId);
  const checkBody = complete && values.endDate >= values.startDate ? { ...payload(), notes: undefined, id: reservationId ?? null } : null;
  const checkKey = checkBody ? JSON.stringify(checkBody) : null;

  // Live check: ask the server about conflicts and fit whenever the relevant fields change.
  useEffect(() => {
    if (!checkKey) return;
    let active = true;
    const timer = setTimeout(() => {
      api<{ problems: Problem[]; knownDates: string[] }>("/api/reservations/check", { method: "POST", body: checkKey, headers: { "Content-Type": "application/json" } })
        .then((r) => { if (active) setCheck({ key: checkKey, problems: r.problems, knownDates: r.knownDates }); })
        .catch((err) => { if (active) setCheck({ key: checkKey, problems: [], error: errorMessage(err) }); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [checkKey]);

  const problems = checkKey && check?.key === checkKey ? check.problems : [];
  const checking = checkKey != null && check?.key !== checkKey;
  const checkError = checkKey && check?.key === checkKey ? check.error : undefined;
  const blocking = problems.some((p) => p.severity === "error");
  // How the server says the save would store the known days (null until the check for these inputs is back).
  const knownAfterSave = checkKey && check?.key === checkKey && !check.error ? (check.knownDates ?? null) : null;
  const moved =
    unconfirmed != null &&
    (Number(values.berthId) !== unconfirmed.berthId || (values.kind === "vessel" && values.vesselId ? Number(values.vesselId) : null) !== unconfirmed.vesselId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSaving(true);
    try {
      const body = { ...payload(), override: blocking && override, overrideReason: reason };
      const result = reservationId
        ? await api<{ reservation: ReservationView }>(`/api/reservations/${reservationId}`, { method: "PATCH", json: body })
        : await api<{ reservation: ReservationView }>("/api/reservations", { method: "POST", json: body });
      const { startDate } = result.reservation;
      router.push(`/?y=${startDate.slice(0, 4)}&m=${Number(startDate.slice(5, 7))}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        if (checkKey) setCheck({ key: checkKey, problems: err.problems });
        setErrors(["This reservation has problems. Fix them, or tick the override box and explain why it's okay."]);
      } else {
        setErrors(err instanceof ApiError ? err.errors : [errorMessage(err)]);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!reservationId || !confirm("Delete this reservation?")) return;
    try {
      await api(`/api/reservations/${reservationId}`, { method: "DELETE" });
      router.push("/reservations");
      router.refresh();
    } catch (err) {
      setErrors([errorMessage(err)]);
    }
  }

  const nights = values.startDate && values.endDate && values.endDate >= values.startDate ? rangeLength(values.startDate, values.endDate) : null;

  return (
    <form onSubmit={submit} className="card max-w-2xl space-y-5 p-5">
      {!canEdit && (
        <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          View only. <SignInLink>Sign in</SignInLink> to change this reservation.
        </p>
      )}
      {/* Disabled for viewers: the server refuses their changes anyway, this just doesn't offer them. */}
      <fieldset disabled={!canEdit} className="min-w-0 space-y-5">
      <div className="flex gap-4 text-sm">
        {(["vessel", "event"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <input type="radio" name="kind" checked={values.kind === k} onChange={() => set({ kind: k })} />
            {k === "vessel" ? "Vessel stay" : "Other event (sail day, reception, maintenance…)"}
          </label>
        ))}
      </div>

      {values.kind === "vessel" ? (
        <div>
          <label className="label" htmlFor="vessel">Vessel</label>
          <select id="vessel" className="input" value={values.vesselId} onChange={(e) => set({ vesselId: e.target.value })} required>
            <option value="">Choose a vessel…</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} {v.lengthFt != null ? `(${v.lengthFt}')` : "(length unknown)"}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Not listed? <Link href="/vessels" className="text-sky-700 underline">Add it on the Vessels page</Link> with its length so fit can be checked.
          </p>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="title">Event</label>
          <input id="title" className="input" value={values.title} onChange={(e) => set({ title: e.target.value })} placeholder="Community sail day" required />
        </div>
      )}

      <div>
        <label className="label" htmlFor="berth">Berth</label>
        <select id="berth" className="input" value={values.berthId} onChange={(e) => set({ berthId: e.target.value })} required>
          <option value="">Choose a berth…</option>
          {berths.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} {b.lengthFt != null ? `– ${b.lengthFt}'` : "– length not set"}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="start">Arrives (first day)</label>
          <input id="start" type="date" className="input" value={values.startDate} onChange={(e) => set({ startDate: e.target.value, endDate: values.endDate < e.target.value ? e.target.value : values.endDate })} required />
        </div>
        <div>
          <label className="label" htmlFor="end">Departs (last day)</label>
          <input id="end" type="date" className="input" value={values.endDate} min={values.startDate} onChange={(e) => set({ endDate: e.target.value })} required />
          {nights != null && <p className="mt-1 text-xs text-slate-500">{nights} day{nights === 1 ? "" : "s"}, both ends inclusive</p>}
        </div>
      </div>

      {values.kind === "vessel" && (
        <div>
          <label className="label" htmlFor="label">Label (optional)</label>
          <input id="label" className="input" value={values.title} onChange={(e) => set({ title: e.target.value })} placeholder="Cruise AT-52 mobilization" />
        </div>
      )}

      <div>
        <label className="label" htmlFor="notes">Notes</label>
        <textarea id="notes" className="input" rows={2} value={values.notes} onChange={(e) => set({ notes: e.target.value })} />
      </div>

      {unconfirmed && (
        <ImportedDates
          original={unconfirmed}
          moved={moved}
          known={knownAfterSave}
          startDate={values.startDate}
          endDate={values.endDate}
          confirm={confirmDates}
          onConfirm={setConfirmDates}
        />
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Checks {checking && <span className="font-normal normal-case text-slate-400">· checking…</span>}
        </div>
        {!complete ? <p className="text-sm text-slate-400">Fill in the berth, dates and vessel to check for conflicts.</p>
          : !checkKey ? <p className="text-sm text-amber-700">Choose a valid date range before checking availability.</p>
          : checking ? <p role="status" className="text-sm text-slate-500">Checking availability and fit…</p>
          : checkError ? <p role="alert" className="text-sm text-amber-700">Could not check availability: {checkError}. Saving will retry validation on the server.</p>
          : <ProblemList problems={problems} emptyText={values.kind === "event" ? "No booking conflicts found." : "No conflicts. Berth is free and the vessel fits."} />}
      </div>

      {blocking && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <label className="flex items-center gap-2 font-medium text-amber-900">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            Save anyway (override)
          </label>
          {override && (
            <input className="input mt-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this okay? e.g. rafted alongside, overhang cleared with dock ops" required />
          )}
          <p className="mt-1 text-xs text-amber-800">Overridden reservations stay flagged on the Issues page so nothing gets forgotten.</p>
        </div>
      )}

      {errors.length > 0 && (
        <ul className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      </fieldset>

      {canEdit && (
      <div className="flex items-center gap-2">
        <button className="btn-primary" type="submit" disabled={saving || (blocking && !override)}>
          {saving ? "Saving…" : reservationId ? "Save changes" : "Create reservation"}
        </button>
        <Link href={reservationId ? "/reservations" : "/"} className="btn">
          Cancel
        </Link>
        {reservationId && (
          <button type="button" className="btn-danger ml-auto" onClick={remove}>
            Delete
          </button>
        )}
      </div>
      )}
    </form>
  );
}
