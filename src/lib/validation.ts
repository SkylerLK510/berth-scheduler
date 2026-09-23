// Request body validation for the API. Plain hand-written checks: the shapes
// are small and this keeps the error messages readable for the form.

import { isIsoDate } from "./dates";
import type { ReservationInput } from "./types";

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Longest text accepted per field, so no one can bloat the database or break the layout. */
export const MAX_LENGTH = { name: 200, notes: 2000, noteText: 500 } as const;

function capLength(value: string, max: number, label: string, errors: string[]): void {
  if (value.length > max) errors.push(`${label} can be at most ${max} characters.`);
}

function optionalLength(v: unknown, label: string, errors: string[]): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    errors.push(`${label} must be a positive number of feet, or left blank.`);
    return null;
  }
  return n;
}

function optionalId(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function parseBerthInput(body: unknown): Validated<{ name: string; lengthFt: number | null; notes: string; sortOrder?: number }> {
  if (!isRecord(body)) return { ok: false, errors: ["Expected a JSON object."] };
  const errors: string[] = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) errors.push("Name is required.");
  capLength(name, MAX_LENGTH.name, "Name", errors);
  const lengthFt = optionalLength(body.lengthFt, "Length", errors);
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  capLength(notes, MAX_LENGTH.notes, "Notes", errors);
  const sortOrder = typeof body.sortOrder === "number" && Number.isInteger(body.sortOrder) ? body.sortOrder : undefined;
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, lengthFt, notes, sortOrder } };
}

export function parseVesselInput(body: unknown): Validated<{ name: string; lengthFt: number | null; notes: string }> {
  if (!isRecord(body)) return { ok: false, errors: ["Expected a JSON object."] };
  const errors: string[] = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) errors.push("Name is required.");
  capLength(name, MAX_LENGTH.name, "Name", errors);
  const lengthFt = optionalLength(body.lengthFt, "Length", errors);
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  capLength(notes, MAX_LENGTH.notes, "Notes", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, lengthFt, notes } };
}

export function parseReservationInput(body: unknown): Validated<ReservationInput> {
  if (!isRecord(body)) return { ok: false, errors: ["Expected a JSON object."] };
  const errors: string[] = [];

  const berthId = optionalId(body.berthId);
  if (!berthId) errors.push("Choose a berth.");

  const vesselId = optionalId(body.vesselId);
  if (vesselId === undefined) errors.push("Vessel id is invalid.");

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (vesselId === null && !title) errors.push("Give the event a title, or pick a vessel.");
  capLength(title, MAX_LENGTH.name, "Title", errors);

  const startDate = typeof body.startDate === "string" ? body.startDate : "";
  const endDate = typeof body.endDate === "string" ? body.endDate : "";
  if (!isIsoDate(startDate)) errors.push("Start date must be a valid date (YYYY-MM-DD).");
  if (!isIsoDate(endDate)) errors.push("End date must be a valid date (YYYY-MM-DD).");
  if (isIsoDate(startDate) && isIsoDate(endDate) && endDate < startDate) errors.push("End date can't be before the start date.");

  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  const override = body.override === true;
  const overrideReason = typeof body.overrideReason === "string" ? body.overrideReason.trim() : "";
  capLength(notes, MAX_LENGTH.notes, "Notes", errors);
  capLength(overrideReason, MAX_LENGTH.notes, "Override reason", errors);
  if (override && !overrideReason) errors.push("Give a reason when overriding a conflict.");
  const confirmDates = body.confirmDates === true;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { berthId: berthId!, vesselId: vesselId ?? null, title, startDate, endDate, notes, override, overrideReason, confirmDates },
  };
}

export function parseNoteInput(body: unknown): Validated<{ berthId: number | null; date: string; text: string }> {
  if (!isRecord(body)) return { ok: false, errors: ["Expected a JSON object."] };
  const errors: string[] = [];
  const berthId = optionalId(body.berthId);
  if (berthId === undefined) errors.push("Berth id is invalid.");
  const date = typeof body.date === "string" ? body.date : "";
  if (!isIsoDate(date)) errors.push("Date must be a valid date (YYYY-MM-DD).");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) errors.push("Note text is required.");
  capLength(text, MAX_LENGTH.noteText, "Note text", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { berthId: berthId ?? null, date, text } };
}
