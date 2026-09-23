"use client";

import { useEffect, useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";
import type { Vessel } from "@/lib/types";

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

export default function VesselsPage() {
  const { canEdit } = useDispatcher();
  const [vessels, setVessels] = useState<Vessel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", lengthFt: "", notes: "" });
  const [editing, setEditing] = useState<Record<number, { name: string; lengthFt: string; notes: string }>>({});

  const load = () => api<Vessel[]>("/api/vessels").then(setVessels).catch((err) => setError(errorMessage(err)));
  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/vessels", { method: "POST", json: { name: draft.name, lengthFt: draft.lengthFt || null, notes: draft.notes } });
      setDraft({ name: "", lengthFt: "", notes: "" });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function save(id: number) {
    const v = editing[id];
    setError(null);
    try {
      await api(`/api/vessels/${id}`, { method: "PATCH", json: { name: v.name, lengthFt: v.lengthFt || null, notes: v.notes } });
      setEditing((all) => without(all, id));
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(v: Vessel) {
    if (!confirm(`Delete ${v.name}?`)) return;
    setError(null);
    try {
      await api(`/api/vessels/${v.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const missing = vessels?.filter((v) => v.lengthFt == null).length ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Vessels</h1>
        <p className="text-sm text-slate-500">
          Length overall (LOA) is what the fit check compares against the berth length.
          {missing > 0 && <span className="ml-1 text-amber-700">{missing} vessel{missing === 1 ? " has" : "s have"} no length yet, so their bookings can&apos;t be fit-checked.</span>}
        </p>
      </div>

      {canEdit ? (
      <form onSubmit={add} className="card flex flex-wrap items-end gap-2 p-4">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="name">Name</label>
          <input id="name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="R/V Neil Armstrong" required />
        </div>
        <div className="w-32">
          <label className="label" htmlFor="len">Length (ft)</label>
          <input id="len" className="input" type="number" min="1" step="any" value={draft.lengthFt} onChange={(e) => setDraft({ ...draft, lengthFt: e.target.value })} placeholder="238" />
        </div>
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="vnotes">Notes</label>
          <input id="vnotes" className="input" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Draft 15', needs shore power" />
        </div>
        <button className="btn-primary" type="submit">Add vessel</button>
      </form>
      ) : (
        <p className="text-sm text-slate-600">
          <SignInLink>Sign in</SignInLink> to add or change vessels.
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
            {vessels?.map((v) => {
              const e = editing[v.id];
              return (
                <tr key={v.id} className={v.lengthFt == null ? "bg-amber-50/40" : ""}>
                  {e ? (
                    <>
                      <td><input className="input" value={e.name} onChange={(ev) => setEditing({ ...editing, [v.id]: { ...e, name: ev.target.value } })} /></td>
                      <td><input className="input w-24" type="number" min="1" step="any" value={e.lengthFt} onChange={(ev) => setEditing({ ...editing, [v.id]: { ...e, lengthFt: ev.target.value } })} /></td>
                      <td><input className="input" value={e.notes} onChange={(ev) => setEditing({ ...editing, [v.id]: { ...e, notes: ev.target.value } })} /></td>
                      <td className="whitespace-nowrap text-right">
                        <button className="btn-primary mr-1" onClick={() => save(v.id)}>Save</button>
                        <button className="btn" onClick={() => setEditing((all) => without(all, v.id))}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="font-medium">{v.name}</td>
                      <td>{v.lengthFt != null ? `${v.lengthFt}'` : <span className="text-amber-700">unknown</span>}</td>
                      <td className="text-slate-600">{v.notes}</td>
                      <td className="whitespace-nowrap text-right">
                        {canEdit && (
                        <>
                        <button className="mr-3 text-sky-700 underline" onClick={() => setEditing({ ...editing, [v.id]: { name: v.name, lengthFt: v.lengthFt?.toString() ?? "", notes: v.notes } })}>
                          edit
                        </button>
                        <button className="text-red-700 underline" onClick={() => remove(v)}>delete</button>
                        </>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
            {vessels && vessels.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-500">No vessels yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
