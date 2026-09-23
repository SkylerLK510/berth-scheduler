"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";

interface LinkInfo {
  email: string;
  role: "admin" | "dispatcher";
  kind: "invite" | "reset";
  name: string;
}

/**
 * Uses an invitation or password-reset link. The token is after the # in the link, so the
 * browser never sends it to the server as part of a URL; the page posts it instead, then
 * removes it from the address bar.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const { refresh } = useDispatcher();
  // Kept in a ref, not state: it never needs to be rendered.
  const token = useRef<string>("");
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [form, setForm] = useState({ name: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Capture the token once. The effect can run again (React does so in development), and by
    // then the hash has already been removed from the address bar, so keep what was captured.
    const fromHash = window.location.hash.slice(1);
    if (fromHash) {
      token.current = fromHash;
      window.history.replaceState(null, "", window.location.pathname); // keep it out of history and screenshots
    }
    let active = true;
    // An empty token comes back as "This link is incomplete" from the server.
    api<LinkInfo>("/api/invites/inspect", { method: "POST", json: { token: token.current } }).then(
      (i) => {
        if (!active) return;
        setInfo(i);
        setForm((f) => ({ ...f, name: i.name }));
      },
      (err) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api("/api/invites/accept", { method: "POST", json: { token: token.current, name: form.name, password: form.password } });
      token.current = "";
      await refresh();
      router.push("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return error ? <p className="max-w-lg rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : <p className="text-sm text-slate-500">Checking your link…</p>;
  }

  return (
    <form onSubmit={submit} className="card max-w-md space-y-4 p-5">
      <div>
        <h1 className="text-lg font-semibold">{info.kind === "invite" ? "Set up your account" : "Choose a new password"}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {info.kind === "invite"
            ? `You've been invited as ${info.role === "admin" ? "an admin" : "a dispatcher"} with the email ${info.email}.`
            : `For ${info.email}. This signs you out everywhere else.`}
        </p>
      </div>
      {info.kind === "invite" && (
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input id="name" className="input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
      )}
      <input type="email" autoComplete="username" value={info.email} readOnly hidden />
      <div>
        <label className="label" htmlFor="password">Password (at least 12 characters)</label>
        <input id="password" className="input" type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
      </div>
      <div>
        <label className="label" htmlFor="confirm">Password again</label>
        <input id="confirm" className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
      </div>
      {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <button className="btn-primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : info.kind === "invite" ? "Create account" : "Save password"}
      </button>
    </form>
  );
}
