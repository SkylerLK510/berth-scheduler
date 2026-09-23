import type { NextRequest } from "next/server";
import { badRequest, handle, json, parseId } from "@/lib/api";
import { checkFit, classifyOverlap, type FitStatus } from "@/lib/conflicts";
import { isIsoDate } from "@/lib/dates";
import { getVessel, listBerths, listReservations } from "@/lib/repo";
import type { ReservationView } from "@/lib/types";

export interface BerthAvailability {
  berthId: number;
  berthName: string;
  berthLengthFt: number | null;
  fit: FitStatus;
  /** free: nothing booked. maybe: only estimated days of imported stays overlap. busy: certainly taken. */
  status: "free" | "maybe" | "busy";
  busy: ReservationView[];
  maybe: ReservationView[];
}

/**
 * GET /api/availability?startDate=&endDate=&vesselId=   (or &lengthFt= for a vessel not on file)
 * "Where can I put this boat for these dates?" Every berth, with whether it is free for
 * the whole window and whether the vessel fits.
 */
export const GET = handle(async (request: NextRequest) => {
  const p = request.nextUrl.searchParams;
  const startDate = p.get("startDate") ?? "";
  const endDate = p.get("endDate") ?? "";
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) {
    return badRequest("startDate and endDate must be YYYY-MM-DD dates with start <= end.");
  }

  let lengthFt: number | null = null;
  const vesselId = parseId(p.get("vesselId"));
  if (vesselId) {
    const vessel = await getVessel(vesselId);
    if (!vessel) return badRequest("Vessel not found.");
    lengthFt = vessel.lengthFt;
  } else if (p.get("lengthFt")) {
    lengthFt = Number(p.get("lengthFt"));
    if (!Number.isFinite(lengthFt) || lengthFt <= 0) return badRequest("lengthFt must be a positive number.");
  }

  const [berths, reservations] = await Promise.all([listBerths(), listReservations({ from: startDate, to: endDate })]);
  const window = { startDate, endDate };
  const result: BerthAvailability[] = berths.map((b) => {
    const here = reservations.filter((r) => r.berthId === b.id);
    const busy = here.filter((r) => classifyOverlap(window, r) === "definite");
    const maybe = here.filter((r) => classifyOverlap(window, r) === "possible");
    return {
      berthId: b.id,
      berthName: b.name,
      berthLengthFt: b.lengthFt,
      fit: checkFit(lengthFt, b.lengthFt),
      status: busy.length ? "busy" : maybe.length ? "maybe" : "free",
      busy,
      maybe,
    };
  });
  return json({ startDate, endDate, lengthFt, berths: result });
});
