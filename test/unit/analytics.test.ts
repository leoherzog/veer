import { describe, it, expect, vi } from "vitest";
import { requestVisitor, writeClickEvent } from "../../src/services/analytics";

// Stub dataset that just records what writeDataPoint was called with, instead
// of the real fire-and-forget AE binding (which never throws and so can't
// catch a broken payload).
function makeStubDataset() {
  return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
}

describe("writeClickEvent", () => {
  // Positional contract: see writeClickEvent in src/services/analytics.ts.
  it("writes every blob to its documented position", () => {
    const dataset = makeStubDataset();
    const before = Date.now();

    writeClickEvent(dataset, {
      linkId: "link-1",
      slug: "test-slug",
      destinationUrl: "https://example.com/destination",
      country: "US",
      city: "Austin",
      region: "Texas",
      userAgent: "TestAgent/1.0",
      referer: "https://referrer.example.com",
    });

    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
    const point = (dataset.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(point.indexes).toEqual(["link-1"]);
    expect(point.blobs).toEqual([
      "test-slug", // blob1: slug
      "US", // blob2: country
      "TestAgent/1.0", // blob3: user-agent
      "https://referrer.example.com", // blob4: referer
      "Austin", // blob5: city
      "https://example.com/destination", // blob6: destinationUrl
      "Texas", // blob7: region
    ]);
    expect(point.doubles).toHaveLength(1);
    expect(point.doubles[0]).toBeGreaterThanOrEqual(before);
    expect(point.doubles[0]).toBeLessThanOrEqual(Date.now());
  });
});

describe("requestVisitor", () => {
  it("reads the user-agent and referer headers", () => {
    const request = new Request("https://veer.ing/test-slug", {
      headers: { "user-agent": "TestAgent/1.0", referer: "https://referrer.example.com" },
    });

    expect(requestVisitor(request)).toMatchObject({
      userAgent: "TestAgent/1.0",
      referer: "https://referrer.example.com",
    });
  });

  it("falls back to empty strings, not null/undefined, for every missing header or cf field", () => {
    expect(requestVisitor(new Request("https://veer.ing/bare"))).toEqual({
      country: "",
      city: "",
      region: "",
      userAgent: "",
      referer: "",
    });
  });
});
