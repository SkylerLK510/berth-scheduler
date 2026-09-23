import { describe, expect, it } from "vitest";
import { safeNextPath } from "../redirect";

describe("safeNextPath", () => {
  it("keeps paths on this site, normalised", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/reservations?unconfirmed=1")).toBe("/reservations?unconfirmed=1");
    expect(safeNextPath("/reservations/70#dates")).toBe("/reservations/70#dates");
    expect(safeNextPath("/a/../import")).toBe("/import");
  });

  it("sends anything that could leave the site to /", () => {
    for (const raw of [
      null,
      "",
      "reservations",
      "https://evil.example",
      "//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "\t/evil.example",
      "/\u0000/evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeNextPath(raw), JSON.stringify(raw)).toBe("/");
    }
  });
});
