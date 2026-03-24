import { describe, it, expect } from "vitest";
import { formatDate } from "../../src/lib/date";

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
});
