import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Individual migration statements from drizzle/migrations/0000_initial.sql
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS \`account\` (\`id\` text PRIMARY KEY NOT NULL, \`accountId\` text NOT NULL, \`providerId\` text NOT NULL, \`userId\` text NOT NULL, \`accessToken\` text, \`refreshToken\` text, \`idToken\` text, \`accessTokenExpiresAt\` integer, \`refreshTokenExpiresAt\` integer, \`scope\` text, \`password\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE INDEX IF NOT EXISTS \`account_userId_idx\` ON \`account\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`link_stats\` (\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL, \`linkId\` text NOT NULL, \`date\` text NOT NULL, \`clicks\` integer DEFAULT 0 NOT NULL, \`uniqueClicks\` integer DEFAULT 0 NOT NULL, FOREIGN KEY (\`linkId\`) REFERENCES \`links\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_link_stats_linkId_date\` ON \`link_stats\` (\`linkId\`,\`date\`)`,
  `CREATE TABLE IF NOT EXISTS \`links\` (\`id\` text PRIMARY KEY NOT NULL, \`userId\` text NOT NULL, \`slug\` text NOT NULL, \`destinationUrl\` text NOT NULL, \`redirectType\` integer DEFAULT 302 NOT NULL, \`title\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, \`isActive\` integer DEFAULT true NOT NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`idx_links_slug\` ON \`links\` (\`slug\`)`,
  `CREATE INDEX IF NOT EXISTS \`idx_links_userId\` ON \`links\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`passkey\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text, \`publicKey\` text NOT NULL, \`userId\` text NOT NULL, \`credentialID\` text NOT NULL, \`counter\` integer DEFAULT 0 NOT NULL, \`deviceType\` text NOT NULL, \`backedUp\` integer DEFAULT false NOT NULL, \`transports\` text, \`createdAt\` integer, \`aaguid\` text, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`passkey_credentialID_idx\` ON \`passkey\` (\`credentialID\`)`,
  `CREATE INDEX IF NOT EXISTS \`passkey_userId_idx\` ON \`passkey\` (\`userId\`)`,
  `CREATE TABLE IF NOT EXISTS \`session\` (\`id\` text PRIMARY KEY NOT NULL, \`expiresAt\` integer NOT NULL, \`token\` text NOT NULL, \`ipAddress\` text, \`userAgent\` text, \`userId\` text NOT NULL, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, FOREIGN KEY (\`userId\`) REFERENCES \`user\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`session_token_idx\` ON \`session\` (\`token\`)`,
  `CREATE TABLE IF NOT EXISTS \`user\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL, \`email\` text NOT NULL, \`emailVerified\` integer DEFAULT false NOT NULL, \`image\` text, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, \`role\` text DEFAULT 'user')`,
  `CREATE TABLE IF NOT EXISTS \`verification\` (\`id\` text PRIMARY KEY NOT NULL, \`identifier\` text NOT NULL, \`value\` text NOT NULL, \`expiresAt\` integer NOT NULL, \`createdAt\` integer, \`updatedAt\` integer)`,
];

beforeAll(async () => {
  // Must create user table first (FK references), then links (FK from link_stats)
  // Reorder: user -> session -> account -> verification -> passkey -> links -> link_stats
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
    STATEMENTS[4],  // links
    STATEMENTS[5],  // idx_links_slug
    STATEMENTS[6],  // idx_links_userId
    STATEMENTS[2],  // link_stats
    STATEMENTS[3],  // idx_link_stats_linkId_date
  ];

  for (const sql of ordered) {
    await env.DB.prepare(sql).run();
  }
});
