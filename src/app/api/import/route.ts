import { badRequest, json, readJson } from "@/lib/api";
import { importSchedule } from "@/lib/importer";
import { parseScheduleCsv } from "@/lib/schedule-csv";
import { dispatcherOnly } from "@/lib/auth";

/**
 * POST /api/import   { csv: string, year?: number, dryRun?: boolean }
 * Parses one year's spreadsheet export. With dryRun the parsed result and diagnostics
 * come back for preview; otherwise it is written to the database in one transaction.
 */
export const POST = dispatcherOnly(async (request: Request) => {
  const body = await readJson(request);
  if (!body || typeof body !== "object" || typeof (body as { csv?: unknown }).csv !== "string") {
    return badRequest("Send the CSV text in a `csv` field.");
  }
  const { csv, year, dryRun } = body as { csv: string; year?: unknown; dryRun?: unknown };
  if (csv.length > 5_000_000) return badRequest("That file is too large to be a schedule export.");

  let yearOverride: number | undefined;
  if (year !== undefined && year !== null && year !== "") {
    yearOverride = Number(year);
    if (!Number.isInteger(yearOverride) || yearOverride < 1900 || yearOverride > 2200) return badRequest("Year must be a four-digit year between 1900 and 2200.");
  }

  let parsed;
  try {
    parsed = parseScheduleCsv(csv, { year: yearOverride });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Could not parse the file.");
  }

  if (dryRun) return json({ preview: true, ...parsed });
  return json(await importSchedule(parsed));
});
