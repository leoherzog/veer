import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

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
}, (table) => [
  uniqueIndex("idx_links_slug").on(table.slug),
  index("idx_links_userId").on(table.userId),
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
