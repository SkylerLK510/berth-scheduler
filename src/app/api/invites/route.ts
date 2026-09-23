import { json } from "@/lib/api";
import { body, privately } from "@/lib/account-routes";
import { createInvite, listPeople } from "@/lib/accounts";
import { adminOnly } from "@/lib/auth";

/** GET /api/invites: pending links (admins only). Never includes the tokens themselves. */
export const GET = privately(adminOnly(async () => json((await listPeople()).invites)));

/**
 * POST /api/invites { email, role }: a single-use link for someone new (an invitation) or an
 * existing account (a password reset). The token appears in this response only, once.
 */
export const POST = privately(
  adminOnly(async (actor, request: Request) => {
    const { email, role } = await body(request);
    const invite = await createInvite(actor, email, role);
    return json({ ...invite, path: `/accept-invite#${invite.token}` }, 201);
  }),
);
