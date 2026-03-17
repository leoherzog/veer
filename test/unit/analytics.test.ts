import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { writeClickEvent, incrementClickStats } from "../../src/services/analytics";
import { getDb } from "../../src/db";

async function seedLink(db: D1Database, linkId: string) {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, ?, ?, ?)`
    )
    .bind("u1", "Test", "t@t.com", now, now, "user")
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO links (id, userId, slug, destinationUrl, redirectType, createdAt, updatedAt, isActive) VALUES (?, ?, ?, ?, 302, ?, ?, 1)`
    )
    .bind(linkId, "u1", `s-${linkId}`, "https://example.com", now, now)
    .run();
}

describe("writeClickEvent", () => {
  it("does not throw with a well-formed request", () => {
    const request = new Request("https://veer.ing/test-slug", {
      headers: {
        "user-agent": "TestAgent/1.0",
        referer: "https://referrer.example.com",
      },
    });

    expect(() => {
      writeClickEvent(env.ANALYTICS, {
        linkId: "link-1",
        slug: "test-slug",
        destinationUrl: "https://example.com/destination",
        request,
      });
    }).not.toThrow();
  });

  it("does not throw when headers are missing", () => {
    const request = new Request("https://veer.ing/bare");

    expect(() => {
      writeClickEvent(env.ANALYTICS, {
        linkId: "link-2",
        slug: "bare",
        destinationUrl: "https://example.com",
        request,
      });
    }).not.toThrow();
  });
});

describe("incrementClickStats", () => {
  const rawDb = env.DB;

  it("first call creates a row with clicks=1", async () => {
    await seedLink(rawDb, "lk-1");
    const db = getDb(rawDb);
    await incrementClickStats(db, "lk-1");

    const row = await rawDb
      .prepare(`SELECT clicks FROM link_stats WHERE linkId = ?`)
      .bind("lk-1")
      .first<{ clicks: number }>();
    expect(row).not.toBeNull();
    expect(row!.clicks).toBe(1);
  });

  it("second call increments to clicks=2", async () => {
    await seedLink(rawDb, "lk-2");
    const db = getDb(rawDb);
    await incrementClickStats(db, "lk-2");
    await incrementClickStats(db, "lk-2");

    const row = await rawDb
      .prepare(`SELECT clicks FROM link_stats WHERE linkId = ?`)
      .bind("lk-2")
      .first<{ clicks: number }>();
    expect(row).not.toBeNull();
    expect(row!.clicks).toBe(2);
  });

  it("different dates create separate rows", async () => {
    await seedLink(rawDb, "lk-3");
    const db = getDb(rawDb);

    // Insert first click (today's date via the service)
    await incrementClickStats(db, "lk-3");

    // Manually insert a row for a different date to simulate a past click
    await rawDb
      .prepare(
        `INSERT INTO link_stats (linkId, date, clicks, uniqueClicks) VALUES (?, ?, 5, 0)`
      )
      .bind("lk-3", "2025-01-01")
      .run();

    const rows = await rawDb
      .prepare(`SELECT date, clicks FROM link_stats WHERE linkId = ? ORDER BY date`)
      .bind("lk-3")
      .all<{ date: string; clicks: number }>();

    expect(rows.results.length).toBe(2);

    const pastRow = rows.results.find((r) => r.date === "2025-01-01");
    expect(pastRow).toBeDefined();
    expect(pastRow!.clicks).toBe(5);

    const todayRow = rows.results.find((r) => r.date !== "2025-01-01");
    expect(todayRow).toBeDefined();
    expect(todayRow!.clicks).toBe(1);
  });
});
