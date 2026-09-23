import { describe, expect, it } from "vitest";
import { MAX_LENGTH, parseBerthInput, parseNoteInput, parseReservationInput, parseVesselInput } from "../validation";

const long = (n: number) => "x".repeat(n);
const booking = { berthId: 1, vesselId: null, title: "Sail day", startDate: "2026-06-01", endDate: "2026-06-02" };

describe("text length limits", () => {
  it("accept text up to the limit", () => {
    expect(parseBerthInput({ name: long(MAX_LENGTH.name), notes: long(MAX_LENGTH.notes) }).ok).toBe(true);
    expect(parseVesselInput({ name: long(MAX_LENGTH.name), notes: long(MAX_LENGTH.notes) }).ok).toBe(true);
    expect(parseReservationInput({ ...booking, title: long(MAX_LENGTH.name), notes: long(MAX_LENGTH.notes) }).ok).toBe(true);
    expect(parseNoteInput({ berthId: null, date: "2026-06-01", text: long(MAX_LENGTH.noteText) }).ok).toBe(true);
  });

  it("refuse anything longer, with a readable reason", () => {
    expect(parseBerthInput({ name: long(MAX_LENGTH.name + 1) })).toEqual({ ok: false, errors: [`Name can be at most ${MAX_LENGTH.name} characters.`] });
    expect(parseBerthInput({ name: "Pier", notes: long(MAX_LENGTH.notes + 1) }).ok).toBe(false);
    expect(parseVesselInput({ name: long(100_000) }).ok).toBe(false);
    expect(parseVesselInput({ name: "R/V X", notes: long(MAX_LENGTH.notes + 1) }).ok).toBe(false);
    expect(parseReservationInput({ ...booking, title: long(MAX_LENGTH.name + 1) }).ok).toBe(false);
    expect(parseReservationInput({ ...booking, notes: long(MAX_LENGTH.notes + 1) }).ok).toBe(false);
    expect(parseReservationInput({ ...booking, override: true, overrideReason: long(MAX_LENGTH.notes + 1) }).ok).toBe(false);
    expect(parseNoteInput({ berthId: null, date: "2026-06-01", text: long(MAX_LENGTH.noteText + 1) }).ok).toBe(false);
  });

  it("count length after trimming", () => {
    expect(parseBerthInput({ name: `  ${long(MAX_LENGTH.name)}  ` }).ok).toBe(true);
  });
});
