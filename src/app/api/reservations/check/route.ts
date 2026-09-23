import { badRequest, handle, json, parseId, readJson } from "@/lib/api";
import { db } from "@/lib/db";
import { checkReservation } from "@/lib/reservation-service";
import { parseReservationInput } from "@/lib/validation";

/**
 * POST /api/reservations/check
 * Dry run of the save checks so the form can show conflicts while the user types.
 * Same body as a save, plus `id` when editing an existing reservation. The reply also says
 * how the stay would be stored (confirmed, and which days stay known) so the form can show it.
 */
export const POST = handle(async (request: Request) => {
  const body = await readJson(request);
  const parsed = parseReservationInput(body);
  if (!parsed.ok) return badRequest(parsed.errors);
  const id = parseId(typeof body === "object" && body && "id" in body ? String(body.id) : null);
  const check = await checkReservation(await db(), parsed.value, id);
  if (!check.ok) return json({ errors: check.errors, problems: check.problems }, check.status);
  return json({ problems: check.problems, blocking: check.blocking, confirmed: check.confirmed, knownDates: check.knownDates });
});
