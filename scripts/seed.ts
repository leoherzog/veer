// Seed script for DEMO_MODE deployments.
// Run via `npm run seed:local` or `npm run seed:remote`.
// Writes SQL to stdout; the npm scripts redirect it into scripts/seed.generated.sql
// and apply it with `wrangler d1 execute --file`.

import {
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_LENGTH,
  PBKDF2_SALT_LENGTH,
} from "../src/lib/password-params";
import { DEMO_USER, DEMO_USER_ID } from "../src/lib/demo";

const DEMO_TEAM_ID = "demo-team";
const DEMO_CAMPAIGN_ID = "demo-campaign";
const DEMO_DOMAIN = "demo.veer.example";

const NOW = Math.floor(Date.now() / 1000);
const SECONDS_PER_DAY = 86400;

// ── helpers ───────────────────────────────────────────────────────────────

function q(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    PBKDF2_KEY_LENGTH * 8,
  );
  const toHex = (bytes: Uint8Array) =>
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${toHex(salt)}:${toHex(new Uint8Array(hash))}`;
}

// Deterministic pseudo-random for stable click distributions across re-runs.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── link fixtures ─────────────────────────────────────────────────────────

interface LinkSeed {
  id: string;
  slug: string;
  destinationUrl: string;
  title: string | null;
  redirectType: number;
  isActive: boolean;
  domainHostname: string | null;
  expiresAt: number | null;
  maxClicks: number | null;
  password: string | null; // hashed, set later for the protected link
  popularity: number; // 1..10, drives the click-stats curve
  teamId: string | null;
}

const LINKS: LinkSeed[] = [
  {
    id: "link-launch",
    slug: "launch",
    destinationUrl: "https://example.com/product-launch",
    title: "Product launch announcement",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: null,
    password: null,
    popularity: 10,
    teamId: null,
  },
  {
    id: "link-blog",
    slug: "blog",
    destinationUrl: "https://example.com/blog",
    title: "Engineering blog",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: null,
    password: null,
    popularity: 7,
    teamId: null,
  },
  {
    id: "link-docs",
    slug: "docs",
    destinationUrl: "https://example.com/docs",
    title: "Documentation",
    redirectType: 301,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: null,
    password: null,
    popularity: 5,
    teamId: null,
  },
  {
    id: "link-protected",
    slug: "preview",
    destinationUrl: "https://example.com/secret-preview",
    title: "Password-gated preview (password: demo)",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: null,
    password: "PLACEHOLDER",
    popularity: 3,
    teamId: null,
  },
  {
    id: "link-expired",
    slug: "early-bird",
    destinationUrl: "https://example.com/early-bird-offer",
    title: "Expired link example",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: NOW - 7 * SECONDS_PER_DAY,
    maxClicks: null,
    password: null,
    popularity: 4,
    teamId: null,
  },
  {
    id: "link-capped",
    slug: "first-100",
    destinationUrl: "https://example.com/first-100",
    title: "Max-clicks reached (cap: 100)",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: 100,
    password: null,
    popularity: 6,
    teamId: null,
  },
  {
    id: "link-ab",
    slug: "promo",
    destinationUrl: "https://example.com/promo-default",
    title: "Promo with A/B variants",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: null,
    password: null,
    popularity: 8,
    teamId: null,
  },
  {
    id: "link-custom-domain",
    slug: "hello",
    destinationUrl: "https://example.com/hello-world",
    title: "Custom-domain link",
    redirectType: 302,
    isActive: true,
    domainHostname: DEMO_DOMAIN,
    expiresAt: null,
    maxClicks: null,
    password: null,
    popularity: 4,
    teamId: null,
  },
  {
    id: "link-team",
    slug: "team-update",
    destinationUrl: "https://example.com/team-update",
    title: "Team-owned link",
    redirectType: 302,
    isActive: true,
    domainHostname: null,
    expiresAt: null,
    maxClicks: null,
    password: null,
    popularity: 2,
    teamId: DEMO_TEAM_ID,
  },
];

// ── generation ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const passwordHash = await hashPassword("demo");
  const protectedLink = LINKS.find((l) => l.id === "link-protected")!;
  protectedLink.password = passwordHash;

  const sql: string[] = [];

  sql.push("-- Generated by scripts/seed.ts — do not edit by hand.");
  // Re-running is idempotent: every row uses a stable ID, and INSERT OR REPLACE on a
  // parent deletes the old row, cascading its children away. Children must therefore
  // be inserted after their parent — link_targets, link_campaigns and link_stats all
  // follow the links block below.

  // user
  sql.push(
    `INSERT OR REPLACE INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, maxLinks) VALUES (${[
      q(DEMO_USER_ID),
      q(DEMO_USER.name),
      q(DEMO_USER.email),
      q(true),
      q(null),
      q(NOW - 90 * SECONDS_PER_DAY),
      q(NOW),
      q(null),
    ].join(", ")});`,
  );

  // domain_config
  sql.push(
    `INSERT OR REPLACE INTO domain_config (hostname, rootRedirect, notFoundRedirect, accessMode, updatedAt) VALUES (${[
      q(DEMO_DOMAIN),
      q("https://example.com"),
      q(null),
      q("all"),
      q(NOW),
    ].join(", ")});`,
  );

  // teams
  sql.push(
    `INSERT OR REPLACE INTO teams (id, name, slug, createdAt, updatedAt) VALUES (${[
      q(DEMO_TEAM_ID),
      q("Demo Team"),
      q("demo-team"),
      q(NOW - 60 * SECONDS_PER_DAY),
      q(NOW),
    ].join(", ")});`,
  );
  sql.push(
    `INSERT OR REPLACE INTO team_members (teamId, userId, role, joinedAt) VALUES (${[
      q(DEMO_TEAM_ID),
      q(DEMO_USER_ID),
      q("admin"),
      q(NOW - 60 * SECONDS_PER_DAY),
    ].join(", ")});`,
  );

  // links
  for (const link of LINKS) {
    sql.push(
      `INSERT OR REPLACE INTO links (id, userId, slug, destinationUrl, redirectType, title, createdAt, updatedAt, isActive, expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage, paramForwarding, domainHostname, teamId) VALUES (${[
        q(link.id),
        q(DEMO_USER_ID),
        q(link.slug),
        q(link.destinationUrl),
        q(link.redirectType),
        q(link.title),
        q(NOW - 90 * SECONDS_PER_DAY),
        q(NOW),
        q(link.isActive),
        q(link.expiresAt),
        q(link.maxClicks),
        q(link.password),
        q(false),
        q(null),
        q(null),
        q(null),
        q(false),
        q(link.domainHostname),
        q(link.teamId),
      ].join(", ")});`,
    );
  }

  // campaign + link_targets for the A/B link
  sql.push(
    `INSERT OR REPLACE INTO campaigns (id, userId, name, description, createdAt, updatedAt) VALUES (${[
      q(DEMO_CAMPAIGN_ID),
      q(DEMO_USER_ID),
      q("Spring promo"),
      q("A/B test for promo landing variants"),
      q(NOW - 30 * SECONDS_PER_DAY),
      q(NOW),
    ].join(", ")});`,
  );
  sql.push(
    `INSERT OR REPLACE INTO link_campaigns (linkId, campaignId) VALUES (${q("link-ab")}, ${q(DEMO_CAMPAIGN_ID)});`,
  );
  sql.push(
    `INSERT OR REPLACE INTO link_targets (id, linkId, type, matchValue, destinationUrl, priority) VALUES (${[
      q("target-ab-us"),
      q("link-ab"),
      q("geo"),
      q("US"),
      q("https://example.com/promo-us"),
      q(0),
    ].join(", ")});`,
  );
  sql.push(
    `INSERT OR REPLACE INTO link_targets (id, linkId, type, matchValue, destinationUrl, priority) VALUES (${[
      q("target-ab-mobile"),
      q("link-ab"),
      q("device"),
      q("mobile"),
      q("https://example.com/promo-mobile"),
      q(1),
    ].join(", ")});`,
  );
  // "ab" matchValue is a weight; the weights must sum to under 100 so the link's own
  // destinationUrl keeps the remainder.
  for (const [id, weight, dest] of [
    ["target-ab-variant-a", 40, "https://example.com/promo-variant-a"],
    ["target-ab-variant-b", 25, "https://example.com/promo-variant-b"],
  ] as const) {
    sql.push(
      `INSERT OR REPLACE INTO link_targets (id, linkId, type, matchValue, destinationUrl, priority) VALUES (${[
        q(id),
        q("link-ab"),
        q("ab"),
        q(String(weight)),
        q(dest),
        q(2),
      ].join(", ")});`,
    );
  }

  // link_stats: 90 days of daily aggregates per link.
  // Weekday/weekend variance + slight growth curve.
  for (const link of LINKS) {
    const rng = mulberry32(link.id.split("").reduce((s, c) => s + c.charCodeAt(0), 0));
    for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
      const dayEpoch = NOW - daysAgo * SECONDS_PER_DAY;
      // An expired link stops collecting clicks the moment it expires.
      if (link.expiresAt !== null && dayEpoch > link.expiresAt) break;
      const date = new Date(dayEpoch * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const dayOfWeek = date.getUTCDay();
      const weekendMul = dayOfWeek === 0 || dayOfWeek === 6 ? 0.6 : 1.0;
      const growth = 1 + (89 - daysAgo) / 180; // gentle ~1.5x growth over 90 days
      const base = link.popularity * 3;
      const jitter = 0.5 + rng() * 1.0;
      const clicks = Math.max(0, Math.round(base * growth * weekendMul * jitter));
      const uniqueClicks = Math.max(0, Math.round(clicks * (0.6 + rng() * 0.3)));
      if (clicks === 0) continue;
      sql.push(
        `INSERT OR REPLACE INTO link_stats (linkId, date, clicks, uniqueClicks) VALUES (${[
          q(link.id),
          q(dateStr),
          q(clicks),
          q(uniqueClicks),
        ].join(", ")});`,
      );
    }
  }

  console.log(sql.join("\n"));
}

await main();
