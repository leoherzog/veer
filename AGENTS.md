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
npm run typecheck        # tsc --noEmit
npm test                 # vitest run (workerd pool)
npm run test:watch       # vitest in watch mode
npm run db:generate      # drizzle-kit generate (create a new migration from schema.ts)
npm run db:migrate:local # apply drizzle/migrations to the local D1
npm run seed:local       # generate scripts/seed.generated.sql + apply to local D1 (DEMO_MODE seed)
npm run seed:remote      # same, applied to the remote D1 (deploy demo instance)
```

Run a single test file or name: `npx vitest run test/integration/links.test.ts` / `npx vitest run -t "creates link"`.

Tests run against a real workerd instance via `@cloudflare/vitest-pool-workers`. `test/setup.ts` manually creates the D1 schema before each run (the miniflare D1 does not execute `drizzle/migrations/` automatically) — if you add or change tables, update `test/setup.ts` alongside the new migration file.

`.dev.vars` holds secrets for `wrangler dev`; see `.dev.vars.example` for the required keys (Better Auth secret/URL, admin emails, `CF_ACCOUNT_ID` + `CF_API_TOKEN` for Analytics Engine reads, and at least one OAuth provider pair).

## Architecture

### Request flow (`src/index.ts`)
A single Hono app wires every route. Order matters:

1. Global error handler returns JSON without leaking internals.
2. Security headers + CSP applied to every response.
3. `/api/auth/*` is mounted first and handles its own auth (Better Auth).
4. `/api/*` routes apply `requireAuth` / `requireAuthOrApiKey` + rate-limit middleware. API-key-capable routes use `rateLimitApiKey`; session-only routes (`/api/teams`, `/api/admin`) use `rateLimitSession`.
5. `/api/public-report/:token` is unauthenticated but IP-rate-limited via KV.
6. `GET /` handles custom-domain root redirects, `GET|POST /:slug` is the redirect engine.
7. Catch-all serves static assets via the `ASSETS` binding, falling back to `index.html` for SPA routes.

The SPA shell is served through `run_worker_first: true` so Worker routes (including `/:slug`) always win over static files.

### Data layer
- `src/db/schema.ts` is the single Drizzle schema — Better Auth tables (`user`, `session`, `account`, `verification`, `passkey`) live alongside product tables (`links`, `link_stats`, `campaigns`, `link_campaigns`, `link_targets`, `domain_config`, `domain_access`, `api_keys`, `public_reports`, `teams`, `team_members`, `team_invites`).
- `getDb(env.DB)` in `src/db/index.ts` returns a cached Drizzle client.
- Migrations are authored with `drizzle-kit generate` and applied by Wrangler (`d1 migrations apply`). Never edit an already-applied migration; create a new one.
- Migrations are numbered sequentially (`0000_initial.sql`, …). Use the next unused number for new migrations.
- Slug uniqueness is domain-scoped: same slug can exist on different domains. Enforced by a composite unique index `(slug, domainHostname)` **plus** a partial unique index `idx_links_slug_default WHERE domainHostname IS NULL` (SQLite treats NULLs as distinct in composite indexes, so the partial index is load-bearing). Any manual uniqueness check must mirror both.

### Auth (`src/auth/index.ts`)
Better Auth is instantiated per-`Env` and memoized in a `WeakMap`. Social providers are read from env vars by `src/lib/providers.ts` — only providers with both `*_CLIENT_ID` and `*_CLIENT_SECRET` present are enabled. The passkey plugin is gated on `PASSKEY_ENABLED=true`. A `databaseHooks.user.delete.after` hook calls `cleanupOrphanedTeams` to promote/delete teams after user deletion.

`src/middleware/auth.ts` exposes `requireAuth`, `requireAdmin`, and `requireAuthOrApiKey`. The authenticated user (with `isAdmin` derived from `ADMIN_EMAILS`) is placed on `c.var.user` — typed via `AppEnv` in `src/types.ts`.

**Admin model**: admin status comes from the `ADMIN_EMAILS` env var (comma-separated), computed inside `requireAuth`. There is no `role` column in the DB. `requireAdmin` guards admin-only routes (domain sync/config/access, admin user management).

**API keys**: `veer_` prefix + 43 base62 chars (~256 bits), hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, max 10 per user. Key management (`/api/keys`, passkey registration, team CRUD for your own account) uses `requireAuth` (session-only), **not** `requireAuthOrApiKey` — you cannot manage API keys via an API key (prevents key escalation).

**Rate limits** (all advisory — KV lacks atomic increment):
- 60 req/min per API key on `requireAuthOrApiKey` routes via `rateLimitApiKey`. Session requests bypass it.
- `rateLimitSession` applies to session-only routes (`/api/teams`, `/api/admin`).
- 30 req/min IP-based on `/api/public-report/:token` (inline in `index.ts` via `checkRateLimit`).
- Public endpoints accepting user input (password gate, etc.) use KV keys of the form `rl:{type}:…:{windowEpoch}` (e.g. `rl:pw:{linkId}:{ip}:{window}`, `rl:pub:{ip}:{window}`) with `expirationTtl` for auto-cleanup.

### Redirect engine (`src/routes/redirect.ts`)
The hot path: slug lookup, password/expiry/max-click gates, optional campaign/A-B target resolution, click write to Analytics Engine, daily aggregate upsert to `link_stats`, then 301/302. Uses `src/services/kv-cache.ts` to avoid D1 reads on every request and falls through to the SPA for unknown slugs.

**KV keys are domain-scoped**: `{hostname}:{slug}` for custom domains, bare `{slug}` for the primary host (derived from `BETTER_AUTH_URL`). Every get/set/delete in `kv-cache.ts` takes an optional hostname — always pass it for custom-domain links or you will read/write the wrong key.

**Hot-path invariants**:
- `AnalyticsEngineDataset.writeDataPoint()` is **synchronous** — do NOT wrap in `waitUntil`.
- D1 writes on the redirect path (the daily `link_stats` upsert via `upsertDailyStats()`) MUST use `c.executionCtx.waitUntil()` to keep latency off the response.
- Bot/OG-meta detection runs **before** the password gate so social previews work on protected links.
- `isSafeRedirectUrl()` validates `rootRedirect` / `notFoundRedirect` before `c.redirect()` — defense in depth against open redirect via `domain_config`.

### Analytics (`src/services/analytics.ts`)
Dual-storage stats:
- **Writes:** `trackClick()` in `redirect.ts` writes each click twice — to Analytics Engine via the `ANALYTICS` binding (synchronous), and a daily-aggregate D1 upsert to `link_stats` via `upsertDailyStats()` inside `waitUntil`. The AE blob schema is a fixed positional layout documented at the top of `analytics.ts` (index1=linkId, blob1=slug, blob2=country, blob3=user-agent, blob4=referer, blob5=city, blob6=destinationUrl, blob7=region, double1=timestamp). Any reader in `src/routes/api/stats.ts` must stay in sync with this layout.
- **Reads:** Worker-side `fetch()` to the Cloudflare Analytics Engine SQL REST API using `CF_ACCOUNT_ID` + `CF_API_TOKEN` (there is no read binding). AE retains detailed events for ~90 days; `link_stats` holds permanent daily aggregates.

### Frontend (`frontend/src/` → `public/dist/`)
- Entry: `frontend/src/app.js`. Routing is a tiny homegrown router (`router.js`); views are plain functions that take a root `HTMLElement` and render into it.
- `esbuild.mjs` bundles with code-splitting (`format: esm`, `splitting: true`) into `public/dist/`. `public/index.html` is a static SPA shell, not built.
- Web Awesome Free components are imported individually (tree-shaken) from `@awesome.me/webawesome`. Auth client is the bundled `better-auth/client` — **do not** switch to an esm.sh import map; it breaks on the `jose` dependency.
- Charts use Chart.js + `chartjs-chart-geo` + `topojson-client` directly (no WA Pro chart components).
- `frontend/src/auth-client.js` is the only place that talks to Better Auth from the browser.
- **Theme**: `wa-light`/`wa-dark` class on `<html>`, persisted to `localStorage`, initialized from `prefers-color-scheme`. Chart colors are read from `--wa-color-*` custom properties so charts auto-theme on toggle — never hardcode chart colors.
- **Shared UI helpers** in `frontend/src/lib/ui.js` — reuse instead of reinventing: `apiFetch(url, opts)` returns parsed JSON or `null` on failure (callers do `if (!result) return;` — toast + 401 redirect are handled once); `withLoadingBtn(btn, fn)` manages loading state only and does **not** catch errors; plus `shortUrl(link)` (domain-aware), `SPINNER`, `emptyState`, `bindConfirmDialog`, `renderPagination(container, { page, total, limit, onPageChange })`, `bindSearchInput`. Other shared modules: `lib/chart-helper.js` (theme-aware Chart.js wrapper), `lib/stats-common.js` (`cardError`, `noData`, `fetchJSON`), `lib/escape.js`.

### Environment & bindings (`wrangler.jsonc`)
`DB` (D1), `KV` (namespaces for cache/rate limit/public-report counters), `ANALYTICS` (Analytics Engine dataset `veer_clicks`), and `ASSETS` (static site) are all required. `compatibility_flags: ["nodejs_compat_v2"]` is required for Better Auth dependencies. The `staging` and `demo` envs are pre-wired with separate D1/KV/AE datasets; `demo` additionally sets `DEMO_MODE=true`, `INSTANCE_NAME="Veer Demo"`, and a `demo.veer.ing` custom-domain route.

### Instance branding (`INSTANCE_NAME`)
`INSTANCE_NAME` is an optional plain `var` in `wrangler.jsonc` (not a secret — it is public branding). When unset or empty it falls back to `"Veer"`. Resolved everywhere via `getInstanceName(env)` in `src/lib/branding.ts` — **never hardcode the brand string.** The frontend reads it from a public `GET /api/config` endpoint (`{ instanceName, demoMode }`) fetched once by `frontend/src/lib/config.js` before the first render; `getInstanceName()` on the client returns the cached value. `public/index.html` ships with an empty `<title>` and is filled in by `loadConfig()`. The passkey `rpName` reads the resolved name at `getAuth()` time — changing `INSTANCE_NAME` after passkey credentials exist only affects new registrations. Shape `/api/config`'s return object so future branding knobs (logo URL, footer text, etc.) slot in without a new endpoint.

### Demo mode (`DEMO_MODE=true`)
Setting `DEMO_MODE=true` (plain `var` in `wrangler.jsonc`) turns the same codebase into a public read-only showcase. Resolved via `isDemoMode(env)` in `src/lib/branding.ts`. Three things change:

1. **Auth is bypassed.** `requireAuth` / `requireAuthOrApiKey` short-circuit via the `tryDemoBypass()` helper and inject the synthetic `DEMO_USER` from `src/lib/demo.ts` (id=`demo-user`, `isAdmin: false`). No session row, no OAuth, no `/login` view. The frontend mirrors this in `app.js`: when `isDemoMode()` is true, it sets a synthetic `currentUser` and skips `authClient.getSession()`.
2. **All non-GET `/api/*` writes return 403** with `{ error, demoMode: true }`. The block is a single middleware in `src/index.ts` placed right after CORS, before any route mount. The only allowlisted write is the password gate, matched by the precise regex `^/api/links/[^/]+/check-password$` — not `endsWith("/check-password")`. `POST /api/auth/*` is intentionally blocked (no login flow in demo). Non-`/api/` writes like `POST /:slug` (password form submit) pass through.
3. **An hourly cron** (`triggers.crons: ["0 * * * *"]`) wakes `src/scheduled.ts`, which early-returns when `DEMO_MODE` is unset (one cheap no-op per hour on non-demo deploys). When demo, it writes 1–5 synthetic AE click events per seeded link and upserts today's `link_stats` row with `uniqueClicks` scaled to 60–85% of `clicks`.

Frontend signals demo mode by adding a `.demo-mode` class to `<body>` plus a fixed-position `.demo-banner` (see `frontend/src/styles/app.css`). Body padding follows the banner's actual height via `ResizeObserver` so mobile wraps don't clip content. Top-level create buttons are hidden by CSS selectors keyed on `body.demo-mode`. The impersonation banner is suppressed in demo mode (both occupy the same fixed slot). The Logout dropdown item is also hidden — it has nothing to log out of.

Seed lives in `scripts/seed.ts` and emits `scripts/seed.generated.sql` (gitignored), applied via `wrangler d1 execute --file`. Re-running is idempotent: the script prepends `DELETE FROM link_stats WHERE linkId IN (...seeded IDs...)` and uses `INSERT OR REPLACE` everywhere else. Fixtures cover the showcase surface: plain, password-gated (password is `demo`), expired, max-clicks-capped, A/B campaign, custom-domain, team-owned. The password hash is computed with the same PBKDF2 params as the runtime, sourced from `src/lib/password-params.ts` so the seed and `src/services/password.ts` can't drift.

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
  lib/                  # branding, crypto, date, demo, errors, password-params, providers, request, team, validators
frontend/src/
  app.js, router.js, auth-client.js
  views/                # one file per SPA screen
  components/           # reusable web components & helpers
  styles/, lib/
public/                 # SPA shell + esbuild output (dist/)
drizzle/migrations/     # numbered SQL migrations (0000_initial.sql, …)
scripts/                # seed.ts (DEMO_MODE seed → seed.generated.sql, gitignored)
test/
  setup.ts              # hand-written schema bootstrap — update with new migrations
  unit/, integration/   # vitest suites
```

## Conventions

### Core
- Never hardcode `veer.ing` or any other hostname in source — everything is driven by `BETTER_AUTH_URL`, `domain_config`, or the request host.
- Never hardcode the brand string `"Veer"` in user-facing UI or server-rendered HTML. Use `getInstanceName(env)` on the server (`src/lib/branding.ts`) and `getInstanceName()` on the client (`frontend/src/lib/config.js`) — both fall back to `"Veer"` when `INSTANCE_NAME` is empty.
- Slugs are user-supplied and required. `src/services/slug.ts` only validates; it never generates.
- When adding a table, update `src/db/schema.ts`, generate a migration (`npm run db:generate`), and mirror the new DDL in `test/setup.ts` so tests keep passing.
- When adding a new AE field, update the blob-index comment in `src/services/analytics.ts` *and* every reader in `src/routes/api/stats.ts`.
- API routes that should be usable by third-party integrations must go behind `requireAuthOrApiKey` + `rateLimitApiKey`, not `requireAuth`.

### Frontend (Web Awesome)
- **Load the `webawesome` skill and verify every `wa-*` element against its docs before shipping.** WA has diverged from Shoelace; memory is unreliable.
- Renames that have already bitten this codebase: `start`/`end` not `prefix`/`suffix`, `with-clear` not `clearable`, `hint` not `help-text`, `brand` not `primary`, unprefixed `input`/`change` events. `wa-select` value goes on the parent (not `selected` on `wa-option`). `wa-textarea` value must be set programmatically after render, not as an HTML attribute.
- **Style hierarchy** (first available wins): WA utility classes (`wa-stack`, `wa-cluster`, `wa-split`, `wa-grid`, `wa-flank`, `wa-frame`, `wa-gap-*`, `wa-align-items-*`) → semantic tokens (`--wa-color-text-quiet`, `--wa-color-neutral-border-normal`) → custom CSS in `app.css` → inline `style`. **Never** write inline `display:flex`/`gap`/`align-items` when a WA utility exists, and **never** use numeric palette tokens (`--wa-color-neutral-300`).

### Backend (Workers)
- **Verify backend code against the `wrangler` and `workers-best-practices` skills** before considering work complete.
- `AnalyticsEngineDataset.writeDataPoint()` is synchronous — do NOT wrap in `waitUntil`.
- D1 writes in the redirect hot path MUST use `c.executionCtx.waitUntil()`. API handler KV writes use `await` (consistency before response); redirect handler KV writes use `waitUntil`.
- Never cache secrets in KV — use boolean flags (e.g. `hasPassword`, not the hash).
- Use Drizzle types for update objects: `Partial<typeof table.$inferInsert>`, not `Record<string, ...>`.
- Route handlers behind auth middleware use `c.var.user!` (the variable is typed as optional because middleware doesn't run on every route).

### Security
- Rate-limit all public endpoints that accept user input.
- Never leak protected data in API responses — password-protected links strip `destinationUrl` to `hasPassword: boolean`.
- HTML-escape all interpolated values in server-generated HTML (password gate, 410 Gone, OG meta pages).
- Bot/crawler detection serves the OG-meta page **before** the password gate so social previews work on protected links.
- Password hashing: PBKDF2-SHA256 (100k iterations, 16-byte salt) via Web Crypto; verify with `crypto.subtle.timingSafeEqual()`.

### Shared helpers (reuse, don't reinvent)
- Backend `src/lib/`: `branding.ts` (`getInstanceName`, `isDemoMode`), `demo.ts` (`DEMO_USER`, `DEMO_USER_ID`, `DEMO_BLOCKED_MESSAGE`), `password-params.ts` (PBKDF2 constants — shared between `src/services/password.ts` and `scripts/seed.ts`), `validators.ts` (`validateHttpUrl`, `validateDomainAccess`), `team.ts` (`requireTeamMember`), `request.ts` (`parsePagination`), `errors.ts` (typed HTTP helpers), `crypto.ts` (`hashApiKey`, `generateApiKey`), `date.ts` (`formatDate`, `formatHour`, `formatWeek`).
- Backend `src/middleware/rate-limit.ts` exports `rateLimitApiKey`, `rateLimitSession`, and standalone `checkRateLimit()` for non-middleware use.
- Frontend: `lib/ui.js`, `lib/chart-helper.js`, `lib/stats-common.js`, `lib/escape.js` (see the Frontend architecture section above). `lib/config.js` exposes `getInstanceName()` and `isDemoMode()` after `loadConfig()` resolves.

### Tests
- New tests should use shared helpers in `test/helpers.ts`: `createTestLink`, `createTestDomain`, `insertClickStat`, `apiRequest`. Don't inline setup.

## Design decisions

Non-obvious rationale behind load-bearing choices. Read these before "cleaning up" anything here — most of this code looks weird for a reason.

### Auth & API keys
- **Admin from `ADMIN_EMAILS` env var, not a DB column** — lets ops rotate admins by redeploying; avoids a migration + role-column dance. The original `user.role` column was dropped in M6 as dead schema.
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
- **`cleanupOrphanedTeams` hook on user delete** — promotes or deletes teams when the last admin leaves, keeping referential integrity without CASCADE surprises.

### Redirect hot path
- **`writeDataPoint()` is synchronous** — the binding doesn't return a promise. Wrapping in `waitUntil` is a silent no-op that hides bugs and has bitten this codebase before.
- **D1 writes on redirect path use `waitUntil`** — click stats and rate-limit counters must not block the 301/302 response.
- **KV stores `hasPassword: boolean`, not the hash** — verification always hits D1; a KV dump can't expose password hashes.
- **`maxClicks` always queries D1, never the cache** — the cap is hard, not soft; trusting a cached counter would let clicks overrun the limit.
- **Bot/OG meta check runs *before* the password gate** — social preview crawlers need to see `<meta property="og:*">` tags on protected links, not the password form.
- **Password gate is self-contained HTML** (no SPA, no WA components, inline CSS with `prefers-color-scheme`) — the redirect path can't afford to boot the SPA, and the form must work without JS.
- **`isSafeRedirectUrl()` on `rootRedirect`/`notFoundRedirect`** — defense in depth against a compromised admin account inserting a `javascript:` or data-URL redirect.
- **Slug is immutable after creation** — editing the slug would require KV cache migration and break existing inbound links; not worth the complexity.

### Analytics & stats
- **`link_stats` coexists with Analytics Engine** — AE retains detailed per-click events ~90 days, `link_stats` holds permanent daily aggregates so lifetime totals survive. Stats endpoints fall back to `link_stats` when AE returns no rows.
- **AE queries go through the REST SQL API, not a binding** — there is no read binding for Analytics Engine; queries use `fetch()` with `CF_ACCOUNT_ID` + `CF_API_TOKEN`. Token stays worker-side, never exposed to the client.
- **Every click writes both stores from `trackClick()`** — AE synchronously (detail, ~90-day retention) and a `waitUntil`-deferred `upsertDailyStats()` D1 upsert to `link_stats` (permanence + the `maxClicks` cap). An M6 cleanup removed the D1 write entirely, which silently broke `maxClicks` and lifetime totals on real deployments — it was reinstated later. Don't remove it again.
- **`link_stats.uniqueClicks` is only populated by the demo cron** — real traffic increments `clicks` only; per-request code cannot know uniqueness. Unique counts for real deployments come from the AE approximation (`uniq(blob3)` distinct user-agents). No production reader consumes `uniqueClicks`.

### Bulk & public reports
- **Bulk create is two-phase: validate-all then batch-insert** — per-item error reporting requires the full validation pass before any writes. Domain access checks are cached per-request to avoid repeated D1 reads.
- **Bulk uses `ON CONFLICT DO NOTHING` + post-insert verification** — per-row conflict detection without a transaction per link. Max 50 links, 100KB body.
- **One public report per link** (unique index on `linkId`) — tokens are shareable and persistent; more than one per link would confuse the UX.
- **Report tokens use `crypto.randomUUID()` with dashes stripped** — 122 bits of entropy, sufficient for public tokens. The original hand-rolled rejection-sampling version was over-engineered and got simplified in M8.

### Rate limiting
- **All rate limits are advisory** — KV lacks atomic increment, so concurrent requests can undercount. Good enough for abuse prevention; use Cloudflare's native Rate Limiting binding if you need strict enforcement.
- **Session requests bypass rate limits** — the browser UI is implicitly rate-limited by human behavior; strict limits cause UX issues in normal use. Only Bearer-token (API key) traffic is metered.
- **API key rate limit identified by the first 16 chars of the token** — identifies the key in KV without exposing the full secret.

### Frontend
- **Bundled `better-auth/client`, no esm.sh import map** — the `jose` dependency breaks under esm.sh's CDN resolver. Bundling with esbuild is the only stable path.
- **Theme toggle via `wa-light`/`wa-dark` class swap on `<html>`** — WA components re-read CSS custom properties automatically; no per-component updates needed.
- **Chart colors read from `--wa-color-*` custom properties** — charts auto-theme on light/dark toggle with zero JS glue.
- **`apiFetch` returns `null` on failure** — eliminates try/catch/finally boilerplate at every call site. Toast and 401-redirect happen once inside the helper.
- **`withLoadingBtn` does NOT catch errors** — separation of concerns: it manages button state only, `apiFetch` owns error reporting. Together they cover all cases without overlap.

### Demo mode
- **Synthetic user via middleware, no `session`/`user` row inserted at boot** — `tryDemoBypass()` in `src/middleware/auth.ts` injects `DEMO_USER` directly on `c.var.user`. Cheaper than maintaining a real Better Auth session, and there's no real D1 row that a buggy non-demo deploy could accidentally read.
- **`/api/auth/*` writes are blocked along with everything else** — there is no login flow in demo, so sign-in/sign-out endpoints should never be reachable. The few public POSTs that must work (password gate) are explicitly allowlisted with a precise regex, not `endsWith` (a loose suffix match would catch future endpoints).
- **Cron stays registered for non-demo deploys** — `triggers.crons` is in the default `wrangler.jsonc`, and the scheduled handler early-returns when `DEMO_MODE` is unset. Cleaner than per-env-block triggers; the cost is one cheap no-op invocation per hour on non-demo deployments.
- **Seed re-runs are idempotent via `DELETE FROM link_stats` + `INSERT OR REPLACE`** — without the DELETE, re-running on a later calendar day leaves yesterday's oldest day lingering and the table grows unbounded. All other tables use stable IDs so `INSERT OR REPLACE` alone is enough.
- **PBKDF2 params live in `src/lib/password-params.ts`, imported by both `services/password.ts` and `scripts/seed.ts`** — if the iterations bump for security, the seed's hashed `"demo"` password stays compatible automatically. Duplicating the integers in two files was a real drift risk.
- **Banner padding is driven by `ResizeObserver` on the banner element** — fixed `padding-top: 3rem` clipped content under 2-line wraps on mobile. The observer keeps body padding equal to the banner's actual height.
- **Frontend signals demo state via `body.demo-mode` class + CSS, not per-view JS guards** — top-level create buttons hide via `body.demo-mode #new-link-btn` etc. with a `:has()` selector also hiding the wrapping `wa-button-group`. Detail-page edit/delete buttons stay clickable and surface the demo `403` as a warning toast through `apiFetch`.
