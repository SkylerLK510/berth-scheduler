import { handle, json } from "@/lib/api";
import { dataSummary } from "@/lib/repo";

/** GET /api/summary - counts and the years that have data, for the navigation. */
export const GET = handle(async () => json(await dataSummary()));
