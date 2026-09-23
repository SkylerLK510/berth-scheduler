"use client";

import { useEffect, useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";
import type { Berth } from "@/lib/types";

type Draft = { name: string; lengthFt: string; notes: string };

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

export default function BerthsPage() {
  const { canEdit } = useDispatcher();
  const [berths, setBerths] = useState<Berth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", lengthFt: "", notes: "" });
  const [editing, setEditing] = useState<Record<number, Draft>>({});

  const load = () => api<Berth[]>("/api/berths").then(setBerths).catch((err) => setError(errorMessage(err)));
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/berths", { method: "POST", json: { name: draft.name, lengthFt: draft.lengthFt || null, notes: draft.notes } });
      setDraft({ name: "", lengthFt: "", notes: "" });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function save(b: Berth) {
    const d = editing[b.id];
    setError(null);
    try {
      await api(`/api/berths/${b.id}`, { method: "PATCH", json: { name: d.name, lengthFt: d.lengthFt || null, notes: d.notes } });
      setEditing((all) => without(all, b.id));
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(b: Berth) {
    if (!confirm(`Delete ${b.name}?`)) return;
    setError(null);
    try {
      await api(`/api/berths/${b.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      // 409 when the berth still has reservations; the message says how many.
      setError(errorMessage(err));
    }
  }

  const missing = berths?.filter((b) => b.lengthFt == null).length ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Berths</h1>
        <p className="text-sm text-slate-500">
          The usable length of each berth is what a vessel&apos;s length overall is checked against. Berths appear on the schedule in this order.
          {missing > 0 && <span className="ml-1 text-amber-700">{missing} berth{missing === 1 ? " has" : "s have"} no length, so fit can&apos;t be checked there.</span>}
        </p>
      </div>

      {canEdit ? (
      <form onSubmit={add} className="card flex flex-wrap items-end gap-2 p-4">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="name">Name</label>
          <input id="name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="South Float East" required />
        </div>
        <div className="w-32">
          <label className="label" htmlFor="len">Length (ft)</label>
          <input id="len" className="input" type="number" min="1" step="any" value={draft.lengthFt} onChange={(e) => setDraft({ ...draft, lengthFt: e.target.value })} placeholder="90" />
        </div>
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="bnotes">Notes</label>
          <input id="bnotes" className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Shore power, 12' depth at MLW" />
        </div>
        <button className="btn-primary" type="submit">Add berth</button>
      </form>
      ) : (
        <p className="text-sm text-slate-600">
          <SignInLink>Sign in</SignInLink> to add or change berths.
        </p>
      )}

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Length</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {berths?.map((b) => {
              const e = editing[b.id];
              return (
                <tr key={b.id} className={b.lengthFt == null ? "bg-amber-50/40" : ""}>
                  {e ? (
                    <>
                      <td><input className="input" value={e.name} onChange={(ev) => setEditing({ ...editing, [b.id]: { ...e, name: ev.target.value } })} /></td>
                      <td><input className="input w-24" type="number" min="1" step="any" value={e.lengthFt} onChange={(ev) => setEditing({ ...editing, [b.id]: { ...e, lengthFt: ev.target.value } })} /></td>
                      <td><input className="input" value={e.notes} onChange={(ev) => setEditing({ ...editing, [b.id]: { ...e, notes: ev.target.value } })} /></td>
                      <td className="whitespace-nowrap text-right">
                        <button className="btn-primary mr-1" onClick={() => save(b)}>Save</button>
                        <button className="btn" onClick={() => setEditing((all) => without(all, b.id))}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="font-medium">{b.name}</td>
                      <td>{b.lengthFt != null ? `${b.lengthFt}'` : <span className="text-amber-700">not set</span>}</td>
                      <td className="text-slate-600">{b.notes}</td>
                      <td className="whitespace-nowrap text-right">
                        {canEdit && (
                        <>
                        <button className="mr-3 text-sky-700 underline" onClick={() => setEditing({ ...editing, [b.id]: { name: b.name, lengthFt: b.lengthFt?.toString() ?? "", notes: b.notes } })}>
                          edit
                        </button>
                        <button className="text-red-700 underline" onClick={() => remove(b)}>delete</button>
                        </>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
            {berths && berths.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-500">No berths yet. Add one above, or import the spreadsheet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
