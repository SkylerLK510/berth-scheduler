import { badRequest, handle, json, readJson } from "@/lib/api";
import { createVessel, listVessels } from "@/lib/repo";
import { parseVesselInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

export const GET = handle(async () => json(await listVessels()));

export const POST = dispatcherOnly(async (request: Request) => {
  const parsed = parseVesselInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  try {
    return json(await createVessel(parsed.value), 201);
  } catch (err) {
    if (String(err).includes("UNIQUE")) return badRequest(`A vessel named "${parsed.value.name}" already exists.`);
    throw err;
  }
});
