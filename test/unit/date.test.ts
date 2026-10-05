import { describe, it, expect } from "vitest";
import { formatDate, formatHour, formatWeek } from "../../src/lib/date";

describe("formatDate", () => {
  it.each([
    ["2025-01-15", "Jan 15"],
    ["2025-06-01", "Jun 1"],
    // getUTC* keeps the label on the UTC day whatever the runtime's time zone.
    ["2026-01-01T00:00:00Z", "Jan 1"],
  ])("formats %s as %s", (input, label) => {
    expect(formatDate(input)).toBe(label);
  });
});

describe("formatHour", () => {
  it("zero-pads single-digit hours and minutes", () => {
    expect(formatHour("2025-03-05T04:07:00Z")).toBe("Mar 5 04:07");
  });

  it("renders two-digit hours and minutes as-is", () => {
    expect(formatHour("2025-03-05T14:35:00Z")).toBe("Mar 5 14:35");
  });
});

describe("formatWeek", () => {
  it("prefixes the month/day with 'Week of '", () => {
    expect(formatWeek("2026-03-05")).toBe("Week of Mar 5");
  });
});
