"use client";

// Who can edit, for the UI. The server enforces this on every write; the UI only uses it
// to show or hide editing controls, so a read-only visitor isn't offered buttons that
// would be refused.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/** "user" signed in; "viewer" can sign in; "open" local dev without sign-in; "off" editing isn't configured. */
export type Editing = "loading" | "user" | "viewer" | "open" | "off";

export interface CurrentUser {
  name: string;
  email: string;
  role: "admin" | "dispatcher";
}

/** Fired by the API client on a 401, so a session that expired mid-visit shows up at once. */
export const SESSION_CHANGED = "berth:session-changed";

interface DispatcherState {
  editing: Editing;
  user: CurrentUser | null;
  canEdit: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
}

const Context = createContext<DispatcherState>({ editing: "loading", user: null, canEdit: false, isAdmin: false, refresh: async () => {} });

export function DispatcherProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ editing: Editing; user: CurrentUser | null }>({ editing: "loading", user: null });
  // Only the newest check counts, so a slow reply from before a sign-out can't show "signed in" again.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    let next: { editing: Editing; user: CurrentUser | null } = { editing: "viewer", user: null };
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const data = await response.json();
      next = { editing: data?.editing ?? "viewer", user: data?.user ?? null };
    } catch {}
    if (mine === latest.current) setState(next);
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(SESSION_CHANGED, onChange);
    return () => window.removeEventListener(SESSION_CHANGED, onChange);
  }, [refresh]);

  const { editing, user } = state;
  const canEdit = editing === "user" || editing === "open";
  const isAdmin = editing === "open" || user?.role === "admin";
  return <Context.Provider value={{ editing, user, canEdit, isAdmin, refresh }}>{children}</Context.Provider>;
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

/** For pages that only make sense for someone signed in (new reservation, import). */
export function DispatcherOnly({ children, what }: { children: ReactNode; what: string }) {
  const { editing, canEdit } = useDispatcher();
  if (editing === "loading") return <p className="text-sm text-slate-500">Loading…</p>;
  if (canEdit) return <>{children}</>;
  return (
    <div className="card max-w-xl space-y-2 p-5 text-sm">
      <p className="font-medium text-slate-900">Sign in to {what}.</p>
      <p className="text-slate-600">Anyone can look at the schedule, reservations and issues. Changing them needs an account, which an admin can invite you to.</p>
      <p>
        <SignInLink className="btn-primary">Sign in</SignInLink>
      </p>
    </div>
  );
}
