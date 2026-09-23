import { json } from "@/lib/api";
import { privately } from "@/lib/account-routes";
import { listPeople } from "@/lib/accounts";
import { adminOnly } from "@/lib/auth";

/** GET /api/users: everyone with an account, and pending links (admins only). */
export const GET = privately(adminOnly(async () => json(await listPeople())));
