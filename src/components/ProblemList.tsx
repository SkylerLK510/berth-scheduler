import Link from "next/link";
import type { Problem } from "@/lib/types";

export default function ProblemList({ problems, emptyText }: { problems: Problem[]; emptyText?: string }) {
  if (problems.length === 0) {
    return emptyText ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">✓ {emptyText}</p> : null;
  }
  return (
    <ul className="space-y-1.5">
      {problems.map((p, i) => (
        <li
          key={i}
          className={`rounded-md px-3 py-2 text-sm ${p.severity === "error" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}
        >
          <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide">{p.severity === "error" ? "Blocked" : "Warning"}</span>
          {p.message}
          {p.reservationId != null && (
            <>
              {" "}
              <Link href={`/reservations/${p.reservationId}`} className="underline">
                view
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
