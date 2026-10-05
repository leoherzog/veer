import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../../src/index";
import { setupAuth, mockExecutionCtx, createTestLink, createTestDomain, insertClickStat, cachedRedirect, cfRequest } from "../helpers";
import { hashPassword } from "../../src/services/password";
import { setCachedRedirect } from "../../src/services/kv-cache";

const now = Math.floor(Date.now() / 1000);

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

/** Submit the password gate form for `slug`, omitting the field when `password` is undefined. */
function postPassword(slug: string, password?: string) {
  return app.request(`/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(password === undefined ? {} : { password }).toString(),
  }, env, mockExecutionCtx());
}

// ─────────────────────────────────────────────────────────────────────────────

let owner: Awaited<ReturnType<typeof setupAuth>>;

beforeAll(async () => {
  owner = await setupAuth();
});

describe("Redirect engine – advanced", () => {
  // ── handleRedirectPost (password gate POST) ────────────────────────────

  describe("handleRedirectPost – password gate", () => {
    const PASSWORD = "s3cret!";
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await hashPassword(PASSWORD);
      await createTestLink({
        slug: "pw-post",
        destinationUrl: "https://example.com/pw-dest",
        password: passwordHash,
        userId: owner.user.id,
      });
      await createTestLink({
        slug: "no-pw-post",
        destinationUrl: "https://example.com/nopw",
        userId: owner.user.id,
      });
    });

    it("POST with correct password redirects to destination", async () => {
      const res = await postPassword("pw-post", PASSWORD);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/pw-dest");
    });

    it("POST with wrong password shows error page", async () => {
      const res = await postPassword("pw-post", "wrong");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Incorrect password");
    });

    it("POST with empty password shows error page", async () => {
      const res = await postPassword("pw-post", "");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Please enter a password");
    });

    it("POST with missing password field shows error page", async () => {
      const res = await postPassword("pw-post");

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Please enter a password");
    });

    it("POST for non-password link returns 405", async () => {
      const res = await postPassword("no-pw-post", "whatever");

      expect(res.status).toBe(405);
    });

    it("POST re-checks constraints (expired link)", async () => {
      const pastTs = now - 3600; // 1 hour ago
      await createTestLink({
        slug: "pw-expired-post",
        destinationUrl: "https://example.com/expired",
        password: passwordHash,
        expiresAt: pastTs,
        userId: owner.user.id,
      });

      const res = await postPassword("pw-expired-post", PASSWORD);

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("expired");
    });

    it("POST re-checks constraints (maxClicks exceeded)", async () => {
      const { id: linkId } = await createTestLink({
        slug: "pw-maxclicks-post",
        destinationUrl: "https://example.com/maxed",
        password: passwordHash,
        maxClicks: 5,
        userId: owner.user.id,
      });
      await insertClickStat(linkId, 5, "2026-03-20");

      const res = await postPassword("pw-maxclicks-post", PASSWORD);

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("no longer available");
    });
  });

  // ── checkConstraints ───────────────────────────────────────────────────

  describe("checkConstraints – expired / maxClicks / internal", () => {
    it("GET with expiresAt in the past returns 410", async () => {
      const pastTs = now - 7200;
      await createTestLink({
        slug: "expired-link",
        destinationUrl: "https://example.com/expired",
        expiresAt: pastTs,
        userId: owner.user.id,
      });

      const res = await app.request("/expired-link", {}, env, mockExecutionCtx());

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("expired");
    });

    it("GET with maxClicks exceeded returns 410", async () => {
      const { id: linkId } = await createTestLink({
        slug: "maxclicks-link",
        destinationUrl: "https://example.com/maxed",
        maxClicks: 10,
        userId: owner.user.id,
      });
      await insertClickStat(linkId, 7, "2026-03-20");
      await insertClickStat(linkId, 5, "2026-03-21");

      const res = await app.request("/maxclicks-link", {}, env, mockExecutionCtx());

      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("no longer available");
    });

    it("GET with isInternal and no session returns 403", async () => {
      await createTestLink({
        slug: "internal-link",
        destinationUrl: "https://example.com/internal",
        isInternal: true,
        userId: owner.user.id,
      });

      // No auth cookies — should be forbidden
      const res = await app.request("/internal-link", {}, env, mockExecutionCtx());

      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("requires authentication");
    });

    it("GET with isInternal and valid session redirects normally", async () => {
      await createTestLink({
        slug: "internal-authed",
        destinationUrl: "https://example.com/internal-ok",
        isInternal: true,
        userId: owner.user.id,
      });

      const res = await app.request("/internal-authed", {
        headers: { Cookie: owner.headers.Cookie },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/internal-ok");
    });
  });

  // ── bot / OG meta page ─────────────────────────────────────────────────

  describe("Bot OG meta page", () => {
    beforeAll(async () => {
      await createTestLink({
        slug: "og-link",
        destinationUrl: "https://example.com/og-dest",
        ogTitle: "My Link Title",
        ogDescription: "A description for social previews",
        ogImage: "https://example.com/og-image.png",
        userId: owner.user.id,
      });
      await createTestLink({
        slug: "og-pw-link",
        destinationUrl: "https://example.com/og-pw-dest",
        ogTitle: "Protected Link",
        ogDescription: "OG for a password link",
        ogImage: "https://example.com/og-pw.png",
        password: await hashPassword("test"),
        userId: owner.user.id,
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
      expect(html).toContain('<meta http-equiv="refresh" content="0;url=https://example.com/og-dest">');
    });

    it("normal UA with OG data redirects normally", async () => {
      const res = await app.request("/og-link", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/og-dest");
    });

    it("bot UA on password-protected link serves og:* tags but never the destination", async () => {
      const res = await app.request("/og-pw-link", {
        headers: { "User-Agent": "Twitterbot/1.0" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta property="og:title" content="Protected Link">');
      // The password gate is skipped for crawlers…
      expect(html).not.toContain("Enter password");
      // …but the destination must not leak through the meta refresh.
      expect(html).not.toContain("https://example.com/og-pw-dest");
      expect(html).not.toContain("http-equiv=\"refresh\"");
      // og:url still points at the short link.
      expect(html).toContain('<meta property="og:url" content="http://localhost/og-pw-link">');
    });
  });

  // ── handleCustomDomainRoot ─────────────────────────────────────────────

  describe("handleCustomDomainRoot", () => {
    beforeAll(async () => {
      await createTestDomain("custom-root.example.com", {
        rootRedirect: "https://example.com/root-dest",
      });
      await createTestDomain("custom-noroot.example.com", {
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

      // Falls through to the SPA wildcard handler, which serves the built
      // index.html via the ASSETS binding (200 text/html) — not a redirect.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("GET / with custom domain that has no domain_config record falls through", async () => {
      const res = await app.request("/", {
        headers: { Host: "unknown-domain.example.com" },
      }, env, mockExecutionCtx());

      expect(res.headers.get("Location")).toBeNull();
    });

    it("GET / with primary domain falls through (200 SPA)", async () => {
      const res = await app.request("/", {
        headers: { Host: "localhost" },
      }, env, mockExecutionCtx());

      // Falls through to the SPA wildcard handler, which serves the built
      // index.html via the ASSETS binding (200 text/html) — not a redirect.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });
  });

  // ── custom domain notFoundRedirect ─────────────────────────────────────

  describe("Custom domain notFoundRedirect", () => {
    beforeAll(async () => {
      await createTestDomain("custom-nf.example.com", {
        notFoundRedirect: "https://example.com/not-found-page",
      });
      await createTestDomain("custom-nonf.example.com", {
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

    it("GET /login on a custom domain takes notFoundRedirect like any unknown slug", async () => {
      const res = await app.request("/login", {
        headers: { Host: "custom-nf.example.com" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/not-found-page");
    });

    it("GET /login on the primary host serves the SPA", async () => {
      const res = await app.request("/login", {
        headers: { Host: "localhost" },
      }, env, mockExecutionCtx());

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("GET /nonexistent with no notFoundRedirect falls through", async () => {
      const res = await app.request("/nonexistent-slug-nonf", {
        headers: { Host: "custom-nonf.example.com" },
      }, env, mockExecutionCtx());

      expect(res.headers.get("Location")).toBeNull();
    });
  });

  // ── isHttpUrl defense-in-depth: protocol smuggling ─────────────────────
  //
  // rootRedirect and notFoundRedirect are editable by domain admins; we must
  // never honor javascript:, data:, or malformed URLs — even if the row in
  // domain_config somehow contains one.

  describe("isHttpUrl — domain_config values", () => {
    it.each([
      ["hostile-root.example.com", { rootRedirect: "javascript:alert(1)" }, "/"],
      ["hostile-data.example.com", { rootRedirect: "data:text/html,<script>alert(1)</script>" }, "/"],
      ["hostile-nf.example.com", { notFoundRedirect: "not a real url at all" }, "/some-missing-slug"],
      ["hostile-nf-js.example.com", { notFoundRedirect: "javascript:alert('xss')" }, "/also-missing"],
    ])("ignores an unsafe redirect on %s", async (hostname, config, path) => {
      await createTestDomain(hostname, config);

      const res = await app.request(path, { headers: { Host: hostname } }, env, mockExecutionCtx());

      expect(res.headers.get("Location")).toBeNull();
    });
  });

  // ── domain-scoped slug lookup ──────────────────────────────────────────

  describe("Domain-scoped slug lookup", () => {
    beforeAll(async () => {
      await createTestDomain("scope.example.com");
      // Same slug on custom domain → different destination
      await createTestLink({
        slug: "shared-slug",
        destinationUrl: "https://example.com/custom-domain-dest",
        domainHostname: "scope.example.com",
        userId: owner.user.id,
      });
      // Same slug on default domain (domainHostname NULL)
      await createTestLink({
        slug: "shared-slug",
        destinationUrl: "https://example.com/default-domain-dest",
        domainHostname: null,
        userId: owner.user.id,
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
      await createTestDomain("other.example.com");

      const res = await app.request("/shared-slug", {
        headers: { Host: "other.example.com" },
      }, env, mockExecutionCtx());

      // Should not redirect — slug doesn't exist on other.example.com
      expect(res.headers.get("Location")).toBeNull();
    });
  });

  // ── D1-path targeting resolution ───────────────────────────────────────

  describe("D1-path targeting resolution", () => {
    it("geo targeting: request with matching country redirects to target URL", async () => {
      const { id: linkId } = await createTestLink({
        slug: "geo-target",
        destinationUrl: "https://example.com/default-geo",
        userId: owner.user.id,
      });
      await insertTarget(env.DB, {
        linkId,
        type: "geo",
        matchValue: "DE",
        destinationUrl: "https://example.com/germany",
        priority: 10,
      });

      const res = await app.fetch(cfRequest("/geo-target", { cf: { country: "DE" } }), env, mockExecutionCtx());

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/germany");
    });

    it("device targeting: mobile UA redirects to mobile target URL", async () => {
      const { id: linkId } = await createTestLink({
        slug: "device-target",
        destinationUrl: "https://example.com/default-device",
        userId: owner.user.id,
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

describe("Redirect engine – password gate GET", () => {
  it("D1 path: serves the form with no Location header", async () => {
    await createTestLink({
      slug: "pw-gate-d1",
      destinationUrl: "https://example.com/pw-gate-d1-dest",
      password: await hashPassword("hunter2"),
      userId: owner.user.id,
    });

    const res = await app.request("/pw-gate-d1", {}, env, mockExecutionCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This link is password protected");
    expect(html).toContain('<form method="POST" action="/pw-gate-d1">');
    expect(html).not.toContain("https://example.com/pw-gate-d1-dest");
  });

  it("gate CSP omits form-action so Chrome allows the redirect the POST returns", async () => {
    const res = await app.request("/pw-gate-d1", {}, env, mockExecutionCtx());

    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("form-action");
    expect(csp).not.toContain("example.com");
  });

  it("KV-cached path: serves the form with no Location header", async () => {
    await setCachedRedirect(env.KV, "pw-gate-kv", cachedRedirect({
      url: "https://example.com/pw-gate-kv-dest",
      linkId: "pw-gate-kv-link",
      hasPassword: true,
    }));

    const res = await app.request("/pw-gate-kv", {}, env, mockExecutionCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This link is password protected");
    expect(html).not.toContain("https://example.com/pw-gate-kv-dest");
  });
});

describe("Redirect engine – password POST rate limit", () => {
  it("returns 429 on the sixth attempt in a window", async () => {
    await createTestLink({
      slug: "pw-brute",
      destinationUrl: "https://example.com/pw-brute-dest",
      password: await hashPassword("correct-horse"),
      userId: owner.user.id,
    });

    const attempt = async (password: string) => {
      const ctx = createExecutionContext();
      const res = await app.request("/pw-brute", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.7" },
        body: new URLSearchParams({ password }).toString(),
      }, env, ctx);
      // The counter is written in waitUntil; await it so attempts are ordered.
      await waitOnExecutionContext(ctx);
      return res;
    };

    for (let i = 0; i < 5; i++) {
      const res = await attempt("wrong");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Incorrect password");
    }

    const sixth = await attempt("wrong");
    expect(sixth.status).toBe(429);
    expect(await sixth.text()).toContain("Too many attempts");
  });
});
