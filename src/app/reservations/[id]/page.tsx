"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import ReservationForm from "@/components/ReservationForm";
import { api, errorMessage } from "@/lib/client";
import type { ReservationView } from "@/lib/types";

export default function EditReservation() {
  const { id } = useParams<{ id: string }>();
  const [reservation, setReservation] = useState<ReservationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ReservationView>(`/api/reservations/${id}`).then(setReservation).catch((err) => setError(errorMessage(err)));
  }, [id]);

  if (error) return <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!reservation) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {reservation.vesselName ?? reservation.title}
          {!reservation.confirmed && (
            <span className="rounded border border-dashed border-sky-400 bg-sky-50 px-1.5 text-xs font-normal text-sky-800">unconfirmed</span>
          )}
        </h1>
        <p className="text-sm text-slate-500">
          {reservation.berthName} · {reservation.source === "import" ? "imported from the spreadsheet" : "entered by hand"}
          {reservation.overrideReason && <> · saved with an override: “{reservation.overrideReason}”</>}
        </p>
      </div>
      <ReservationForm
        reservationId={reservation.id}
        overrideReason={reservation.overrideReason}
        unconfirmed={
          reservation.confirmed
            ? undefined
            : {
                knownDates: reservation.knownDates,
                sourceRef: reservation.sourceRef,
                berthId: reservation.berthId,
                berthName: reservation.berthName,
                vesselId: reservation.vesselId,
                vesselName: reservation.vesselName,
              }
        }
        initial={{
          kind: reservation.vesselId != null ? "vessel" : "event",
          berthId: String(reservation.berthId),
          vesselId: reservation.vesselId != null ? String(reservation.vesselId) : "",
          title: reservation.title,
          startDate: reservation.startDate,
          endDate: reservation.endDate,
          notes: reservation.notes,
        }}
      />
    </div>
  );
}
