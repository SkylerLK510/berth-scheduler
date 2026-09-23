import { json, notFound, parseId } from "@/lib/api";
import { body, privately } from "@/lib/account-routes";
import { updatePerson } from "@/lib/accounts";
import { adminOnly } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/users/:id { role?, disabled? }: change a role, or revoke or restore access (admins only). */
export const PATCH = privately(
  adminOnly(async (actor, request: Request, { params }: Ctx) => {
    const id = parseId((await params).id);
    if (!id) return notFound("No such person.");
    const { role, disabled } = await body(request);
    return json(await updatePerson(actor, id, { role, disabled }));
  }),
);
