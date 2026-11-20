import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { scheduled } from "../../src/scheduled";
import { DEMO_USER_ID } from "../../src/lib/demo";
import { mockExecutionCtx, isoDaysAgo, createTestLink, insertClickStat, createDemoUser, demoEnv } from "../helpers";

async function getStatsRow(linkId: string, date: string) {
  return env.DB
    .prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
    .bind(linkId, date)
    .first<{ clicks: number }>();
}

describe("scheduled handler", () => {
  beforeAll(createDemoUser);

  // The handler writes today's row; a frozen clock keeps "today" the same day for the test.
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes no link_stats row when DEMO_MODE is unset", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });

    await scheduled(createScheduledController(), env, mockExecutionCtx());

    expect(await getStatsRow(link.id, isoDaysAgo(0))).toBeNull();
  });

  it("adds 1 to 5 clicks to a demo link's row for today", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });

    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());

    const row = await getStatsRow(link.id, isoDaysAgo(0));
    expect(row).not.toBeNull();
    expect(row!.clicks).toBeGreaterThanOrEqual(1);
    expect(row!.clicks).toBeLessThanOrEqual(5);
  });

  it("adds to today's row on a second run instead of replacing it", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });
    const today = isoDaysAgo(0);
    // A roll of 0 makes each run add exactly one click.
    vi.spyOn(Math, "random").mockReturnValue(0);

    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());
    const first = await getStatsRow(link.id, today);
    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());
    const second = await getStatsRow(link.id, today);

    expect(first!.clicks).toBe(1);
    expect(second!.clicks).toBe(2);
  });

  it("skips expired and capped links", async () => {
    const expired = await createTestLink({ userId: DEMO_USER_ID, expiresAt: new Date(Date.now() - 60_000) });
    const capped = await createTestLink({ userId: DEMO_USER_ID, maxClicks: 1000 });
    const expiresLater = await createTestLink({ userId: DEMO_USER_ID, expiresAt: new Date(Date.now() + 3_600_000) });
    const today = isoDaysAgo(0);

    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());

    expect(await getStatsRow(expired.id, today)).toBeNull();
    expect(await getStatsRow(capped.id, today)).toBeNull();
    expect(await getStatsRow(expiresLater.id, today)).not.toBeNull();
  });

  it("writes one AE event per click it adds to link_stats", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });
    const writeDataPoint = vi.fn<(point?: AnalyticsEngineDataPoint) => void>();

    await scheduled(createScheduledController(), { ...demoEnv, ANALYTICS: { writeDataPoint } }, mockExecutionCtx());

    const events = writeDataPoint.mock.calls.filter(([point]) => point?.indexes?.[0] === link.id);
    const row = await getStatsRow(link.id, isoDaysAgo(0));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBe(row!.clicks);
    expect(events[0][0]?.blobs?.[0]).toBe(link.slug);
  });

  it("cascades link_stats away when the link is deleted", async () => {
    // The seed's idempotency rests on this cascade, which only exists because the
    // suite applies drizzle/migrations rather than an ad-hoc schema.
    const link = await createTestLink({ userId: DEMO_USER_ID });
    await insertClickStat(link.id, 3, "2026-01-01");

    await env.DB.prepare("DELETE FROM links WHERE id = ?").bind(link.id).run();

    expect(await getStatsRow(link.id, "2026-01-01")).toBeNull();
  });
});
