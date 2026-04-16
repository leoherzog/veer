import { describe, it, expect } from "vitest";
import { formatDate, formatHour, formatWeek } from "../../src/lib/date";

describe("formatDate", () => {
  it("formats January 15", () => {
    expect(formatDate("2025-01-15")).toBe("Jan 15");
  });

  it("formats December 31", () => {
    expect(formatDate("2025-12-31")).toBe("Dec 31");
  });

  it("formats June 1 (no leading zero on day)", () => {
    expect(formatDate("2025-06-01")).toBe("Jun 1");
  });

  it("formats February 28", () => {
    expect(formatDate("2025-02-28")).toBe("Feb 28");
  });

  it("formats March 5", () => {
    expect(formatDate("2026-03-05")).toBe("Mar 5");
  });

  it("formats September 30", () => {
    expect(formatDate("2024-09-30")).toBe("Sep 30");
  });

  it("formats November 1", () => {
    expect(formatDate("2025-11-01")).toBe("Nov 1");
  });

  it("formats August 20", () => {
    expect(formatDate("2023-08-20")).toBe("Aug 20");
  });

  it("uses UTC month/day (not local TZ)", () => {
    // 2026-01-01T00:00:00Z in local TZ behind UTC would still be "Jan 1" thanks to getUTC*
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("Jan 1");
  });
});

describe("formatHour", () => {
  it("zero-pads single-digit hours and minutes", () => {
    expect(formatHour("2025-03-05T04:07:00Z")).toBe("Mar 5 04:07");
  });

  it("renders two-digit hours and minutes as-is", () => {
    expect(formatHour("2025-03-05T14:35:00Z")).toBe("Mar 5 14:35");
  });

  it("handles midnight", () => {
    expect(formatHour("2026-12-31T00:00:00Z")).toBe("Dec 31 00:00");
  });

  it("handles end of day", () => {
    expect(formatHour("2026-12-31T23:59:00Z")).toBe("Dec 31 23:59");
  });
});

describe("formatWeek", () => {
  it("prefixes the month/day with 'Week of '", () => {
    expect(formatWeek("2026-03-05")).toBe("Week of Mar 5");
  });

  it("works for end-of-year dates", () => {
    expect(formatWeek("2025-12-29")).toBe("Week of Dec 29");
  });
});
