// Seed script for DEMO_MODE deployments.
// Run via `npm run seed:local` or `npm run seed:remote`.
// Writes SQL to stdout; the npm scripts redirect it into scripts/seed.generated.sql
// and apply it with `wrangler d1 execute --file`.

import type * as schema from "../src/db/schema.ts";
import { hashPassword } from "../src/services/password.ts";
import { DEMO_USER, DEMO_USER_ID } from "../src/lib/demo.ts";

const DEMO_TEAM_ID = "demo-team";
const DEMO_CAMPAIGN_ID = "demo-campaign";
const DEMO_DOMAIN = "demo.veer.example";

const NOW = Math.floor(Date.now() / 1000);
const SECONDS_PER_DAY = 86400;

/** Epoch seconds `n` days before NOW. */
const daysAgo = (n: number) => NOW - n * SECONDS_PER_DAY;

// ── helpers ───────────────────────────────────────────────────────────────

type Schema = typeof schema;

/** Every schema table, keyed by its SQL name. */
type Tables = {
  [K in keyof Schema as Schema[K] extends { _: { name: infer N extends string } } ? N : never]: Schema[K];
};

/** A column value as the seed writes it: timestamps are epoch seconds. */
type SeedValue<V> = V extends Date ? number : V;

/** A table's insert shape, so a renamed or misspelt column fails the typecheck. */
type SeedRow<N extends keyof Tables> = {
  [K in keyof Tables[N]["$inferInsert"]]: SeedValue<Tables[N]["$inferInsert"][K]>;
};

type SqlValue = string | number | boolean | null;

function q(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/** An INSERT OR REPLACE for one row. Undefined values are left out, so the column takes its schema default. */
function insert<N extends keyof Tables>(table: N, row: SeedRow<N>): string {
  const entries = (Object.entries(row) as [string, SqlValue | undefined][])
    .filter((entry): entry is [string, SqlValue] => entry[1] !== undefined);
  return `INSERT OR REPLACE INTO ${table} (${entries.map(([k]) => k).join(", ")}) VALUES (${entries.map(([, v]) => q(v)).join(", ")});`;
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

type LinkSeed = Pick<
  SeedRow<"links">,
  "id" | "slug" | "destinationUrl" | "title" | "redirectType" | "domainHostname" | "expiresAt" | "maxClicks" | "password" | "teamId"
> & {
  popularity: number; // 1..10, drives the click-stats curve
};

// Link ids must be UUID-shaped: the stats routes reject any other link id.
const seedLinkId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AB_LINK_ID = seedLinkId(7);

const LINKS: LinkSeed[] = [
  {
    id: seedLinkId(1),
    slug: "launch",
    destinationUrl: "https://example.com/product-launch",
    title: "Product launch announcement",
    popularity: 10,
  },
  {
    id: seedLinkId(2),
    slug: "blog",
    destinationUrl: "https://example.com/blog",
    title: "Engineering blog",
    popularity: 7,
  },
  {
    id: seedLinkId(3),
    slug: "docs",
    destinationUrl: "https://example.com/docs",
    title: "Documentation",
    popularity: 5,
    redirectType: 301,
  },
  {
    id: seedLinkId(4),
    slug: "preview",
    destinationUrl: "https://example.com/secret-preview",
    title: "Password-gated preview (password: demo)",
    popularity: 3,
    password: await hashPassword("demo"),
  },
  {
    id: seedLinkId(5),
    slug: "early-bird",
    destinationUrl: "https://example.com/early-bird-offer",
    title: "Expired link example",
    popularity: 4,
    expiresAt: daysAgo(7),
  },
  {
    id: seedLinkId(6),
    slug: "first-100",
    destinationUrl: "https://example.com/first-100",
    title: "Max-clicks reached (cap: 100)",
    popularity: 6,
    maxClicks: 100,
  },
  {
    id: AB_LINK_ID,
    slug: "promo",
    destinationUrl: "https://example.com/promo-default",
    title: "Promo with A/B variants",
    popularity: 8,
  },
  {
    id: seedLinkId(8),
    slug: "hello",
    destinationUrl: "https://example.com/hello-world",
    title: "Custom-domain link",
    popularity: 4,
    domainHostname: DEMO_DOMAIN,
  },
  {
    id: seedLinkId(9),
    slug: "team-update",
    destinationUrl: "https://example.com/team-update",
    title: "Team-owned link",
    popularity: 2,
    teamId: DEMO_TEAM_ID,
  },
];

// "ab" matchValue is a weight; the weights must sum to under 100 so the link's own
// destinationUrl keeps the remainder.
const PROMO_TARGETS = [
  ["target-ab-us", "geo", "US", "https://example.com/promo-us", 0],
  ["target-ab-mobile", "device", "mobile", "https://example.com/promo-mobile", 1],
  ["target-ab-variant-a", "ab", "40", "https://example.com/promo-variant-a", 2],
  ["target-ab-variant-b", "ab", "25", "https://example.com/promo-variant-b", 2],
] as const;

// ── generation ────────────────────────────────────────────────────────────

const sql: string[] = ["-- Generated by scripts/seed.ts — do not edit by hand."];
// Re-running is idempotent: every row uses a stable ID, and INSERT OR REPLACE on a
// parent deletes the old row, cascading its children away. Children must therefore
// be inserted after their parent — link_targets, link_campaigns and link_stats all
// follow the links block below.

sql.push(insert("user", {
  id: DEMO_USER_ID,
  name: DEMO_USER.name,
  email: DEMO_USER.email,
  emailVerified: true,
  createdAt: daysAgo(90),
  updatedAt: NOW,
}));

sql.push(insert("domain_config", {
  hostname: DEMO_DOMAIN,
  rootRedirect: "https://example.com",
  updatedAt: NOW,
}));

sql.push(insert("teams", {
  id: DEMO_TEAM_ID,
  name: "Demo Team",
  createdAt: daysAgo(60),
  updatedAt: NOW,
}));
sql.push(insert("team_members", {
  teamId: DEMO_TEAM_ID,
  userId: DEMO_USER_ID,
  role: "admin",
  joinedAt: daysAgo(60),
}));

for (const link of LINKS) {
  sql.push(insert("links", {
    id: link.id,
    userId: DEMO_USER_ID,
    slug: link.slug,
    destinationUrl: link.destinationUrl,
    redirectType: link.redirectType,
    title: link.title,
    createdAt: daysAgo(90),
    updatedAt: NOW,
    expiresAt: link.expiresAt,
    maxClicks: link.maxClicks,
    password: link.password,
    domainHostname: link.domainHostname,
    teamId: link.teamId,
  }));
}

// campaign + link_targets for the A/B link
sql.push(insert("campaigns", {
  id: DEMO_CAMPAIGN_ID,
  userId: DEMO_USER_ID,
  name: "Spring promo",
  description: "A/B test for promo landing variants",
  createdAt: daysAgo(30),
  updatedAt: NOW,
}));
sql.push(insert("link_campaigns", { linkId: AB_LINK_ID, campaignId: DEMO_CAMPAIGN_ID }));
for (const [id, type, matchValue, destinationUrl, priority] of PROMO_TARGETS) {
  sql.push(insert("link_targets", { id, linkId: AB_LINK_ID, type, matchValue, destinationUrl, priority }));
}

// link_stats: 90 days of daily aggregates per link.
// Weekday/weekend variance + slight growth curve.
for (const link of LINKS) {
  const rng = mulberry32(link.id.split("").reduce((s, c) => s + c.charCodeAt(0), 0));
  for (let n = 89; n >= 0; n--) {
    const dayEpoch = daysAgo(n);
    // An expired link stops collecting clicks the moment it expires.
    if (link.expiresAt != null && dayEpoch > link.expiresAt) break;
    const date = new Date(dayEpoch * 1000);
    const dayOfWeek = date.getUTCDay();
    const weekendMul = dayOfWeek === 0 || dayOfWeek === 6 ? 0.6 : 1.0;
    const growth = 1 + (89 - n) / 180; // gentle ~1.5x growth over 90 days
    const jitter = 0.5 + rng() * 1.0;
    sql.push(insert("link_stats", {
      linkId: link.id,
      date: date.toISOString().slice(0, 10),
      clicks: Math.round(link.popularity * 3 * growth * weekendMul * jitter),
    }));
  }
}

console.log(sql.join("\n"));
