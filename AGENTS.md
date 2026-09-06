# AGENTS.md

This file provides guidance to Claude Code, Gemini, Codex, etc when working with code in this repository.

## Project

Veer is a self-hostable URL shortener that runs entirely on Cloudflare Workers. It is a Hono-based TypeScript Worker plus a vanilla-JS SPA bundled by esbuild, using D1 (SQLite) for persistent data, KV for caches/rate limits, and Analytics Engine for per-click events. There are no hardcoded domains — any hostname can serve the app or act as a branded custom domain.

`FEATURES.md` lists the product surface. The "Design decisions" section at the bottom of this file captures non-obvious rationale behind load-bearing choices.

## Commands

```bash
npm run dev              # concurrently: esbuild --watch + wrangler dev (runs predev: build + local D1 migrate)
npm run build            # wrangler types + esbuild (minified)
npm run build:frontend   # esbuild only
npm run deploy           # build + wrangler deploy
npm run typecheck        # wrangler types + tsc --noEmit
npm test                 # vitest run (workerd pool)
npm run test:watch       # vitest in watch mode
npm run db:generate      # drizzle-kit generate (create a new migration from schema.ts)
npm run db:migrate:local # apply drizzle/migrations to the local D1
npm run seed:local       # generate scripts/seed.generated.sql + apply to local D1 (DEMO_MODE seed)
npm run seed:remote      # same, applied to the remote demo D1 (veer-db-demo, --env demo)
```

Run a single test file or name: `npx vitest run test/integration/links.test.ts` / `npx vitest run -t "creates link"`.

Tests run against a real workerd instance via `@cloudflare/vitest-pool-workers`. `vitest.config.ts` reads `drizzle/migrations/` with `readD1Migrations()` and passes them through the `TEST_MIGRATIONS` binding; `test/setup.ts` applies them to the test D1 in a `beforeAll`. The suite therefore enforces the same indexes, CHECKs and defaults a real deployment gets, and a new migration needs no test-side change.

The pool loads the developer's `.dev.vars`, so `vitest.config.ts` pins every var the app reads: `PASSKEY_ENABLED` to `"false"`, and `DEMO_MODE`, `INSTANCE_NAME`, `ADMIN_EMAILS` plus every `*_CLIENT_ID`/`*_CLIENT_SECRET` to empty values. Tests that need one supply it per-request with `{ ...env, DEMO_MODE: "true" }`.

`.dev.vars` holds secrets for `wrangler dev`; see `.dev.vars.example` for the required keys (Better Auth secret/URL, admin emails, `CF_ACCOUNT_ID` + `CF_API_TOKEN` for Analytics Engine reads, and at least one OAuth provider pair).

## Architecture

### Request flow (`src/index.ts`)
A single Hono app wires every route. Order matters:

1. Global error handler returns JSON without leaking internals.
2. Security headers + CSP applied to every response.
3. `trimTrailingSlash({ alwaysRedirect: true })` 301s `/foo/` to `/foo` so each path has one canonical URL. `alwaysRedirect` is required: the catch-all serves the SPA with a 200, so the default 404-only mode would never fire.
4. `/api/auth/*` is mounted first and handles its own auth (Better Auth).
5. `/api/*` routes apply `requireAuth` / `requireAuthOrApiKey` + rate-limit middleware. API-key-capable routes (`/api/me`, `/api/links`, `/api/stats`, `/api/campaigns`, `/api/bulk`, `/api/reports`) sandwich the auth middleware between `rateLimitApiKeyCheck` and `rateLimitApiKeyIncrement`. `rateLimitApiKeyCheck` is always registered *before* `requireAuthOrApiKey`: it keys on the bearer prefix alone and needs no user, so an over-limit key costs no HMAC, no D1 join and no `lastUsedAt` write. Session-only routes (`/api/teams`, `/api/admin`, `/api/domains`, `/api/keys`) are authenticated but **not** metered.
6. `/api/public-report/:token` is unauthenticated but IP-rate-limited via KV.
7. `GET /` handles custom-domain root redirects, `GET|POST /:slug` is the redirect engine.
8. Catch-all serves static assets via the `ASSETS` binding, falling back to `index.html` for SPA routes.

The SPA shell is served through `run_worker_first: true` so Worker routes (including `/:slug`) always win over static files.

### Data layer
- `src/db/schema.ts` is the single Drizzle schema — Better Auth tables (`user`, `session`, `account`, `verification`, `passkey`) live alongside product tables (`links`, `link_stats`, `campaigns`, `link_campaigns`, `link_targets`, `domain_config`, `domain_access`, `api_keys`, `public_reports`, `teams`, `team_members`, `team_invites`).
- `getDb(env.DB)` in `src/db/index.ts` returns a cached Drizzle client.
- Migrations are authored with `drizzle-kit generate` and applied by Wrangler (`d1 migrations apply`). Never edit an already-applied migration; create a new one.
- Migrations are numbered sequentially (`0000_initial.sql`, …). Use the next unused number for new migrations.
- **`schema.ts` is the sole source of DDL.** The six pre-1.0 migrations were squashed into `0000_initial.sql` before the first tag, because 0001–0005 had been hand-written: their `meta/` snapshots were missing, `0005` was never added to `_journal.json`, and `db:generate` consequently diffed against the `0000` snapshot and could not emit a correct migration. Everything the hand-written SQL carried — the partial unique index and all three CHECK constraints — is now declared in `schema.ts` (drizzle 0.45 supports both `check()` and `.where()` on indexes, contrary to a stale comment that used to sit in this file). Never hand-write DDL into a migration again; if `schema.ts` can't express it, that's the bug to fix.
- Slug uniqueness is domain-scoped: same slug can exist on different domains. Enforced by a composite unique index `(slug, domainHostname)` **plus** a partial unique index `idx_links_slug_default WHERE domainHostname IS NULL` (SQLite treats NULLs as distinct in composite indexes, so the partial index is load-bearing). Any manual uniqueness check must mirror both.

### Auth (`src/auth/index.ts`)
Better Auth is instantiated per-`Env` and memoized in a `WeakMap`. Social providers are read from env vars by `src/lib/providers.ts` — only providers with both `*_CLIENT_ID` and `*_CLIENT_SECRET` present are enabled. The passkey plugin is gated on `PASSKEY_ENABLED=true`. A `databaseHooks.user.delete.after` hook calls `cleanupOrphanedTeams` to promote/delete teams after user deletion.

`src/middleware/auth.ts` exposes `requireAuth`, `requireAdmin`, and `requireAuthOrApiKey`. The authenticated user (with `isAdmin` derived from `ADMIN_EMAILS`) is placed on `c.var.user` — typed via `AppEnv` in `src/types.ts`.

**Admin model**: admin status comes from the `ADMIN_EMAILS` env var (comma-separated), computed inside `requireAuth`. There is no `role` column in the DB. `requireAdmin` guards admin-only routes (domain sync/config/access, admin user management).

**API keys**: `veer_` prefix + 43 base62 chars (~256 bits), hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, max 10 per user. Key management (`/api/keys`, passkey registration, team CRUD for your own account) plus `/api/domains` and `/api/admin` use `requireAuth` (session-only), **not** `requireAuthOrApiKey` — you cannot manage API keys, domains, teams or admin state via an API key (prevents key escalation). `GET /api/me` is `requireAuthOrApiKey` so an API client has a whoami.

`AuthUser` in `src/types.ts` is the enforced shape of `c.var.user` for session auth as well as API-key auth. Build it field by field; never spread the Better Auth user into it.

**Rate limits** (all advisory — KV lacks atomic increment):
- 60 req/min per API key on `requireAuthOrApiKey` routes via `rateLimitApiKeyCheck` (before auth) + `rateLimitApiKeyIncrement` (after auth). Session requests bypass both.
- Session-only routes (`/api/teams`, `/api/admin`, `/api/domains`, `/api/keys`) are **not** rate limited — see the design decision below.
- 30 req/min IP-based on `/api/public-report/:token` (inline in `index.ts` via `checkRateLimit`).
- 5 password attempts per 15 min per link+IP on both gate surfaces: `POST /api/links/:id/check-password` and the no-JS HTML form on `POST /:slug`. Both share the `rl:pw:{linkId}:{ip}:{window}` KV key, so attempts across the two count together.
- Public endpoints accepting user input use KV keys of the form `rl:{type}:…:{windowEpoch}` (e.g. `rl:pw:{linkId}:{ip}:{window}`, `rl:pub:{ip}:{window}`) with `expirationTtl` for auto-cleanup.

### Redirect engine (`src/routes/redirect.ts`)
The hot path: slug lookup, password/expiry/max-click gates, optional campaign/A-B target resolution, click write to Analytics Engine, daily aggregate upsert to `link_stats`, then 301/302. Uses `src/services/kv-cache.ts` to avoid D1 reads on every request and falls through to the SPA for unknown slugs.

**KV keys are domain-scoped**: `{hostname}:{slug}` for custom domains, bare `{slug}` for the primary host (derived from `BETTER_AUTH_URL`). Every get/set/delete in `kv-cache.ts` takes an optional hostname — always pass it for custom-domain links or you will read/write the wrong key.

**Hot-path invariants**:
- `AnalyticsEngineDataset.writeDataPoint()` is **synchronous** — do NOT wrap in `waitUntil`.
- D1 writes on the redirect path (the daily `link_stats` upsert via `upsertDailyStats()`) MUST use `c.executionCtx.waitUntil()` to keep latency off the response.
- Bot/OG-meta detection runs **before** the password gate so social previews work on protected links. A protected link's crawler page carries the `og:*` tags and `og:url` (the short URL) but no meta refresh, so the destination never leaves the server unauthenticated.
- `isSafeRedirectUrl()` validates `rootRedirect` / `notFoundRedirect` before `c.redirect()` — defense in depth against open redirect via `domain_config`.
- Reserved slugs are checked before any KV or D1 read. On the primary host `handleRedirect`/`handleRedirectPost` return `next()` immediately; on a custom domain a reserved slug takes the same `notFoundRedirect` as any unknown slug. `validateSlug` rejects reserved slugs, so no link can hold one — adding a slug to `RESERVED_SLUGS` after launch black-holes any existing link on it.
- Targeting and param forwarding run only once the request is going to redirect, so a password-gated or bot request never spends an A/B roll.
- 302s carry `Cache-Control: private, no-store` — expiry, `maxClicks`, A/B, geo and password gating all decide the destination per request, so a cached 302 would replay the wrong one. 301s stay cacheable.
- Hono routes HEAD through the GET handler, so click tracking is guarded by `c.req.method === "GET"` and link checkers do not consume `maxClicks`.

### Analytics (`src/services/analytics.ts`)
Dual-storage stats:
- **Writes:** `trackClick()` in `redirect.ts` writes each click twice — to Analytics Engine via the `ANALYTICS` binding (synchronous), and a daily-aggregate D1 upsert to `link_stats` via `upsertDailyStats()` inside `waitUntil`. The AE blob schema is a fixed positional layout documented at the top of `analytics.ts` (index1=linkId, blob1=slug, blob2=country, blob3=user-agent, blob4=referer, blob5=city, blob6=destinationUrl, blob7=region, double1=timestamp). Any reader in `src/routes/api/stats.ts` must stay in sync with this layout.
- **Reads:** Worker-side `fetch()` to the Cloudflare Analytics Engine SQL REST API using `CF_ACCOUNT_ID` + `CF_API_TOKEN` (there is no read binding). AE retains detailed events for ~90 days; `link_stats` holds permanent daily aggregates.

### Frontend (`frontend/src/` → `public/dist/`)
- Entry: `frontend/src/app.js`. Routing is a tiny homegrown router (`router.js`); views are plain functions that take a root `HTMLElement` and render into it. Each navigation creates a fresh `<div>` inside `#main` and hands the view that div, so an async render that finishes late writes into a detached node instead of the live page. A view's root is never `#main` itself — direct-child selectors keyed on `#main` would not match.
- `renderSettings(container, { activeTab })` and `renderTeamDetail` re-render themselves in place, passing the currently open tab back in so a refresh does not snap the user to the first tab.
- The login view renders in place on whatever route required auth, so the OAuth `callbackURL` is the current location. Anything that changes how unauthenticated routes render must leave the URL intact or deep links break.
- `esbuild.mjs` bundles with code-splitting (`format: esm`, `splitting: true`) into `public/dist/`. `public/index.html` is a static SPA shell, not built.
- Web Awesome Free components are imported individually (tree-shaken) from `@awesome.me/webawesome`. Three WA stylesheets are imported ahead of them in `app.js`: `styles/native.css` (resets plus native-element/table styling for light-DOM markup), `styles/themes/awesome.css`, and `styles/utilities.css`. All three live in `@layer wa-*` and `app.css` is unlayered, so project rules always win regardless of import order. Auth client is the bundled `better-auth/client` — **do not** switch to an esm.sh import map; it breaks on the `jose` dependency.
- Charts use Chart.js + `chartjs-chart-geo` + `topojson-client` directly (no WA Pro chart components).
- `frontend/src/auth-client.js` is the only place that talks to Better Auth from the browser.
- **Theme**: `wa-light`/`wa-dark` class on `<html>`, persisted to `localStorage`, initialized from `prefers-color-scheme`. Chart colors are read from `--wa-color-*` custom properties and cached in `lib/chart-helper.js` — never hardcode chart colors. The toggle in `components/nav-bar.js` dispatches `theme-change` on `document`; chart-helper drops the cache and re-colours every tracked chart. A Chart.js instance is only tracked if it goes through `createChart()` or `registerChart()`, so anything built with a bare `new Chart()` keeps the old palette until reload and is never pruned. The convention for chart components: call `destroyCharts(container)` before replacing markup, and assign `container._charts` as instances are created. `createChart` merges `plugins` and `scales` one level deep, so a caller passing its own `options.scales` still gets the themed axis colors.
- The `max-width: 480px` rule in `app.css` that hides a third table column is scoped to `#links-table`, the dashboard container in `views/dashboard.js`. Renaming that id makes the rule hide the third column of every table in the SPA. `BULK_MAX` in `dashboard.js` must likewise track the server-side cap of 50 links per bulk request; neither coupling is enforced by a test.
- `components/link-form.js` saves in two phases and holds state: once the link row exists the form remembers its id, so any further submit is a `PUT`. A failed targets save keeps the dialog open, and `onSuccess` fires only when both phases succeed. `expiresAt` is sent only when it differs from the loaded value, relying on the API treating an absent field as no-change.
- **Shared UI helpers** in `frontend/src/lib/ui.js` — reuse instead of reinventing: `apiFetch(url, opts)` returns parsed JSON or `null` on failure (callers do `if (!result) return;` — toast + 401 redirect are handled once) and resolves a 2xx with no body (204 or empty) to `{}`, so the same idiom works for endpoints that return nothing; `withLoadingBtn(btn, fn)` manages loading state only and does **not** catch errors; plus `shortUrl(link)` (domain-aware), `SPINNER`, `emptyState`, `errorCallout`, `statCard`, `bindConfirmDialog`, `renderTable({ label, columns, rows, tbodyId, style })`, `loadTableSection(el, { url, label, headers, renderRow, empty, error, onPageChange })`, `renderPagination(container, { page, total, limit, onPageChange })`, `setTeamOptions(select, teams, { prefix, selected })`, `bindSearchInput`. Every table in the SPA is built by `renderTable` — it emits the load-bearing `class="link-table"` and the `data-sort` header attributes, so never hand-write a table scaffold. Paginated collections go through `loadTableSection`, which owns the spinner, empty and error states around it. `renderPagination` wraps `wa-pagination` in a `.pagination-row` div because the component is `display: contents`. Other shared modules: `lib/chart-helper.js` (theme-aware Chart.js wrapper: `createChart()`, `themeColors()` — cached until the next theme change and safe inside scriptable Chart.js options — `registerChart(chart)` for instances built with a bare `new Chart()`, and `destroyCharts(el)`), `lib/stats-common.js` (`SKELETON`, `noData`, `fetchJSON`, `statsCard(title, body)`), `lib/escape.js`, `components/toast.js` (`showToast(message, variant, duration)`, backed by a single lazily created `<wa-toast>`).

### Environment & bindings (`wrangler.jsonc`)
`DB` (D1), `KV` (namespaces for cache/rate limit/public-report counters), `ANALYTICS` (Analytics Engine dataset `veer_clicks`), and `ASSETS` (static site) are all required. `compatibility_flags: ["nodejs_compat_v2"]` is required for Better Auth dependencies. The only provisioned environment is `demo`, which has its own D1/KV/AE resources and sets `DEMO_MODE=true`, `INSTANCE_NAME="Veer Demo"`, and a `demo.veer.ing` custom-domain route. The default (top-level) env is an unprovisioned template — its `BETTER_AUTH_URL` is a placeholder and no `veer` Worker, `veer-db` D1, or KV namespace exists yet, so a bare `npm run deploy` would create all of them from scratch. Provision and set a real `BETTER_AUTH_URL` before deploying it.

Anything in `wrangler.jsonc` `vars` is emitted by `wrangler types` as a literal union of the configured values, so it must never be redeclared in `src/env.d.ts`. Only secrets and `.dev.vars`-only keys belong there, always as plain `string`.

Every command aimed at the demo instance takes `--env demo` — `wrangler d1 migrations apply veer-db-demo --remote --env demo`, `npm run seed:remote`, `wrangler deploy --env demo`. Without it Wrangler resolves the top-level template and would create the unprovisioned resources.

### Instance branding (`INSTANCE_NAME`)
`INSTANCE_NAME` is an optional plain `var` in `wrangler.jsonc` (not a secret — it is public branding). When unset or empty it falls back to `"Veer"`. Resolved everywhere via `getInstanceName(env)` in `src/lib/branding.ts` — **never hardcode the brand string.** The frontend reads it from a public `GET /api/config` endpoint (`{ instanceName, demoMode }`) fetched once by `frontend/src/lib/config.js` before the first render; `getInstanceName()` on the client returns the cached value. `public/index.html` ships with an empty `<title>` and is filled in by `loadConfig()`. The passkey `rpName` reads the resolved name at `getAuth()` time — changing `INSTANCE_NAME` after passkey credentials exist only affects new registrations. Shape `/api/config`'s return object so future branding knobs (logo URL, footer text, etc.) slot in without a new endpoint.

### Demo mode (`DEMO_MODE=true`)
Setting `DEMO_MODE=true` (plain `var` in `wrangler.jsonc`) turns the same codebase into a public read-only showcase. Resolved via `isDemoMode(env)` in `src/lib/branding.ts`. Three things change:

1. **Auth is bypassed.** `requireAuth` / `requireAuthOrApiKey` short-circuit via the `tryDemoBypass()` helper and inject the synthetic `DEMO_USER` from `src/lib/demo.ts` (id=`demo-user`, `isAdmin: false`). No session row, no OAuth, no `/login` view. The frontend mirrors this in `app.js`: when `isDemoMode()` is true, it sets a synthetic `currentUser` and skips `authClient.getSession()`.
2. **All non-GET `/api/*` writes return 403** with `{ error, demoMode: true }`. The block is a single middleware in `src/index.ts` placed right after CORS, before any route mount. The only allowlisted write is the password gate, matched by the precise regex `^/api/links/[^/]+/check-password$` — not `endsWith("/check-password")`. `POST /api/auth/*` is intentionally blocked (no login flow in demo). Non-`/api/` writes like `POST /:slug` (password form submit) pass through.
3. **An hourly cron** (`triggers.crons: ["0 * * * *"]`) wakes `src/scheduled.ts`, which early-returns when `DEMO_MODE` is unset (one cheap no-op per hour on non-demo deploys). When demo, it writes 1–5 synthetic AE click events per seeded link and upserts today's `link_stats` row with `uniqueClicks` scaled to 60–85% of `clicks`.

Frontend signals demo mode by adding a `.demo-mode` class to `<body>` plus a `<wa-callout slot="banner" variant="brand" appearance="accent" size="s">` inserted into `wa-page`'s banner slot, which is sticky above the header and reserves its own space (`app.css` only squares off the corners). Top-level create buttons are hidden by CSS selectors keyed on `body.demo-mode`. The impersonation banner is suppressed in demo mode (both render into the same banner slot). The Logout dropdown item is also hidden — it has nothing to log out of.

Seed lives in `scripts/seed.ts`, which writes SQL to stdout; the npm scripts redirect it into `scripts/seed.generated.sql` (gitignored) and apply it via `wrangler d1 execute --file`. Every row uses a stable ID and `INSERT OR REPLACE`, so re-running replaces the fixture set rather than growing it. Fixtures cover the showcase surface: plain, password-gated (password is `demo`), expired, max-clicks-capped, A/B campaign, custom-domain, team-owned. The password hash is computed with the same PBKDF2 params as the runtime, sourced from `src/lib/password-params.ts` so the seed and `src/services/password.ts` can't drift.

### Directory map
```
src/
  index.ts              # Hono app + route wiring (named `app` export for tests)
  scheduled.ts          # Cron handler (demo synthetic clicks; no-op outside demo)
  types.ts              # AppEnv (Hono Bindings/Variables) + AuthUser
  env.d.ts              # Secrets/optional vars not in wrangler.jsonc (merged into Env)
  auth/index.ts         # Better Auth setup
  db/{index,schema}.ts  # Drizzle client + schema
  middleware/           # auth, cors, rate-limit
  routes/
    redirect.ts         # /:slug hot path
    api/                # auth, links, stats, campaigns, domains, keys, bulk, reports, teams, admin
  services/             # analytics, kv-cache, password, slug, useragent
  lib/                  # branding, crypto, date, demo, errors, link-access, password-params, providers, request, team, validators
frontend/src/
  app.js, router.js, auth-client.js
  views/                # one file per SPA screen
  components/           # reusable web components & helpers
  styles/, lib/
public/                 # SPA shell + esbuild output (dist/)
drizzle/migrations/     # numbered SQL migrations (0000_initial.sql, …)
scripts/                # seed.ts (DEMO_MODE seed → seed.generated.sql, gitignored)
test/
  setup.ts              # applies drizzle/migrations to the test D1
  unit/, integration/   # vitest suites
```

## Conventions

### Core
- Never hardcode `veer.ing` or any other hostname in source — everything is driven by `BETTER_AUTH_URL`, `domain_config`, or the request host.
- Never hardcode the brand string `"Veer"` in user-facing UI or server-rendered HTML. Use `getInstanceName(env)` on the server (`src/lib/branding.ts`) and `getInstanceName()` on the client (`frontend/src/lib/config.js`) — both fall back to `"Veer"` when `INSTANCE_NAME` is empty.
- Slugs are user-supplied and required. `src/services/slug.ts` only validates and normalizes; it never generates. **Never store or look up a raw slug** — run it through `validateSlug()` (which returns the canonical form) or `normalizeSlug()` first. `validateTeamSlug()` is the narrower ASCII-only variant for team slugs.
- When adding a table, update `src/db/schema.ts` and generate a migration (`npm run db:generate`). Tests pick it up automatically — `test/setup.ts` applies `drizzle/migrations/`.
- When adding a new AE field, update the blob-index comment in `src/services/analytics.ts` *and* every reader in `src/routes/api/stats.ts`.
- API routes that should be usable by third-party integrations must go behind `rateLimitApiKeyCheck` + `requireAuthOrApiKey` + `rateLimitApiKeyIncrement`, not `requireAuth`.

### Frontend (Web Awesome)
- **Load the `webawesome` skill and verify every `wa-*` element against its docs before shipping.** WA has diverged from Shoelace; memory is unreliable.
- Renames that have already bitten this codebase: `start`/`end` not `prefix`/`suffix`, `with-clear` not `clearable`, `hint` not `help-text`, `brand` not `primary`, unprefixed `input`/`change` events. `wa-select` value goes on the parent (not `selected` on `wa-option`).
- **Style hierarchy** (first available wins): WA utility classes (`wa-stack`, `wa-cluster`, `wa-split`, `wa-grid`, `wa-flank`, `wa-frame`, `wa-gap-*`, `wa-align-items-*`) → semantic tokens (`--wa-color-text-quiet`, `--wa-color-neutral-border-normal`) → custom CSS in `app.css` → inline `style`. **Never** write inline `display:flex`/`gap`/`align-items` when a WA utility exists, and **never** use numeric palette tokens (`--wa-color-neutral-300`).

### Backend (Workers)
- **Verify backend code against the `wrangler` and `workers-best-practices` skills** before considering work complete.
- `AnalyticsEngineDataset.writeDataPoint()` is synchronous — do NOT wrap in `waitUntil`.
- D1 writes in the redirect hot path MUST use `c.executionCtx.waitUntil()`. API handler KV writes use `await` (consistency before response); redirect handler KV writes use `waitUntil`. The one exception is link **create**, which defers via `waitUntil`: there is no prior cache entry to go stale, so the only cost is one extra D1 read on the first redirect, and awaiting it meant a KV failure threw after the D1 row had already committed.
- Never cache secrets in KV — use boolean flags (e.g. `hasPassword`, not the hash).
- Use Drizzle types for update objects: `Partial<typeof table.$inferInsert>`, not `Record<string, ...>`.
- Columns embedded in a raw `sql` fragment render **unqualified** (`"userId"`, not `"links"."userId"`) when the select has a single table. A correlated subquery written as ``sql`(SELECT count(*) FROM ${links} WHERE ${links.userId} = ${userTable.id})` `` therefore compares `links.userId` to `links.id` and silently returns 0. Bind the outer value (`${user.id}`) or qualify the outer column explicitly.
- Route handlers behind auth middleware use `c.var.user!` (the variable is typed as optional because middleware doesn't run on every route).

### Security
- Rate-limit all public endpoints that accept user input.
- Never leak protected data in API responses — password-protected links strip `destinationUrl` to `hasPassword: boolean`.
- HTML-escape all interpolated values in server-generated HTML (password gate, 410 Gone, OG meta pages).
- CSP lives in `src/lib/csp.ts` as one directive array, applied by `setSecurityHeaders()` in `src/index.ts` (which `onError` also calls). Anything added to the policy belongs in that array. `connect-src` includes `https://cdn.jsdelivr.net` because the choropleth fetches world-atlas at runtime. `setSecurityHeaders` applies the global policy only when the handler set none, so the password gate keeps its own `PASSWORD_GATE_CSP`: Chrome enforces `form-action` across a submission's redirect chain, and the gate answers a correct password with a 302 off-origin. Never give the gate a `form-action`.
- Bot/crawler detection serves the OG-meta page **before** the password gate so social previews work on protected links, and omits the meta refresh on a protected link so the destination stays server-side.
- The public report endpoint 404s an internal link, and `POST`/`PUT /api/reports/:linkId` reject one. An internal link's redirect requires a session, so its stats must not be reachable through a shareable token.
- Password hashing: PBKDF2-SHA256 (100k iterations, 16-byte salt) via Web Crypto; verify with `crypto.subtle.timingSafeEqual()`.

### Shared helpers (reuse, don't reinvent)
- Backend `src/lib/`: `branding.ts` (`getInstanceName`, `isDemoMode`), `demo.ts` (`DEMO_USER`, `DEMO_USER_ID`, `DEMO_BLOCKED_MESSAGE`), `password-params.ts` (PBKDF2 constants — shared between `src/services/password.ts` and `scripts/seed.ts`), `validators.ts` (`validateHttpUrl`, `validateDomainAccess`, `getPrimaryHostname`, `resolveDomainHostname`), `link-access.ts` (`canAccessLink` for one link, `accessibleLinks(userId)` for the SQL predicate — owned links plus current team links — never hand-write a second OR/subquery), `team.ts` (`requireTeamMember`), `request.ts` (`parseJsonBody`, `parseOptionalJsonBody`, `parsePagination`, `stripPassword`), `errors.ts` (typed HTTP helpers, `checkBodySize`), `crypto.ts` (`hashApiKey`, `generateApiKey`), `date.ts` (`formatDate`, `formatHour`, `formatWeek`).
- Backend `src/middleware/rate-limit.ts` exports `rateLimitApiKeyCheck`, `rateLimitApiKeyIncrement` and standalone `checkRateLimit()` for non-middleware use.
- `parseDevice` in `src/services/useragent.ts` is the single device classifier, shared by redirect device targeting and the stats device breakdown. Never add a second one.
- Frontend: `lib/ui.js`, `lib/chart-helper.js`, `lib/stats-common.js`, `lib/escape.js` (see the Frontend architecture section above). `lib/config.js` exposes `getInstanceName()` and `isDemoMode()` after `loadConfig()` resolves.

### Tests
- New tests should use shared helpers in `test/helpers.ts`: `createTestLink`, `createTestDomain`, `insertClickStat`, `apiRequest`. Don't inline setup.
- `mockExecutionCtx()` swallows `waitUntil` promises. A test that asserts on a background KV or D1 write must use `trackedExecutionCtx()` and `await settled()` instead, or it races the write.
- `tsconfig.json` sets `"types": ["@cloudflare/vitest-pool-workers/types"]`, which is what makes the `cloudflare:test` module visible to `tsc`.
- `tsconfig.json` typechecks `scripts/**`, and the repo has no Node types. `scripts/seed.ts` therefore uses global `crypto` and writes to stdout with no `node:` import; keep it that way or the typecheck breaks.

## Design decisions

Non-obvious rationale behind load-bearing choices. Read these before "cleaning up" anything here — most of this code looks weird for a reason.

### Auth & API keys
- **Admin from `ADMIN_EMAILS` env var, not a DB column** — lets ops rotate admins by redeploying; avoids a migration + role-column dance. The original `user.role` column was removed from `schema.ts` in M6 as dead schema — though no migration ever dropped it, so it lingered in every real database until the pre-1.0 squash actually removed it.
- **API keys hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, not plain SHA-256** — prevents offline brute-force if D1 is dumped (attacker needs the secret too).
- **Key format `veer_` + 43 base62 chars** — ~256 bits entropy, grep-able prefix for secret scanners.
- **Key management is session-only (`requireAuth`, not `requireAuthOrApiKey`)** — you cannot create or delete API keys using an API key. Blocks privilege escalation via a leaked key.
- **`getAuth()` cached in a `WeakMap` keyed on `env`** — Better Auth is expensive to construct and a single request calls `getAuth()` from multiple middlewares.
- **Better Auth cookie session cache (5 min)** — cuts D1 session lookups for browser traffic. Staleness window is acceptable because logout clears the cookie.
- **Single-provider auto-redirect on login** — when exactly one OAuth provider is configured and passkey is disabled, the login view skips rendering and signs in directly. Removes a pointless click.

### Domains
- **Admin-synced from the Cloudflare API, not user DNS verification** — Cloudflare already knows what's routed to this Worker; a TXT-record dance is redundant. Significant simplification over the original plan.
- **`domain_config.hostname` is the primary key (no UUID)** — links reference `domainHostname` directly, eliminating joins on the redirect hot path.
- **KV key format `{hostname}:{slug}` for custom, bare `{slug}` for primary** — backward-compatible with pre-multi-domain keys so the M5 migration didn't need a KV rewrite.
- **Composite unique `(slug, domainHostname)` + partial unique `WHERE domainHostname IS NULL`** — SQLite treats NULLs as distinct in composite indexes, so the partial index is the only thing enforcing uniqueness for primary-domain links. Load-bearing.
- **Domain sync deletes links on a hostname Cloudflare no longer routes** — `POST /api/domains/sync` removes the `domain_config` row *and* its links (purging their KV entries first). The FK is `ON DELETE SET NULL`, so leaving the links would silently move them onto the primary host, where the partial unique index can reject them and fail every later sync.
- **`domain_config` holds a row for the primary host, but links on it store `domainHostname` NULL** — the row carries the primary host's root and 404 redirects and its access mode. `GET /api/domains` marks it `isPrimary`, and create, update and bulk reject the primary hostname as a `domainHostname`; a client picking a custom domain hides `isPrimary` rows.
- **Internal links are only allowed on the default domain** — the session cookie is host-only to the primary host, so an internal link on a custom domain would always 403. Rejected at create, update and bulk rather than failing at redirect time.
- **`cleanupOrphanedTeams` hook on user delete** — promotes or deletes teams when the last admin leaves, keeping referential integrity without CASCADE surprises.

### Teams & shared access
- **Access is checked against current membership, not the association row** — `link_campaigns` rows outlive a user's access to the link, so campaign detail and campaign stats filter through `accessibleLinks(userId)` (owner or current team member) instead of trusting the association. The row itself is left intact.
- **The invite route deletes expired invites for the same team + email before inserting** — the unique index on `team_invites(teamId, email)` means an expired invite still occupies the slot and would reject the new one. Any future invite path must do the same.
- **`GET /api/teams/:id/invites` returns the invite token** — the route is team-admin-only and the token is a re-copyable invite link, not a credential belonging to the requester. Do not strip it in a blanket "never return tokens" cleanup.

### Slugs
- **Slugs are stored normalized (percent-decoded → NFC → lowercased), not folded at query time** — one canonical form in the database means the existing unique indexes enforce case-insensitive uniqueness for free, and the redirect hot path stays a plain equality lookup. A `COLLATE NOCASE` index was the alternative, but SQLite's NOCASE only folds ASCII, which would have left `/CAFÉ` and `/café` as separate links.
- **Non-ASCII slugs are allowed** — a path segment is an IRI segment (RFC 3987), and browsers percent-encode it on the wire, so `/🎉` works. The ASCII character set is RFC 3986 `pchar` minus `%` (ambiguous once escapes are decoded) and `/ ? #` (they end the segment).
- **`MAX_SLUG_BYTES` (256) exists on top of `MAX_SLUG_LENGTH` (128)** — the KV cache key is `{hostname}:{slug}` and KV caps keys at 512 bytes. Only non-ASCII slugs can hit the byte cap first (an emoji costs 4 bytes).
- **Team slugs use `validateTeamSlug`, not `validateSlug`** — they are internal identifiers rather than links people type, so they stay ASCII. They are normalized (and therefore case-insensitively unique) all the same.

### Redirect hot path
- **`writeDataPoint()` is synchronous** — the binding doesn't return a promise. Wrapping in `waitUntil` is a silent no-op that hides bugs and has bitten this codebase before.
- **D1 writes on redirect path use `waitUntil`** — click stats and rate-limit counters must not block the 301/302 response.
- **KV stores `hasPassword: boolean`, not the hash** — verification always hits D1; a KV dump can't expose password hashes.
- **`maxClicks` always queries D1, never the cache** — the cap is hard, not soft; trusting a cached counter would let clicks overrun the limit.
- **Bot/OG meta check runs *before* the password gate** — social preview crawlers need to see `<meta property="og:*">` tags on protected links, not the password form. The meta refresh is dropped for a protected link, so a crawler gets the preview without the destination; `og:url` stays the short URL.
- **302s are marked `private, no-store`** — expiry, `maxClicks`, A/B, geo and password gating decide the destination per request, so a cached 302 would serve a stale or ungated answer. A 301 is by definition permanent and stays cacheable.
- **Click tracking is gated on `c.req.method === "GET"`** — Hono routes HEAD through the GET handler, so an untracked guard would let link checkers burn `maxClicks`.
- **Reserved slugs short-circuit ahead of KV and D1** — every SPA route and static file would otherwise cost a KV get plus a D1 select, since misses are not cached. `validateSlug` rejects reserved slugs, so the shortcut can never shadow a real link, but adding a slug to `RESERVED_SLUGS` later black-holes any link already on it.
- **Password gate is self-contained HTML** (no SPA, no WA components, inline CSS with `prefers-color-scheme`) — the redirect path can't afford to boot the SPA, and the form must work without JS.
- **`isSafeRedirectUrl()` on `rootRedirect`/`notFoundRedirect`** — defense in depth against a compromised admin account inserting a `javascript:` or data-URL redirect.
- **Slug is immutable after creation** — editing the slug would require KV cache migration and break existing inbound links; not worth the complexity.

### Analytics & stats
- **`link_stats` coexists with Analytics Engine** — AE retains detailed per-click events ~90 days, `link_stats` holds permanent daily aggregates so lifetime totals survive. Stats endpoints fall back only when AE is unreachable — missing `CF_ACCOUNT_ID`/`CF_API_TOKEN` or a failed query. Timeseries and summary then read `link_stats`; geo, device, referrer and variant endpoints return empty data, since D1 holds no such breakdown. Every fallback response carries `fallback: true`. An empty AE result is reported as-is.
- **AE queries go through the REST SQL API, not a binding** — there is no read binding for Analytics Engine; queries use `fetch()` with `CF_ACCOUNT_ID` + `CF_API_TOKEN`. Token stays worker-side, never exposed to the client.
- **Every click writes both stores from `trackClick()`** — AE synchronously (detail, ~90-day retention) and a `waitUntil`-deferred `upsertDailyStats()` D1 upsert to `link_stats` (permanence + the `maxClicks` cap). An M6 cleanup removed the D1 write entirely, which silently broke `maxClicks` and lifetime totals on real deployments — it was reinstated later. Don't remove it again.
- **`link_stats.uniqueClicks` is only populated by the demo cron** — real traffic increments `clicks` only; per-request code cannot know uniqueness. Unique counts for real deployments come from the AE approximation (`uniq(blob3)` distinct user-agents). No production reader consumes `uniqueClicks`.

### Bulk & public reports
- **Bulk create is two-phase: validate-all then batch-insert** — per-item error reporting requires the full validation pass before any writes. Domain access checks are cached per-request to avoid repeated D1 reads.
- **Bulk inserts go through one `db.batch()`** — the batch is atomic, so any failing row rolls the whole set back and every item reports `Insert failed (batch rolled back)`. Per-item errors come from the validation pass that runs before it, including intra-batch duplicate slugs. Max 50 links, 100KB body.
- **Report access is link access, not link ownership** — `GET`/`POST`/`PUT /api/reports/:linkId` all go through `canAccessLink`, so a team member of a team-owned link can manage its public report. `GET` is read-only and answers `{ data: null }` when no report exists rather than creating one.
- **One public report per link** (unique index on `linkId`) — tokens are shareable and persistent; more than one per link would confuse the UX.
- **Report tokens use `crypto.randomUUID()` with dashes stripped** — 122 bits of entropy, sufficient for public tokens. The original hand-rolled rejection-sampling version was over-engineered and got simplified in M8.

### Rate limiting
- **All rate limits are advisory** — KV lacks atomic increment, so concurrent requests can undercount. Good enough for abuse prevention; use Cloudflare's native Rate Limiting binding if you need strict enforcement.
- **Session requests bypass rate limits** — the browser UI is implicitly rate-limited by human behavior; strict limits cause UX issues in normal use. Only Bearer-token (API key) traffic is metered. A `rateLimitSession` middleware once contradicted this by metering `/api/teams` and `/api/admin` on every authenticated request. It was removed: it spent one KV write per request — making it the largest consumer of the free tier's 1,000 writes/day — to enforce a limit this design never wanted. Don't reintroduce it; `test/unit/rate-limit.test.ts` guards against it with an authenticated burst past the old 60/min ceiling.
- **API key rate limit identified by the first 16 chars of the token** — identifies the key in KV without exposing the full secret.
- **The counter is read before authentication but written after it** — the check middleware can 429 an over-limit key without spending an HMAC and two D1 queries, while an unauthenticated Bearer request costs no KV write. Otherwise a client rotating the 16-char prefix per request would drain the free tier's 1,000 writes/day and break every route that awaits a KV cache write.

### Frontend
- **Bundled `better-auth/client`, no esm.sh import map** — the `jose` dependency breaks under esm.sh's CDN resolver. Bundling with esbuild is the only stable path.
- **Theme toggle via `wa-light`/`wa-dark` class swap on `<html>`** — WA components and CSS re-read the custom properties automatically. Chart.js is the one exception: it resolves colors at construction, so `nav-bar.js` dispatches `theme-change` for `chart-helper.js` to repaint (see below).
- **Chart colors read from `--wa-color-*` custom properties, re-applied on `theme-change`** — Chart.js resolves option values at construction, so a class swap alone cannot repaint an existing chart. `nav-bar.js` dispatches `theme-change` on `document`, and `chart-helper.js` clears its colour cache and updates every chart registered through `createChart()`/`registerChart()`. Charts built outside those two functions are neither re-themed nor destroyed when their canvas detaches.
- **`apiFetch` returns `null` on failure** — eliminates try/catch/finally boilerplate at every call site. Toast and 401-redirect happen once inside the helper.
- **`withLoadingBtn` does NOT catch errors** — separation of concerns: it manages button state only, `apiFetch` owns error reporting. Together they cover all cases without overlap.

### Demo mode
- **Synthetic user via middleware, no `session`/`user` row inserted at boot** — `tryDemoBypass()` in `src/middleware/auth.ts` injects `DEMO_USER` directly on `c.var.user`. Cheaper than maintaining a real Better Auth session, and there's no real D1 row that a buggy non-demo deploy could accidentally read.
- **`/api/auth/*` writes are blocked along with everything else** — there is no login flow in demo, so sign-in/sign-out endpoints should never be reachable. The few public POSTs that must work (password gate) are explicitly allowlisted with a precise regex, not `endsWith` (a loose suffix match would catch future endpoints).
- **Cron stays registered for non-demo deploys** — `triggers.crons` is in the default `wrangler.jsonc`, and the scheduled handler early-returns when `DEMO_MODE` is unset. Cleaner than per-env-block triggers; the cost is one cheap no-op invocation per hour on non-demo deployments.
- **Seed re-runs are idempotent through the FK cascade** — `INSERT OR REPLACE` on a parent deletes the conflicting row first, and D1 runs the `ON DELETE CASCADE` actions, so replacing a `links` row clears its `link_stats` and `link_targets`. That is what keeps the 90-day window from accumulating a trailing edge on a later calendar day. It also fixes the ordering: children must be emitted after their parent, or the parent's replacement wipes them.
- **PBKDF2 params live in `src/lib/password-params.ts`, imported by both `services/password.ts` and `scripts/seed.ts`** — if the iterations bump for security, the seed's hashed `"demo"` password stays compatible automatically. Duplicating the integers in two files was a real drift risk.
- **Banners render into `wa-page`'s `banner` slot, not a fixed-position element** — the slot is already sticky above the header and reserves its own space, so nothing has to measure the banner and pad the body. The earlier fixed-position `.demo-banner` needed a `ResizeObserver` purely so 2-line mobile wraps didn't clip content; the slot makes that whole mechanism unnecessary.
- **Frontend signals demo state via `body.demo-mode` class + CSS, not per-view JS guards** — top-level create buttons hide via `body.demo-mode #new-link-btn` etc. with a `:has()` selector also hiding the wrapping `wa-button-group`. Detail-page edit/delete buttons stay clickable and surface the demo `403` as a warning toast through `apiFetch`.
