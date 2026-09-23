import { body, privately, withSession } from "@/lib/account-routes";
import { acceptInvite } from "@/lib/accounts";
import { authMode, notConfigured, originAllowed, wrongOrigin } from "@/lib/auth";

/** POST /api/invites/accept { token, name, password }: use an invitation or reset link, and sign in. */
export const POST = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return notConfigured(mode);
  if (!originAllowed(request, mode)) return wrongOrigin();
  if (mode.kind !== "enforced") return notConfigured({ kind: "misconfigured", problems: ["Accounts are off in dev-open mode."] });
  return withSession({ editing: "user" }, await acceptInvite(await body(request)));
});
