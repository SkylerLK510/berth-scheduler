import { json } from "@/lib/api";
import { body, privately, withSession } from "@/lib/account-routes";
import { bootstrapAdmin, setupAvailable } from "@/lib/accounts";
import { authMode, notConfigured, originAllowed, wrongOrigin } from "@/lib/auth";

/** GET /api/setup: whether first-admin setup is open (only before it has ever been used). */
export const GET = privately(async () => json({ available: await setupAvailable(authMode()) }));

/** POST /api/setup { token, email, name, password }: create the first admin, once. */
export const POST = privately(async (request: Request) => {
  const mode = authMode();
  if (mode.kind === "misconfigured") return notConfigured(mode);
  if (!originAllowed(request, mode)) return wrongOrigin();
  const token = await bootstrapAdmin(mode, await body(request));
  return withSession({ editing: "user" }, token, 201);
});
