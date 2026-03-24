import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import app from "../../src/index";
import { setupAuth, mockExecutionCtx } from "../helpers";
import { hashPassword } from "../../src/services/password";

const now = Math.floor(Date.now() / 1000);

/** Insert a link with all fields directly into D1. */
async function insertLink(
  db: D1Database,
  opts: {
    id?: string;
    userId: string;
    slug: string;
    destinationUrl: string;
    redirectType?: number;
    isActive?: boolean;
    expiresAt?: number | null;
    maxClicks?: number | null;
    password?: string | null;
    isInternal?: boolean;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImage?: string | null;
    paramForwarding?: boolean;
    domainHostname?: string | null;
  }
) {
  const id = opts.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO links (id, userId, slug, destinationUrl, redirectType, createdAt, updatedAt, isActive, expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage, paramForwarding, domainHostname)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.userId,
      opts.slug,
      opts.destinationUrl,
      opts.redirectType ?? 302,
      now,
      now,
      opts.isActive !== false ? 1 : 0,
      opts.expiresAt ?? null,
      opts.maxClicks ?? null,
      opts.password ?? null,
      opts.isInternal ? 1 : 0,
      opts.ogTitle ?? null,
      opts.ogDescription ?? null,
      opts.ogImage ?? null,
      opts.paramForwarding ? 1 : 0,
      opts.domainHostname ?? null
    )
    .run();
  return id;
}

/** Insert a domain_config row. */
async function insertDomain(
  db: D1Database,
  opts: { hostname: string; rootRedirect?: string | null; notFoundRedirect?: string | null }
) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO domain_config (hostname, rootRedirect, notFoundRedirect, accessMode, updatedAt)
       VALUES (?, ?, ?, 'all', ?)`
    )
    .bind(opts.hostname, opts.rootRedirect ?? null, opts.notFoundRedirect ?? null, now)
    .run();
}

/** Insert a link_targets row. */
async function insertTarget(
  db: D1Database,
  opts: { linkId: string; type: string; matchValue: string; destinationUrl: string; priority?: number }
) {
  await db
    .prepare(
      `INSERT INTO link_targets (id, linkId, type, matchValue, destinationUrl, priority)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), opts.linkId, opts.type, opts.matchValue, opts.destinationUrl, opts.priority ?? 0)
    .run();
}

/** Insert a link_stats row. */
async function insertStats(db: D1Database, linkId: string, date: string, clicks: number) {
  await db
    .prepare(
      `INSERT INTO link_stats (linkId, date, clicks, uniqueClicks) VALUES (?, ?, ?, 0)`
    )
    .bind(linkId, date, clicks)
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Redirect engine – advanced", () => {
  let auth: Awaited<ReturnType<typeof setupAuth>>;

  beforeAll(async () => {
    auth = await setupAuth(env);
  });

  // ── Task 2: handleRedirectPost (password gate POST) ────────────────────

  describe("handleRedirectPost – password gate", () => {
    const PASSWORD = "s3cret!";
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await hashPassword(PASSWORD);
      await insertLink(env.DB, {
        slug: "pw-post",
        destinationUrl: "https://example.com/pw-dest",
        password: passwordHash,
        userId: auth.user.id,
      });
      await insertLink(env.DB, {
        slug: "no-pw-post",
        destinationUrl: "https://example.com/nopw",
        userId: auth.user.id,
      });
    });

    it("POST with correct password redirects to destination", async () => {
      const body = new URLSearchParams({ password: PASSWORD });
      const res = await app.request("/pw-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/pw-dest");
    });

    it("POST with wrong password shows error page", async () => {
      const body = new URLSearchParams({ password: "wrong" });
      const res = await app.request("/pw-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Incorrect password");
    });

    it("POST with empty password shows error page", async () => {
      const body = new URLSearchParams({ password: "" });
      const res = await app.request("/pw-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Please enter a password");
    });

    it("POST with missing password field shows error page", async () => {
      const res = await app.request("/pw-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Please enter a password");
    });

    it("POST for non-password link returns 405", async () => {
      const body = new URLSearchParams({ password: "whatever" });
      const res = await app.request("/no-pw-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, env, mockExecutionCtx());

      expect(res.status).toBe(405);
    });

    it("POST re-checks constraints (expired link)", async () => {
      const pastTs = now - 3600; // 1 hour ago
      await insertLink(env.DB, {
        slug: "pw-expired-post",
        destinationUrl: "https://example.com/expired",
        password: passwordHash,
        expiresAt: pastTs,
        userId: auth.user.id,
      });

      const body = new URLSearchParams({ password: PASSWORD });
      const res = await app.request("/pw-expired-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, env, mockExecutionCtx());

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("expired");
    });

    it("POST re-checks constraints (maxClicks exceeded)", async () => {
      const linkId = await insertLink(env.DB, {
        slug: "pw-maxclicks-post",
        destinationUrl: "https://example.com/maxed",
        password: passwordHash,
        maxClicks: 5,
        userId: auth.user.id,
      });
      await insertStats(env.DB, linkId, "2026-03-20", 5);

      const body = new URLSearchParams({ password: PASSWORD });
      const res = await app.request("/pw-maxclicks-post", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, env, mockExecutionCtx());

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("no longer available");
    });
  });

  // ── Task 5: checkConstraints ───────────────────────────────────────────

  describe("checkConstraints – expired / maxClicks / internal", () => {
    it("GET with expiresAt in the past returns 410", async () => {
      const pastTs = now - 7200;
      await insertLink(env.DB, {
        slug: "expired-link",
        destinationUrl: "https://example.com/expired",
        expiresAt: pastTs,
        userId: auth.user.id,
      });

      const res = await app.request("/expired-link", {}, env, mockExecutionCtx());

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("expired");
    });

    it("GET with maxClicks exceeded returns 410", async () => {
      const linkId = await insertLink(env.DB, {
        slug: "maxclicks-link",
        destinationUrl: "https://example.com/maxed",
        maxClicks: 10,
        userId: auth.user.id,
      });
      await insertStats(env.DB, linkId, "2026-03-20", 7);
      await insertStats(env.DB, linkId, "2026-03-21", 5);

      const res = await app.request("/maxclicks-link", {}, env, mockExecutionCtx());

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("no longer available");
    });

    it("GET with isInternal and no session returns 403", async () => {
      await insertLink(env.DB, {
        slug: "internal-link",
        destinationUrl: "https://example.com/internal",
        isInternal: true,
        userId: auth.user.id,
      });

      // No auth cookies — should be forbidden
      const res = await app.request("/internal-link", {}, env, mockExecutionCtx());

      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("requires authentication");
    });

    it("GET with isInternal and valid session redirects normally", async () => {
      await insertLink(env.DB, {
        slug: "internal-authed",
        destinationUrl: "https://example.com/internal-ok",
        isInternal: true,
        userId: auth.user.id,
      });

      const res = await app.request("/internal-authed", {
        headers: { Cookie: auth.headers.Cookie },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/internal-ok");
    });
  });

  // ── Task 6: bot / OG meta page ────────────────────────────────────────

  describe("Bot OG meta page", () => {
    beforeAll(async () => {
      await insertLink(env.DB, {
        slug: "og-link",
        destinationUrl: "https://example.com/og-dest",
        ogTitle: "My Link Title",
        ogDescription: "A description for social previews",
        ogImage: "https://example.com/og-image.png",
        userId: auth.user.id,
      });
      await insertLink(env.DB, {
        slug: "og-pw-link",
        destinationUrl: "https://example.com/og-pw-dest",
        ogTitle: "Protected Link",
        ogDescription: "OG for a password link",
        ogImage: "https://example.com/og-pw.png",
        password: await hashPassword("test"),
        userId: auth.user.id,
      });
    });

    it("bot UA with OG data returns 200 HTML with og:* meta tags", async () => {
      const res = await app.request("/og-link", {
        headers: { "User-Agent": "facebookexternalhit/1.1" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta property="og:title" content="My Link Title">');
      expect(html).toContain('<meta property="og:description" content="A description for social previews">');
      expect(html).toContain('<meta property="og:image" content="https://example.com/og-image.png">');
    });

    it("normal UA with OG data redirects normally", async () => {
      const res = await app.request("/og-link", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/og-dest");
    });

    it("bot UA on password-protected link with OG serves OG HTML (bypasses password gate)", async () => {
      const res = await app.request("/og-pw-link", {
        headers: { "User-Agent": "Twitterbot/1.0" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta property="og:title" content="Protected Link">');
      // Should NOT contain password form
      expect(html).not.toContain("Enter password");
    });
  });

  // ── Task 8: handleCustomDomainRoot ─────────────────────────────────────

  describe("handleCustomDomainRoot", () => {
    beforeAll(async () => {
      await insertDomain(env.DB, {
        hostname: "custom-root.example.com",
        rootRedirect: "https://example.com/root-dest",
      });
      await insertDomain(env.DB, {
        hostname: "custom-noroot.example.com",
        rootRedirect: null,
      });
    });

    it("GET / with custom domain that has rootRedirect returns 302", async () => {
      const res = await app.request("/", {
        headers: { Host: "custom-root.example.com" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/root-dest");
    });

    it("GET / with custom domain with no rootRedirect falls through (200 SPA)", async () => {
      const res = await app.request("/", {
        headers: { Host: "custom-noroot.example.com" },
      }, env, mockExecutionCtx());

      // Falls through to SPA — not a redirect
      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });

    it("GET / with custom domain that has no domain_config record falls through", async () => {
      const res = await app.request("/", {
        headers: { Host: "unknown-domain.example.com" },
      }, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });

    it("GET / with primary domain falls through (200 SPA)", async () => {
      const res = await app.request("/", {
        headers: { Host: "localhost" },
      }, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });
  });

  // ── Task 9: custom domain notFoundRedirect ─────────────────────────────

  describe("Custom domain notFoundRedirect", () => {
    beforeAll(async () => {
      await insertDomain(env.DB, {
        hostname: "custom-nf.example.com",
        notFoundRedirect: "https://example.com/not-found-page",
      });
      await insertDomain(env.DB, {
        hostname: "custom-nonf.example.com",
        notFoundRedirect: null,
      });
    });

    it("GET /nonexistent with notFoundRedirect configured redirects", async () => {
      const res = await app.request("/nonexistent-slug-nf", {
        headers: { Host: "custom-nf.example.com" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/not-found-page");
    });

    it("GET /nonexistent with no notFoundRedirect falls through", async () => {
      const res = await app.request("/nonexistent-slug-nonf", {
        headers: { Host: "custom-nonf.example.com" },
      }, env, mockExecutionCtx());

      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });
  });

  // ── Task 10: domain-scoped slug lookup ─────────────────────────────────

  describe("Domain-scoped slug lookup", () => {
    beforeAll(async () => {
      await insertDomain(env.DB, { hostname: "scope.example.com" });
      // Same slug on custom domain → different destination
      await insertLink(env.DB, {
        slug: "shared-slug",
        destinationUrl: "https://example.com/custom-domain-dest",
        domainHostname: "scope.example.com",
        userId: auth.user.id,
      });
      // Same slug on default domain (domainHostname NULL)
      await insertLink(env.DB, {
        slug: "shared-slug",
        destinationUrl: "https://example.com/default-domain-dest",
        domainHostname: null,
        userId: auth.user.id,
      });
    });

    it("GET /:slug with matching custom domain Host redirects to domain-scoped destination", async () => {
      const res = await app.request("/shared-slug", {
        headers: { Host: "scope.example.com" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/custom-domain-dest");
    });

    it("same slug on default domain redirects to default destination", async () => {
      const res = await app.request("/shared-slug", {
        headers: { Host: "localhost" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/default-domain-dest");
    });

    it("GET /:slug with wrong Host does not find domain-scoped slug", async () => {
      // A slug that only exists on scope.example.com — try from a different custom domain
      await insertDomain(env.DB, { hostname: "other.example.com" });

      const res = await app.request("/shared-slug", {
        headers: { Host: "other.example.com" },
      }, env, mockExecutionCtx());

      // Should not redirect — slug doesn't exist on other.example.com
      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
    });
  });

  // ── Task 22: D1-path targeting resolution ──────────────────────────────

  describe("D1-path targeting resolution", () => {
    it("geo targeting: request with matching country redirects to target URL", async () => {
      const linkId = await insertLink(env.DB, {
        slug: "geo-target",
        destinationUrl: "https://example.com/default-geo",
        userId: auth.user.id,
      });
      await insertTarget(env.DB, {
        linkId,
        type: "geo",
        matchValue: "DE",
        destinationUrl: "https://example.com/germany",
        priority: 10,
      });

      // app.request doesn't natively support cf properties, but the redirect handler
      // reads (c.req.raw as Request & { cf?: ... }).cf?.country.
      // We create a Request with a cf property to simulate this.
      const req = new Request("http://localhost/geo-target");
      Object.defineProperty(req, "cf", { value: { country: "DE" }, writable: false });

      const res = await app.fetch(req, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/germany");
    });

    it("device targeting: mobile UA redirects to mobile target URL", async () => {
      const linkId = await insertLink(env.DB, {
        slug: "device-target",
        destinationUrl: "https://example.com/default-device",
        userId: auth.user.id,
      });
      await insertTarget(env.DB, {
        linkId,
        type: "device",
        matchValue: "mobile",
        destinationUrl: "https://example.com/mobile-page",
        priority: 10,
      });

      const res = await app.request("/device-target", {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/mobile-page");
    });
  });
});
