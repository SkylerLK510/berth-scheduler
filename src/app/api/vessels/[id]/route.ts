import { badRequest, handle, json, notFound, parseId, readJson } from "@/lib/api";
import { deleteVessel, getVessel, updateVessel } from "@/lib/repo";
import { parseVesselInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  const vessel = id ? await getVessel(id) : null;
  return vessel ? json(vessel) : notFound("Vessel not found");
});

export const PATCH = dispatcherOnly(async (request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Vessel not found");
  const parsed = parseVesselInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  try {
    const vessel = await updateVessel(id, parsed.value);
    return vessel ? json(vessel) : notFound("Vessel not found");
  } catch (err) {
    if (String(err).includes("UNIQUE")) return badRequest(`A vessel named "${parsed.value.name}" already exists.`);
    throw err;
  }
});

export const DELETE = dispatcherOnly(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Vessel not found");
  const result = await deleteVessel(id);
  if (!result.deleted && result.reservations > 0) {
    return json({ errors: [`This vessel still has ${result.reservations} reservation(s). Delete those first.`] }, 409);
  }
  return result.deleted ? json({ ok: true }) : notFound("Vessel not found");
});
