import { json, notFound, parseId } from "@/lib/api";
import { privately } from "@/lib/account-routes";
import { revokeInvite } from "@/lib/accounts";
import { adminOnly } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/invites/:id: cancel a pending link (admins only). */
export const DELETE = privately(
  adminOnly(async (actor, _request: Request, { params }: Ctx) => {
    const id = parseId((await params).id);
    if (!id) return notFound("No pending link with that id.");
    await revokeInvite(actor, id);
    return json({ ok: true });
  }),
);
