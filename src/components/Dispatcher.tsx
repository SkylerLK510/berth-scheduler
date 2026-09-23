"use client";

// Who can edit, for the UI. The server enforces this on every write; the UI only uses it
// to show or hide editing controls, so a read-only visitor isn't offered buttons that
// would be refused.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/** "dispatcher" signed in; "viewer" can sign in; "open" local dev without sign-in; "off" editing isn't configured. */
export type Editing = "loading" | "dispatcher" | "viewer" | "open" | "off";

/** Fired by the API client on a 401, so a session that expired mid-visit shows up at once. */
export const SESSION_CHANGED = "berth:session-changed";

interface DispatcherState {
  editing: Editing;
  canEdit: boolean;
  refresh: () => Promise<void>;
}

const Context = createContext<DispatcherState>({ editing: "loading", canEdit: false, refresh: async () => {} });

export function DispatcherProvider({ children }: { children: ReactNode }) {
  const [editing, setEditing] = useState<Editing>("loading");
  // Only the newest check counts, so a slow reply from before a sign-out can't show "signed in" again.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    let next: Editing = "viewer";
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const data = await response.json();
      next = data?.editing ?? "viewer";
    } catch {}
    if (mine === latest.current) setEditing(next);
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(SESSION_CHANGED, onChange);
    return () => window.removeEventListener(SESSION_CHANGED, onChange);
  }, [refresh]);

  return <Context.Provider value={{ editing, canEdit: editing === "dispatcher" || editing === "open", refresh }}>{children}</Context.Provider>;
}

export const useDispatcher = () => useContext(Context);

/** A link to the sign-in page that comes back here afterwards. */
export function SignInLink({ children = "Sign in to edit", className = "text-sky-700 underline" }: { children?: ReactNode; className?: string }) {
  const pathname = usePathname();
  const { editing } = useDispatcher();
  if (editing === "off") return <span className="text-slate-400">Editing is switched off on this server</span>;
  return (
    <Link href={`/signin?next=${encodeURIComponent(pathname)}`} className={className}>
      {children}
    </Link>
  );
}

/** For pages that only make sense for a dispatcher (new reservation, import). */
export function DispatcherOnly({ children, what }: { children: ReactNode; what: string }) {
  const { editing, canEdit } = useDispatcher();
  if (editing === "loading") return <p className="text-sm text-slate-500">Loading…</p>;
  if (canEdit) return <>{children}</>;
  return (
    <div className="card max-w-xl space-y-2 p-5 text-sm">
      <p className="font-medium text-slate-900">Only the dispatcher can {what}.</p>
      <p className="text-slate-600">Anyone can look at the schedule, reservations and issues. Changing them needs the dispatcher passcode.</p>
      <p>
        <SignInLink className="btn-primary">Dispatcher sign in</SignInLink>
      </p>
    </div>
  );
}
