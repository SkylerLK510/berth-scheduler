import { badRequest, handle, json, notFound, parseId, readJson } from "@/lib/api";
import { deleteReservation, getReservation } from "@/lib/repo";
import { saveReservation } from "@/lib/reservation-service";
import { parseReservationInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  const reservation = id ? await getReservation(id) : null;
  return reservation ? json(reservation) : notFound("Reservation not found");
});

/**
 * PATCH /api/reservations/:id
 * Same checks as a create. An imported stay stays unconfirmed unless the body has
 * confirmDates=true, which is how a coordinator signs off on its dates.
 */
export const PATCH = dispatcherOnly(async (request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Reservation not found");
  const parsed = parseReservationInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  const result = await saveReservation(parsed.value, id);
  if (!result.ok) return json({ errors: result.errors, problems: result.problems }, result.status);
  return json({ reservation: result.reservation, problems: result.problems });
});

export const DELETE = dispatcherOnly(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Reservation not found");
  return (await deleteReservation(id)) ? json({ ok: true }) : notFound("Reservation not found");
});
