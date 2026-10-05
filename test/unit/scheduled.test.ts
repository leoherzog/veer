import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { scheduled } from "../../src/scheduled";
import { DEMO_USER_ID } from "../../src/lib/demo";
import { mockExecutionCtx, isoDaysAgo, createTestLink, insertClickStat } from "../helpers";

const demoEnv = { ...env, DEMO_MODE: "true" } as unknown as Env;

async function getStatsRow(linkId: string, date: string) {
  return env.DB
    .prepare("SELECT clicks FROM link_stats WHERE linkId = ? AND date = ?")
    .bind(linkId, date)
    .first<{ clicks: number }>();
}

describe("scheduled handler", () => {
  beforeAll(async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Demo', 'demo@x', 0, ?, ?)`,
      )
      .bind(DEMO_USER_ID, now, now)
      .run();
  });

  it("early-returns when DEMO_MODE is unset (no link_stats writes)", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });

    await scheduled(createScheduledController(), env, mockExecutionCtx());

    expect(await getStatsRow(link.id, isoDaysAgo(0))).toBeNull();
  });

  it("upserts today's link_stats for every seeded demo link when DEMO_MODE=true", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });

    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());

    const row = await getStatsRow(link.id, isoDaysAgo(0));
    expect(row).not.toBeNull();
    expect(row!.clicks).toBeGreaterThanOrEqual(1);
    expect(row!.clicks).toBeLessThanOrEqual(5);
  });

  it("increments clicks on a second invocation (onConflictDoUpdate)", async () => {
    const link = await createTestLink({ userId: DEMO_USER_ID });
    const today = isoDaysAgo(0);

    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());
    const first = await getStatsRow(link.id, today);
    await scheduled(createScheduledController(), demoEnv, mockExecutionCtx());
    const second = await getStatsRow(link.id, today);

    expect(second!.clicks).toBeGreaterThan(first!.clicks);
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
