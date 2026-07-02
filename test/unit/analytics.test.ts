import { describe, it, expect, vi } from "vitest";
import { writeClickEvent } from "../../src/services/analytics";

// Stub dataset that just records what writeDataPoint was called with, instead
// of the real fire-and-forget AE binding (which never throws and so can't
// catch a broken payload).
function makeStubDataset() {
  return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
}

describe("writeClickEvent", () => {
  // Positional contract from src/services/analytics.ts, which must stay in
  // sync with the reads in src/routes/api/stats.ts:
  //   index1 = linkId
  //   blob1  = slug           (not queried)
  //   blob2  = country        (geo endpoint)
  //   blob3  = user-agent     (devices endpoint)
  //   blob4  = referer        (referrers endpoint)
  //   blob5  = city           (geo endpoint)
  //   blob6  = destinationUrl (A/B stats endpoint)
  //   blob7  = region         (not queried)
  it("writes every blob to its documented position for a well-formed request", () => {
    const dataset = makeStubDataset();
    const request = new Request("https://veer.ing/test-slug", {
      headers: {
        "user-agent": "TestAgent/1.0",
        referer: "https://referrer.example.com",
      },
    });

    expect(() => {
      writeClickEvent(dataset, {
        linkId: "link-1",
        slug: "test-slug",
        destinationUrl: "https://example.com/destination",
        request,
      });
    }).not.toThrow();

    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
    const point = (dataset.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(point.indexes).toEqual(["link-1"]);
    expect(point.blobs).toEqual([
      "test-slug", // blob1: slug
      "", // blob2: country (no cf on this request)
      "TestAgent/1.0", // blob3: user-agent
      "https://referrer.example.com", // blob4: referer
      "", // blob5: city (no cf on this request)
      "https://example.com/destination", // blob6: destinationUrl
      "", // blob7: region (no cf on this request)
    ]);
    expect(point.doubles).toHaveLength(1);
    expect(point.doubles[0]).toBeCloseTo(Date.now(), -2);
  });

  it("falls back to empty strings, not null/undefined, for every missing header or cf field", () => {
    const dataset = makeStubDataset();
    const request = new Request("https://veer.ing/bare");

    expect(() => {
      writeClickEvent(dataset, {
        linkId: "link-2",
        slug: "bare",
        destinationUrl: "https://example.com",
        request,
      });
    }).not.toThrow();

    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1);
    const point = (dataset.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(point.indexes).toEqual(["link-2"]);
    expect(point.blobs).toEqual([
      "bare", // blob1: slug
      "", // blob2: country fallback
      "", // blob3: user-agent fallback
      "", // blob4: referer fallback
      "", // blob5: city fallback
      "https://example.com", // blob6: destinationUrl
      "", // blob7: region fallback
    ]);
    // Every fallback slot must be "" specifically — not missing/null/undefined.
    for (const i of [1, 2, 3, 4, 6]) {
      expect(point.blobs[i]).toBe("");
    }
    expect(point.doubles).toHaveLength(1);
    expect(point.doubles[0]).toBeCloseTo(Date.now(), -2);
  });
});
