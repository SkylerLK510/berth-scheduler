"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";
import { safeNextPath } from "@/lib/redirect";

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const { editing, refresh } = useDispatcher();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNextPath(params.get("next"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/session", { method: "POST", json: { email, password } });
      setPassword("");
      await refresh();
      router.push(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing === "user" || editing === "open") {
    return <p className="text-sm text-slate-600">You&apos;re already signed in. {editing === "open" && "(Local development: sign-in is switched off.)"}</p>;
  }
  if (editing === "off") {
    return <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Editing is switched off on this server because sign-in isn&apos;t configured.</p>;
  }

  return (
    <form onSubmit={submit} className="card max-w-sm space-y-4 p-5">
      <div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-slate-500">Anyone can view the schedule. Making changes needs an account; an admin can invite you.</p>
      </div>
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <button className="btn-primary" type="submit" disabled={busy || !email || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-xs text-slate-500">
        You stay signed in for 12 hours on this browser, or until you sign out. Forgot your password? Ask an admin for a reset link.
        {" "}Setting up a new server? <Link href="/setup" className="underline">First-admin setup</Link>.
      </p>
    </form>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <SignIn />
    </Suspense>
  );
}
