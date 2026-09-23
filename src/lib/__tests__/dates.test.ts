import { describe, expect, it } from "vitest";
import { addDays, daysInMonth, formatRange, isIsoDate, rangeLength } from "../dates";

describe("dates", () => {
  it("knows month lengths, including leap years", () => {
    expect(daysInMonth(2018, 2)).toBe(28);
    expect(daysInMonth(2020, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2018, 12)).toBe(31);
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2018-01-31", 1)).toBe("2018-02-01");
    expect(addDays("2018-12-31", 1)).toBe("2019-01-01");
    expect(addDays("2018-03-01", -1)).toBe("2018-02-28");
  });

  it("counts inclusive range length", () => {
    expect(rangeLength("2018-06-01", "2018-06-01")).toBe(1);
    expect(rangeLength("2018-06-01", "2018-06-03")).toBe(3);
    expect(rangeLength("2018-01-01", "2018-12-31")).toBe(365);
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2018-02-28")).toBe(true);
    expect(isIsoDate("2018-02-29")).toBe(false);
    expect(isIsoDate("2018-13-01")).toBe(false);
    expect(isIsoDate("06/01/2018")).toBe(false);
    expect(isIsoDate(20180601)).toBe(false);
  });

  it("formats ranges compactly", () => {
    expect(formatRange("2018-06-01", "2018-06-01")).toBe("Jun 1, 2018");
    expect(formatRange("2018-06-01", "2018-06-09")).toBe("Jun 1–9, 2018");
    expect(formatRange("2018-06-28", "2018-07-06")).toBe("Jun 28, 2018 – Jul 6, 2018");
  });
});
