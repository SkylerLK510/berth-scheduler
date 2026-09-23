import type { NextRequest } from "next/server";
import { badRequest, handle, json, parseId, readJson } from "@/lib/api";
import { isIsoDate } from "@/lib/dates";
import { listReservations } from "@/lib/repo";
import { saveReservation } from "@/lib/reservation-service";
import { parseReservationInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

/** GET /api/reservations?from=&to=&berthId=&vesselId=&q=&unconfirmed=1 */
export const GET = handle(async (request: NextRequest) => {
  const p = request.nextUrl.searchParams;
  const from = p.get("from");
  const to = p.get("to");
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return badRequest("from/to must be YYYY-MM-DD dates.");
  return json(
    await listReservations({
      from: from ?? undefined,
      to: to ?? undefined,
      berthId: parseId(p.get("berthId")) ?? undefined,
      vesselId: parseId(p.get("vesselId")) ?? undefined,
      q: p.get("q")?.trim() || undefined,
      unconfirmed: p.get("unconfirmed") === "1",
    }),
  );
});

/**
 * POST /api/reservations
 * Runs the double-booking and fit checks and writes the row in one transaction.
 * Blocking problems come back as a 409 with the list, unless the caller sets
 * override=true and gives a reason.
 */
export const POST = dispatcherOnly(async (request: Request) => {
  const parsed = parseReservationInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  const result = await saveReservation(parsed.value, null);
  if (!result.ok) return json({ errors: result.errors, problems: result.problems }, result.status);
  return json({ reservation: result.reservation, problems: result.problems }, 201);
});
