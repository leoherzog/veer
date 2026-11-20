import { describe, it, expect, vi } from "vitest";
import { clickSeries, requestVisitor, writeClickEvent } from "../../src/services/analytics";

// Stub dataset that just records what writeDataPoint was called with, instead
// of the real fire-and-forget AE binding (which never throws and so can't
// catch a broken payload).
function makeStubDataset() {
  return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
}

describe("writeClickEvent", () => {
  // Positional contract: see writeClickEvent in src/services/analytics.ts.
  it("writes every blob to its documented position and no doubles", () => {
    const dataset = makeStubDataset();

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

    expect(point).toEqual({
      indexes: ["link-1"],
      blobs: [
        "test-slug", // blob1: slug
        "US", // blob2: country
        "TestAgent/1.0", // blob3: user-agent
        "https://referrer.example.com", // blob4: referer
        "Austin", // blob5: city
        "https://example.com/destination", // blob6: destinationUrl
        "Texas", // blob7: region
      ],
    });
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

  it("reads country, city and region from request.cf", () => {
    // Distinct values, so a swapped city and region fails.
    const request = new Request("https://veer.ing/x", { cf: { country: "DE", city: "Munich", region: "Bavaria" } });

    expect(requestVisitor(request)).toMatchObject({ country: "DE", city: "Munich", region: "Bavaria" });
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

describe("clickSeries", () => {
  const day = 86_400_000;
  const start = Date.parse("2026-03-01");
  const label = (iso: string) => iso.slice(0, 10);

  it("emits one zero-filled bucket per step from start through end", () => {
    const series = clickSeries([{ at: start + 2 * day, clicks: 4 }], { start, end: start + 3 * day + 1, step: day }, label);

    expect(series).toEqual({
      labels: ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"],
      clicks: [0, 0, 4, 0],
    });
  });

  it("adds every row inside a bucket to it", () => {
    const series = clickSeries(
      [{ at: start, clicks: 1 }, { at: start + day - 1, clicks: 2 }, { at: start + day, clicks: 5 }],
      { start, end: start + day, step: day },
      label,
    );

    expect(series.clicks).toEqual([3, 5]);
  });

  it("puts a row just outside the range in the nearest bucket", () => {
    const series = clickSeries(
      [{ at: start - 1, clicks: 1 }, { at: start + 5 * day, clicks: 2 }],
      { start, end: start + day, step: day },
      label,
    );

    expect(series.clicks).toEqual([1, 2]);
  });
});
