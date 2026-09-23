"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";

const links = [
  { href: "/", label: "Schedule" },
  { href: "/reservations", label: "Reservations" },
  { href: "/find", label: "Find a berth" },
  { href: "/issues", label: "Issues" },
  { href: "/vessels", label: "Vessels" },
  { href: "/berths", label: "Berths" },
  { href: "/import", label: "Import" },
];

/** Who is looking: signed-in dispatcher (with sign out), or a sign-in link. */
function SessionStatus() {
  const router = useRouter();
  const { editing, refresh } = useDispatcher();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function signOut() {
    setSignOutError(null);
    try {
      await api("/api/session", { method: "DELETE" });
    } catch (err) {
      // Don't pretend it worked: the session may still be live on the server.
      setSignOutError(`Sign out failed, so you may still be signed in. Try again. (${errorMessage(err)})`);
      return;
    }
    await refresh();
    router.refresh();
  }

  if (editing === "loading") return null;
  if (editing === "open") return <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Local dev: editing open</span>;
  if (editing === "off") return <span className="text-xs text-slate-400">View only</span>;
  if (editing === "viewer") return <SignInLink className="btn">Dispatcher sign in</SignInLink>;
  return (
    <span className="flex items-center gap-2 text-sm text-slate-600">
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">Dispatcher</span>
      <button className="text-sky-700 underline" onClick={signOut}>
        Sign out
      </button>
      {signOutError && (
        <span role="alert" className="text-xs text-red-700">
          {signOutError}
        </span>
      )}
    </span>
  );
}

export default function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <span aria-hidden className="inline-block h-6 w-6 rounded bg-sky-600 text-center text-sm leading-6 text-white">⚓</span>
          Berth Scheduler
        </Link>
        <nav className="flex flex-wrap gap-1 text-sm">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-2.5 py-1 ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <SessionStatus />
        </div>
      </div>
    </header>
  );
}
