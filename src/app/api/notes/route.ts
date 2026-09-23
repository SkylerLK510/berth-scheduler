import type { NextRequest } from "next/server";
import { badRequest, handle, json, readJson } from "@/lib/api";
import { isIsoDate } from "@/lib/dates";
import { createNote, listNotes } from "@/lib/repo";
import { parseNoteInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

/** GET /api/notes?from=&to= */
export const GET = handle(async (request: NextRequest) => {
  const from = request.nextUrl.searchParams.get("from") ?? "";
  const to = request.nextUrl.searchParams.get("to") ?? "";
  if (!isIsoDate(from) || !isIsoDate(to)) return badRequest("from and to must be YYYY-MM-DD dates.");
  return json(await listNotes(from, to));
});

export const POST = dispatcherOnly(async (request: Request) => {
  const parsed = parseNoteInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  return json(await createNote(parsed.value), 201);
});
