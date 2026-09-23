import { handle, json } from "@/lib/api";
import { checkFit, findDoubleBookings, findVesselsInTwoPlaces } from "@/lib/conflicts";
import { listBerths, listReservations, listVessels } from "@/lib/repo";

/**
 * GET /api/issues
 * Audit of the whole schedule: the checks that used to be done by scanning the
 * spreadsheet grid by hand. Runs over every reservation, so it also catches problems
 * in imported data and in bookings saved with an override.
 */
export const GET = handle(async () => {
  const [reservations, vessels, berths] = await Promise.all([listReservations(), listVessels(), listBerths()]);

  const doubleBookings = findDoubleBookings(reservations);
  const vesselsInTwoPlaces = findVesselsInTwoPlaces(reservations);
  const withVessel = reservations.filter((r) => r.vesselId != null);

  return json({
    totals: { reservations: reservations.length, vessels: vessels.length, berths: berths.length },
    doubleBookings: doubleBookings.filter((p) => p.overlap === "definite"),
    possibleDoubleBookings: doubleBookings.filter((p) => p.overlap === "possible"),
    vesselsInTwoPlaces,
    doesNotFit: withVessel.filter((r) => checkFit(r.vesselLengthFt, r.berthLengthFt) === "too_long"),
    fitUnknownCount: withVessel.filter((r) => checkFit(r.vesselLengthFt, r.berthLengthFt) === "unknown").length,
    overridden: reservations.filter((r) => r.overrideReason),
    unconfirmedCount: reservations.filter((r) => !r.confirmed).length,
    vesselsWithoutLength: vessels.filter((v) => v.lengthFt == null),
    berthsWithoutLength: berths.filter((b) => b.lengthFt == null),
  });
});
