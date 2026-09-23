"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DispatcherOnly } from "@/components/Dispatcher";
import ReservationForm from "@/components/ReservationForm";
import { todayIso } from "@/lib/dates";

function NewReservation() {
  const params = useSearchParams();
  const date = params.get("date") ?? todayIso();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New reservation</h1>
      <DispatcherOnly what="add reservations">
      <ReservationForm
        initial={{
          kind: "vessel",
          berthId: params.get("berthId") ?? "",
          vesselId: params.get("vesselId") ?? "",
          title: "",
          startDate: date,
          endDate: params.get("endDate") ?? date,
          notes: "",
        }}
      />
      </DispatcherOnly>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NewReservation />
    </Suspense>
  );
}
