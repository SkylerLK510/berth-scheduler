import { expect, it } from "vitest";
import { certainOverlapDays, type Stay } from "../conflicts";

it("does not present gaps between source observations as known conflict days", () => {
  const sparse: Stay = {
    startDate: "2018-01-18", endDate: "2018-04-12", confirmed: false,
    knownDates: ["2018-01-18", "2018-02-01", "2018-04-01"],
  };
  expect(certainOverlapDays(sparse, { startDate: "2018-01-25", endDate: "2018-04-05" })).toEqual([
    { start: "2018-02-01", end: "2018-02-01" },
    { start: "2018-04-01", end: "2018-04-01" },
  ]);
  expect(certainOverlapDays(sparse, { startDate: "2018-01-25", endDate: "2018-01-30" })).toEqual([]);
});

it("intersects both stays' evidence and clips consecutive runs at the shared boundary", () => {
  const a: Stay = { startDate: "2018-01-01", endDate: "2018-01-10", confirmed: false,
    knownDates: ["2018-01-02", "2018-01-03", "2018-01-04", "2018-01-08"] };
  const b: Stay = { startDate: "2018-01-03", endDate: "2018-01-10", confirmed: false,
    knownDates: ["2018-01-03", "2018-01-04", "2018-01-05", "2018-01-09"] };
  expect(certainOverlapDays(a, b)).toEqual([{ start: "2018-01-03", end: "2018-01-04" }]);
});
