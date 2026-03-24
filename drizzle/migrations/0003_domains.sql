-- M5: Custom Domains (simplified)
CREATE TABLE "domain_config" (
  "hostname" text PRIMARY KEY NOT NULL,
  "rootRedirect" text,
  "notFoundRedirect" text,
  "accessMode" text NOT NULL DEFAULT 'all',
  "updatedAt" integer NOT NULL
);

CREATE TABLE "domain_access" (
  "hostname" text NOT NULL REFERENCES "domain_config"("hostname") ON DELETE CASCADE,
  "email" text NOT NULL,
  PRIMARY KEY ("hostname", "email")
);

-- Add domainHostname column to links
ALTER TABLE "links" ADD COLUMN "domainHostname" text REFERENCES "domain_config"("hostname") ON DELETE SET NULL;

-- Index for domain-based link lookups
CREATE INDEX "idx_links_domainHostname" ON "links"("domainHostname");

-- Replace slug-only unique index with domain-scoped composite
DROP INDEX IF EXISTS "idx_links_slug";
CREATE UNIQUE INDEX "idx_links_slug_domain" ON "links"("slug", "domainHostname");

-- Partial index to enforce uniqueness for default-domain links (domainHostname IS NULL).
-- SQLite treats each NULL as distinct in composite UNIQUE indexes, so this is required.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_links_slug_default" ON "links" ("slug") WHERE "domainHostname" IS NULL;
