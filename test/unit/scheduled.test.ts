import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { scheduled } from "../../src/scheduled";
import { mockExecutionCtx } from "../helpers";

const demoEnv = { ...env, DEMO_MODE: "true" } as unknown as Env;

function fakeEvent(): ScheduledController {
  return { scheduledTime: Date.now(), cron: "0 * * * *", noRetry: () => {} };
}

async function getStatsRow(linkId: string, date: string) {
  return env.DB
    .prepare("SELECT clicks, uniqueClicks FROM link_stats WHERE linkId = ? AND date = ?")
    .bind(linkId, date)
    .first<{ clicks: number; uniqueClicks: number }>();
}

describe("scheduled handler", () => {
  it("early-returns when DEMO_MODE is unset (no link_stats writes)", async () => {
    const linkId = "sched-no-demo-link";
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('demo-user', 'Demo', 'demo@x', 0, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO links (id, userId, slug, destinationUrl, createdAt, updatedAt) VALUES (?, 'demo-user', ?, 'https://example.com', ?, ?)`,
      )
      .bind(linkId, `sched-${linkId}`, now, now)
      .run();

    const today = new Date().toISOString().slice(0, 10);
    await scheduled(fakeEvent(), env, mockExecutionCtx());

    const row = await getStatsRow(linkId, today);
    expect(row).toBeNull();
  });

  it("upserts today's link_stats for every seeded demo link when DEMO_MODE=true", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('demo-user', 'Demo', 'demo@x', 0, ?, ?)`,
      )
      .bind(now, now)
      .run();

    const linkId = "sched-demo-link";
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO links (id, userId, slug, destinationUrl, createdAt, updatedAt) VALUES (?, 'demo-user', ?, 'https://example.com', ?, ?)`,
      )
      .bind(linkId, `sched-${linkId}`, now, now)
      .run();

    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM link_stats WHERE linkId = ?").bind(linkId).run();

    await scheduled(fakeEvent(), demoEnv, mockExecutionCtx());

    const row = await getStatsRow(linkId, today);
    expect(row).not.toBeNull();
    expect(row!.clicks).toBeGreaterThanOrEqual(1);
    expect(row!.clicks).toBeLessThanOrEqual(5);
    expect(row!.uniqueClicks).toBeGreaterThanOrEqual(1);
    expect(row!.uniqueClicks).toBeLessThanOrEqual(row!.clicks);
  });

  it("increments clicks on a second invocation (onConflictDoUpdate)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('demo-user', 'Demo', 'demo@x', 0, ?, ?)`,
      )
      .bind(now, now)
      .run();

    const linkId = "sched-increment-link";
    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO links (id, userId, slug, destinationUrl, createdAt, updatedAt) VALUES (?, 'demo-user', ?, 'https://example.com', ?, ?)`,
      )
      .bind(linkId, `sched-${linkId}`, now, now)
      .run();

    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM link_stats WHERE linkId = ?").bind(linkId).run();

    await scheduled(fakeEvent(), demoEnv, mockExecutionCtx());
    const first = await getStatsRow(linkId, today);
    await scheduled(fakeEvent(), demoEnv, mockExecutionCtx());
    const second = await getStatsRow(linkId, today);

    expect(second!.clicks).toBeGreaterThan(first!.clicks);
  });
});
