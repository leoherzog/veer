import { sqliteTable, text, integer, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";

// Better Auth tables
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  role: text("role").default("user"),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("session_token_idx").on(table.token),
]);

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("account_userId_idx").on(table.userId),
]);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

export const passkey = sqliteTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("publicKey").notNull(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credentialID").notNull(),
  counter: integer("counter").notNull().default(0),
  deviceType: text("deviceType").notNull(),
  backedUp: integer("backedUp", { mode: "boolean" }).notNull().default(false),
  transports: text("transports"),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  aaguid: text("aaguid"),
}, (table) => [
  uniqueIndex("passkey_credentialID_idx").on(table.credentialID),
  index("passkey_userId_idx").on(table.userId),
]);

// Application tables
export const domainConfig = sqliteTable("domain_config", {
  hostname: text("hostname").primaryKey(),
  rootRedirect: text("rootRedirect"),
  notFoundRedirect: text("notFoundRedirect"),
  accessMode: text("accessMode").notNull().default("all"),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const domainAccess = sqliteTable("domain_access", {
  hostname: text("hostname").notNull().references(() => domainConfig.hostname, { onDelete: "cascade" }),
  email: text("email").notNull(),
}, (table) => [
  primaryKey({ columns: [table.hostname, table.email] }),
]);

export const links = sqliteTable("links", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  destinationUrl: text("destinationUrl").notNull(),
  redirectType: integer("redirectType").notNull().default(302),
  title: text("title"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  isActive: integer("isActive", { mode: "boolean" }).notNull().default(true),
  expiresAt: integer("expiresAt", { mode: "timestamp" }),
  maxClicks: integer("maxClicks"),
  password: text("password"),
  isInternal: integer("isInternal", { mode: "boolean" }).notNull().default(false),
  ogTitle: text("ogTitle"),
  ogDescription: text("ogDescription"),
  ogImage: text("ogImage"),
  paramForwarding: integer("paramForwarding", { mode: "boolean" }).notNull().default(false),
  domainHostname: text("domainHostname").references(() => domainConfig.hostname, { onDelete: "set null" }),
}, (table) => [
  // NOTE: A partial unique index "idx_links_slug_default" WHERE domainHostname IS NULL
  // also exists (in migration 0004) to enforce slug uniqueness on the default domain.
  // Drizzle ORM does not support partial indexes declaratively.
  uniqueIndex("idx_links_slug_domain").on(table.slug, table.domainHostname),
  index("idx_links_userId").on(table.userId),
  index("idx_links_domainHostname").on(table.domainHostname),
]);

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_campaigns_userId").on(table.userId),
]);

export const linkCampaigns = sqliteTable("link_campaigns", {
  linkId: text("linkId").notNull().references(() => links.id, { onDelete: "cascade" }),
  campaignId: text("campaignId").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.linkId, table.campaignId] }),
  index("idx_link_campaigns_campaignId").on(table.campaignId),
]);

export const linkTargets = sqliteTable("link_targets", {
  id: text("id").primaryKey(),
  linkId: text("linkId").notNull().references(() => links.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // "geo" | "device" — CHECK constraint enforced at DB level (0002 migration) + app validation
  matchValue: text("matchValue").notNull(),
  destinationUrl: text("destinationUrl").notNull(),
  priority: integer("priority").notNull().default(0),
}, (table) => [
  index("idx_link_targets_linkId").on(table.linkId),
]);

export const linkStats = sqliteTable("link_stats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  linkId: text("linkId").notNull().references(() => links.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  clicks: integer("clicks").notNull().default(0),
  uniqueClicks: integer("uniqueClicks").notNull().default(0),
}, (table) => [
  uniqueIndex("idx_link_stats_linkId_date").on(table.linkId, table.date),
]);
