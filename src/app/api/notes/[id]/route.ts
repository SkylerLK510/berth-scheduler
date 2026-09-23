import { json, notFound, parseId } from "@/lib/api";
import { deleteNote } from "@/lib/repo";
import { dispatcherOnly } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = dispatcherOnly(async (_request: Request, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (!id) return notFound("Note not found");
  return (await deleteNote(id)) ? json({ ok: true }) : notFound("Note not found");
});
