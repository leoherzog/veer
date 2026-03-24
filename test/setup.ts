import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

// Individual migration statements from drizzle/migrations/0000_initial.sql
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS \`account\` (\`id\` text PRIMARY KEY NOT NULL, \`accountId\` text NOT NULL, \`providerId\` text NOT NULL, \`userId\` text NOT NULL, \`accessToken\` text, \`refreshToken\` text, \`idToken\` text, \`accessTokenExpiresAt\` integer, \`refreshTokenExpiresAt\` integer, \`scope\` text, \`password\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE INDEX IF NOT EXISTS \`account_userId_idx\` ON \`account\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`link_stats\` (\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL, \`linkId\` text NOT NULL, \`date\` text NOT NULL, \`clicks\` integer DEFAULT 0 NOT NULL, \`uniqueClicks\` integer DEFAULT 0 NOT NULL, FOREIGN KEY (\`linkId\`) REFERENCES \`links\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_link_stats_linkId_date\` ON \`link_stats\` (\`linkId\`,\`date\`)`,
  `CREATE TABLE IF NOT EXISTS \`links\` (\`id\` text PRIMARY KEY NOT NULL, \`userId\` text NOT NULL, \`slug\` text NOT NULL, \`destinationUrl\` text NOT NULL, \`redirectType\` integer DEFAULT 302 NOT NULL, \`title\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, \`isActive\` integer DEFAULT true NOT NULL, \`expiresAt\` integer, \`maxClicks\` integer, \`password\` text, \`isInternal\` integer DEFAULT false NOT NULL, \`ogTitle\` text, \`ogDescription\` text, \`ogImage\` text, \`paramForwarding\` integer DEFAULT false NOT NULL, \`domainHostname\` text REFERENCES \`domain_config\`(\`hostname\`) ON DELETE SET NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_links_slug_domain\` ON \`links\` (\`slug\`,\`domainHostname\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_links_userId\` ON \`links\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`passkey\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text, \`publicKey\` text NOT NULL, \`userId\` text NOT NULL, \`credentialID\` text NOT NULL, \`counter\` integer DEFAULT 0 NOT NULL, \`deviceType\` text NOT NULL, \`backedUp\` integer DEFAULT false NOT NULL, \`transports\` text, \`createdAt\` integer, \`aaguid\` text, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`passkey_credentialID_idx\` ON \`passkey\` (\`credentialID\`)`,
  `CREATE INDEX IF NOT EXISTS \`passkey_userId_idx\` ON \`passkey\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`session\` (\`id\` text PRIMARY KEY NOT NULL, \`expiresAt\` integer NOT NULL, \`token\` text NOT NULL, \`ipAddress\` text, \`userAgent\` text, \`userId\` text NOT NULL, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`session_token_idx\` ON \`session\` (\`token\`)`,
  `CREATE TABLE IF NOT EXISTS \`user\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL, \`email\` text NOT NULL, \`emailVerified\` integer DEFAULT false NOT NULL, \`image\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, \`role\` text DEFAULT 'user')`,
  `CREATE TABLE IF NOT EXISTS \`verification\` (\`id\` text PRIMARY KEY NOT NULL, \`identifier\` text NOT NULL, \`value\` text NOT NULL, \`expiresAt\` integer NOT NULL, \`createdAt\` integer, \`updatedAt\` integer)`,
];

// M2: campaigns, link_targets, link_campaigns
const M2_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS \`campaigns\` (\`id\` text PRIMARY KEY NOT NULL, \`userId\` text NOT NULL, \`name\` text NOT NULL, \`description\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE INDEX IF NOT EXISTS \`idx_campaigns_userId\` ON \`campaigns\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`link_targets\` (\`id\` text PRIMARY KEY NOT NULL, \`linkId\` text NOT NULL, \`type\` text NOT NULL, \`matchValue\` text NOT NULL, \`destinationUrl\` text NOT NULL, \`priority\` integer DEFAULT 0 NOT NULL, FOREIGN KEY (\`linkId\`) REFERENCES \`links\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE INDEX IF NOT EXISTS \`idx_link_targets_linkId\` ON \`link_targets\` (\`linkId\`)`,
  `CREATE TABLE IF NOT EXISTS \`link_campaigns\` (\`linkId\` text NOT NULL, \`campaignId\` text NOT NULL, PRIMARY KEY (\`linkId\`, \`campaignId\`), FOREIGN KEY (\`linkId\`) REFERENCES \`links\`(\`id\`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (\`campaignId\`) REFERENCES \`campaigns\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE INDEX IF NOT EXISTS \`idx_link_campaigns_campaignId\` ON \`link_campaigns\` (\`campaignId\`)`,
];

// M5: domain_config and domain_access tables
const DOMAIN_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS \`domain_config\` (\`hostname\` text PRIMARY KEY NOT NULL, \`rootRedirect\` text, \`notFoundRedirect\` text, \`accessMode\` text NOT NULL DEFAULT 'all', \`updatedAt\` integer NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS \`domain_access\` (\`hostname\` text NOT NULL REFERENCES \`domain_config\`(\`hostname\`) ON DELETE CASCADE, \`email\` text NOT NULL, PRIMARY KEY (\`hostname\`, \`email\`))`,
];

beforeAll(async () => {
  // Must create user table first (FK references), then links (FK from link_stats)
  // Reorder: user -> session -> account -> verification -> passkey -> links -> link_stats -> domain tables
  const ordered = [
    STATEMENTS[12], // user
    STATEMENTS[10], // session
    STATEMENTS[11], // session_token_idx
    STATEMENTS[0],  // account
    STATEMENTS[1],  // account_userId_idx
    STATEMENTS[13], // verification
    STATEMENTS[7],  // passkey
    STATEMENTS[8],  // passkey_credentialID_idx
    STATEMENTS[9],  // passkey_userId_idx
    ...DOMAIN_STATEMENTS, // domain_config, domain_access (before links for FK)
    STATEMENTS[4],  // links
    STATEMENTS[5],  // idx_links_slug_domain
    STATEMENTS[6],  // idx_links_userId
    `CREATE INDEX IF NOT EXISTS "idx_links_domainHostname" ON "links" ("domainHostname")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "idx_links_slug_default" ON "links" ("slug") WHERE "domainHostname" IS NULL`,
    STATEMENTS[2],  // link_stats
    STATEMENTS[3],  // idx_link_stats_linkId_date
    ...M2_STATEMENTS, // campaigns, link_targets, link_campaigns
    // M4: api_keys, public_reports
    `CREATE TABLE IF NOT EXISTS \`api_keys\` (\`id\` text PRIMARY KEY NOT NULL, \`userId\` text NOT NULL, \`name\` text NOT NULL, \`keyHash\` text NOT NULL, \`prefix\` text NOT NULL, \`lastUsedAt\` integer, \`createdAt\` integer NOT NULL, \`expiresAt\` integer, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_api_keys_keyHash\` ON \`api_keys\` (\`keyHash\`)`,
    `CREATE INDEX IF NOT EXISTS \`idx_api_keys_userId\` ON \`api_keys\` (\`userId\`)`,
    `CREATE TABLE IF NOT EXISTS \`public_reports\` (\`id\` text PRIMARY KEY NOT NULL, \`linkId\` text NOT NULL, \`token\` text NOT NULL, \`isEnabled\` integer NOT NULL DEFAULT 1, \`createdAt\` integer NOT NULL, FOREIGN KEY (\`linkId\`) REFERENCES \`links\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_public_reports_token\` ON \`public_reports\` (\`token\`)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_public_reports_linkId\` ON \`public_reports\` (\`linkId\`)`,
  ];

  for (const sql of ordered) {
    await env.DB.prepare(sql).run();
  }
});
