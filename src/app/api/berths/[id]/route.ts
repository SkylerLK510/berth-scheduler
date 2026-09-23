import { badRequest, handle, json, notFound, parseId, readJson } from "@/lib/api";
import { deleteBerth, getBerth, updateBerth } from "@/lib/repo";
import { parseBerthInput } from "@/lib/validation";
import { dispatcherOnly } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  const berth = id ? await getBerth(id) : null;
  return berth ? json(berth) : notFound("Berth not found");
});

export const PATCH = dispatcherOnly(async (request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Berth not found");
  const parsed = parseBerthInput(await readJson(request));
  if (!parsed.ok) return badRequest(parsed.errors);
  try {
    const berth = await updateBerth(id, parsed.value);
    return berth ? json(berth) : notFound("Berth not found");
  } catch (err) {
    if (String(err).includes("UNIQUE")) return badRequest(`A berth named "${parsed.value.name}" already exists.`);
    throw err;
  }
});

export const DELETE = dispatcherOnly(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Berth not found");
  const result = await deleteBerth(id);
  if (!result.deleted && result.reservations > 0) {
    return json({ errors: [`This berth still has ${result.reservations} reservation(s). Move or delete them first.`] }, 409);
  }
  return result.deleted ? json({ ok: true }) : notFound("Berth not found");
});
