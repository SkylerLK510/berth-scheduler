import type { NextRequest } from "next/server";
import { badRequest, handle, json } from "@/lib/api";
import { findDoubleBookings } from "@/lib/conflicts";
import { isIsoDate } from "@/lib/dates";
import { listBerths, listNotes, listReservations } from "@/lib/repo";

/**
 * GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Everything the grid needs for a date window in one request: the berths (rows), the
 * reservations and notes that touch the window, and which reservations are double-booked
 * (certainly, or possibly through estimated days) so the grid can mark them.
 */
export const GET = handle(async (request: NextRequest) => {
  const from = request.nextUrl.searchParams.get("from") ?? "";
  const to = request.nextUrl.searchParams.get("to") ?? "";
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return badRequest("from and to must be YYYY-MM-DD dates with from <= to.");

  const [berths, reservations, notes] = await Promise.all([listBerths(), listReservations({ from, to }), listNotes(from, to)]);
  const conflictIds = new Set<number>();
  const possibleConflictIds = new Set<number>();
  for (const { a, b, overlap } of findDoubleBookings(reservations)) {
    const target = overlap === "definite" ? conflictIds : possibleConflictIds;
    target.add(a.id);
    target.add(b.id);
  }
  return json({
    from,
    to,
    berths,
    reservations,
    notes,
    conflictIds: [...conflictIds],
    possibleConflictIds: [...possibleConflictIds].filter((id) => !conflictIds.has(id)),
  });
});
