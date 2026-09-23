import { handle, json } from "@/lib/api";
import { db, storageKind } from "@/lib/db";

/**
 * GET /api/health
 * Confirms the database is reachable and says what kind of storage backs this
 * deployment. On a public deployment `storage` should be "remote" (Turso); a "file"
 * database would be wiped by a serverless host.
 */
export const GET = handle(async () => {
  const conn = await db();
  const row = (await conn.execute("SELECT (SELECT COUNT(*) FROM reservations) AS reservations, (SELECT COUNT(*) FROM berths) AS berths")).rows[0];
  return json({
    ok: true,
    storage: storageKind(),
    durable: storageKind() === "remote" || !process.env.VERCEL,
    reservations: Number(row.reservations),
    berths: Number(row.berths),
  });
});
