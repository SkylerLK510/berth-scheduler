import { json } from "@/lib/api";
import { body, privately } from "@/lib/account-routes";
import { inspectInvite } from "@/lib/accounts";
import { authMode, notConfigured, originAllowed, wrongOrigin } from "@/lib/auth";

/**
 * POST /api/invites/inspect { token }: who a link is for, so the page can greet them.
 * POST rather than GET so the token never appears in a URL the server logs.
 */
export const POST = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return notConfigured(mode);
  if (!originAllowed(request, mode)) return wrongOrigin();
  return json(await inspectInvite((await body(request)).token));
});
