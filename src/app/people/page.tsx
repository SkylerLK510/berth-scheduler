"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SignInLink, useDispatcher } from "@/components/Dispatcher";
import { api, errorMessage } from "@/lib/client";

type Role = "admin" | "dispatcher";
interface Person {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabledAt: number | null;
}
interface PendingInvite {
  id: number;
  email: string;
  role: Role;
  kind: "invite" | "reset";
  expiresAt: number;
  createdBy: string | null;
}
interface NewLink {
  email: string;
  kind: "invite" | "reset";
  url: string;
  expiresAt: number;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Admins only: invite people, send reset links, change roles, revoke or restore access. */
export default function PeoplePage() {
  const { editing, user, isAdmin, refresh } = useDispatcher();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [draft, setDraft] = useState<{ email: string; role: Role }>({ email: "", role: "dispatcher" });
  const [link, setLink] = useState<NewLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One change at a time. A ref, not just state, so a fast double click can't start two:
  // a second link for the same person would cancel the first while the first was being shown.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  // Only the newest list load may update the page.
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const mine = ++loadSeq.current;
    return api<{ people: Person[]; invites: PendingInvite[] }>("/api/users").then(
      (data) => {
        if (mine !== loadSeq.current) return;
        setPeople(data.people);
        setInvites(data.invites);
      },
      (err) => mine === loadSeq.current && setError(errorMessage(err)),
    );
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    const mine = ++loadSeq.current;
    api<{ people: Person[]; invites: PendingInvite[] }>("/api/users").then(
      (data) => {
        if (mine !== loadSeq.current) return;
        setPeople(data.people);
        setInvites(data.invites);
      },
      (err) => mine === loadSeq.current && setError(errorMessage(err)),
    );
  }, [isAdmin]);

  /** Runs one change. Any change other than creating a link hides the link on screen, since it may no longer work. */
  async function run(action: () => Promise<unknown>, keepLink = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    if (!keepLink) setLink(null);
    try {
      await action();
      await load();
      await refresh(); // in case you changed your own role
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function makeLink(email: string, role: Role) {
    if (inFlight.current) return;
    setLink(null);
    setCopied(false);
    await run(async () => {
      const made = await api<{ email: string; kind: "invite" | "reset"; path: string; expiresAt: number }>("/api/invites", { method: "POST", json: { email, role } });
      // Shown once, only here. It's never stored in the page's address or in the server's logs.
      setLink({ email: made.email, kind: made.kind, url: `${window.location.origin}${made.path}`, expiresAt: made.expiresAt });
    }, true);
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  }

  if (editing === "loading") return <p className="text-sm text-slate-500">Loading…</p>;
  if (!isAdmin) {
    return (
      <div className="card max-w-lg space-y-2 p-5 text-sm text-slate-600">
        <h1 className="text-lg font-semibold text-slate-900">People</h1>
        <p>Only admins can manage who has access. {editing === "viewer" && <SignInLink>Sign in</SignInLink>}</p>
      </div>
    );
  }

  const activeAdmins = people?.filter((p) => p.role === "admin" && p.disabledAt == null).length ?? 0;

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">People</h1>
        <p className="text-sm text-slate-500">
          Anyone can view the schedule. Dispatchers can change bookings, berths, vessels and imports. Admins can also manage people. There is always at least one
          admin; to hand over, make someone else an admin first, then change your own role.
        </p>
      </div>

      <form
        className="card flex flex-wrap items-end gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          makeLink(draft.email, draft.role);
          setDraft({ email: "", role: "dispatcher" });
        }}
      >
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="invite-email">Invite by email</label>
          <input id="invite-email" className="input" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="dockmaster@example.org" required />
        </div>
        <div>
          <label className="label" htmlFor="invite-role">Role</label>
          <select id="invite-role" className="input w-auto" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
            <option value="dispatcher">Dispatcher</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Working…" : "Create invite link"}
        </button>
        <p className="w-full text-xs text-slate-500">No email is sent. You get a link to pass on yourself; it works once and expires in 72 hours.</p>
      </form>

      {link && (
        <div className="card space-y-2 border-emerald-300 bg-emerald-50 p-4 text-sm">
          <p className="font-medium text-emerald-900">
            {link.kind === "invite" ? "Invitation" : "Password reset"} link for {link.email}. Copy it now: it won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <input className="input font-mono text-xs" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Link" />
            <button className="btn" type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="text-xs text-emerald-800">Expires {when(link.expiresAt)}. Send it privately; anyone with the link can use it once.</p>
        </div>
      )}

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Access</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people?.map((p) => {
              const lastAdmin = p.role === "admin" && p.disabledAt == null && activeAdmins <= 1;
              const you = p.email === user?.email;
              return (
                <tr key={p.id} className={p.disabledAt ? "text-slate-400" : ""}>
                  <td className="font-medium">
                    {p.name} {you && <span className="text-xs text-slate-500">(you)</span>}
                  </td>
                  <td>{p.email}</td>
                  <td>
                    <select
                      className="input w-auto py-0.5"
                      value={p.role}
                      disabled={busy || lastAdmin || p.disabledAt != null}
                      title={lastAdmin ? "The last admin can't be demoted" : undefined}
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        if (you && role !== "admin" && !confirm("Give up your own admin access?")) return;
                        run(() => api(`/api/users/${p.id}`, { method: "PATCH", json: { role } }));
                      }}
                      aria-label={`Role for ${p.name}`}
                    >
                      <option value="dispatcher">Dispatcher</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>{p.disabledAt ? `Revoked ${when(p.disabledAt)}` : "Active"}</td>
                  <td className="whitespace-nowrap text-right">
                    {p.disabledAt == null ? (
                      <>
                        <button className="mr-3 text-sky-700 underline disabled:text-slate-300" disabled={busy} onClick={() => makeLink(p.email, p.role)}>
                          reset link
                        </button>
                        <button
                          className="text-red-700 underline disabled:text-slate-300 disabled:no-underline"
                          disabled={busy || lastAdmin}
                          title={lastAdmin ? "The last admin can't be revoked" : undefined}
                          onClick={() => confirm(`Revoke ${p.name}'s access? They are signed out at once.`) && run(() => api(`/api/users/${p.id}`, { method: "PATCH", json: { disabled: true } }))}
                        >
                          revoke
                        </button>
                      </>
                    ) : (
                      <button className="text-sky-700 underline disabled:text-slate-300" disabled={busy} onClick={() => run(() => api(`/api/users/${p.id}`, { method: "PATCH", json: { disabled: false } }))}>
                        restore
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Pending links</h2>
          <ul className="card divide-y divide-slate-100 text-sm">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="font-medium">{i.email}</span>
                <span className="text-slate-500">
                  {i.kind === "invite" ? `invited as ${i.role}` : "password reset"}
                  {i.createdBy && ` by ${i.createdBy}`}, expires {when(i.expiresAt)}
                </span>
                <button className="ml-auto text-red-700 underline disabled:text-slate-300" disabled={busy} onClick={() => run(() => api(`/api/invites/${i.id}`, { method: "DELETE" }))}>
                  cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
