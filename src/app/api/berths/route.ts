import { badRequest, handle, json, readJson } from "@/lib/api";
import { createBerth, listBerths } from "@/lib/repo";
import { parseBerthInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

export const GET = handle(async () => json(await listBerths()));

export const POST = dispatcherOnly(async (request: Request) => {
  const parsed = parseBerthInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  try {
    return json(await createBerth(parsed.value), 201);
  } catch (err) {
    if (String(err).includes("UNIQUE")) return badRequest(`A berth named "${parsed.value.name}" already exists.`);
    throw err;
  }
});
