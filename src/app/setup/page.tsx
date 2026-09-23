"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";

/**
 * One-time creation of the first admin. Needs the setup token the server operator put in
 * BOOTSTRAP_TOKEN, and exactly the BOOTSTRAP_ADMIN_EMAIL address. Closed for good once used.
 */
export default function SetupPage() {
  const router = useRouter();
  const { refresh } = useDispatcher();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [form, setForm] = useState({ token: "", email: "", name: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ available: boolean }>("/api/setup").then((r) => setAvailable(r.available), () => setAvailable(false));
  }, []);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api("/api/setup", { method: "POST", json: { token: form.token, email: form.email, name: form.name, password: form.password } });
      setForm({ token: "", email: "", name: "", password: "", confirm: "" });
      await refresh();
      router.push("/people");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (available === null) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!available) {
    return (
      <div className="card max-w-lg space-y-2 p-5 text-sm text-slate-600">
        <h1 className="text-lg font-semibold text-slate-900">First-admin setup</h1>
        <p>Setup isn&apos;t open on this server. Either it has already been completed (sign in instead), or the operator hasn&apos;t configured it.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card max-w-md space-y-4 p-5">
      <div>
        <h1 className="text-lg font-semibold">First-admin setup</h1>
        <p className="mt-1 text-sm text-slate-500">
          Creates the first admin account, once. You need the setup token from the server&apos;s configuration, and the email address it was set up for.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="token">Setup token</label>
        <input id="token" className="input font-mono" type="password" autoComplete="off" value={form.token} onChange={(e) => set({ token: e.target.value })} required />
      </div>
      <div>
        <label className="label" htmlFor="email">Your email</label>
        <input id="email" className="input" type="email" autoComplete="username" value={form.email} onChange={(e) => set({ email: e.target.value })} required />
      </div>
      <div>
        <label className="label" htmlFor="name">Your name</label>
        <input id="name" className="input" autoComplete="name" value={form.name} onChange={(e) => set({ name: e.target.value })} required />
      </div>
      <div>
        <label className="label" htmlFor="password">Password (at least 12 characters)</label>
        <input id="password" className="input" type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => set({ password: e.target.value })} required />
      </div>
      <div>
        <label className="label" htmlFor="confirm">Password again</label>
        <input id="confirm" className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => set({ confirm: e.target.value })} required />
      </div>
      {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <button className="btn-primary" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}
