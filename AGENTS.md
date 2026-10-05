# AGENTS.md

This file provides guidance to Claude Code, Gemini, Codex, etc when working with code in this repository.

## Project

Veer is a self-hostable URL shortener that runs entirely on Cloudflare Workers. It is a Hono-based TypeScript Worker plus a vanilla-JS SPA bundled by esbuild, using D1 (SQLite) for persistent data, KV for caches and rate limits, and Analytics Engine for per-click events. No domain is hardcoded: any hostname can serve the app or act as a branded custom domain.

`FEATURES.md` lists the product surface. The "Design decisions" section at the bottom of this file explains choices that look odd at first sight.

## Commands

```bash
npm run dev              # wrangler dev --types (predev: local D1 migrate)
npm run build:frontend   # esbuild CLI: one minified ESM bundle, public/dist/app.js + app.css
npm run deploy           # wrangler deploy
npm run typecheck        # wrangler types + tsc --noEmit
npm test                 # vitest run (workerd pool)
npm run test:watch       # vitest in watch mode
npm run db:generate      # drizzle-kit generate; pass -- --name <name> for a descriptive file tag
npm run db:migrate:local # apply drizzle/migrations to the local D1
npm run seed:local       # node scripts/seed.ts > scripts/seed.generated.sql, applied to the local D1
npm run seed:remote      # same, applied to the remote demo D1 (veer-db-demo, --env demo)
```

`wrangler.jsonc` sets `build.command` to `npm run build:frontend`, so Wrangler bundles the SPA itself on `dev`, `deploy` and `types`, and `npm run typecheck` bundles it too. During `dev` it re-runs the build on changes under `src` and `frontend/src`; there is no separate esbuild watcher.

Run a single test file or name: `npx vitest run test/integration/links.test.ts` / `npx vitest run -t "creates link"`.

Tests run against a real workerd instance via `@cloudflare/vitest-pool-workers`. `vitest.config.ts` reads `drizzle/migrations/` with `readD1Migrations()` and passes them through the `TEST_MIGRATIONS` binding; `test/setup.ts` applies them to the test D1 in a `beforeAll`. The suite therefore enforces the same indexes, CHECKs and defaults a real deployment gets, and a new migration needs no test-side change. Vitest collects only `test/**/*.test.ts`, so checkout copies under `.claude/worktrees` never run.

The pool loads the developer's `.dev.vars`, so `vitest.config.ts` pins every var the app reads: `PASSKEY_ENABLED` to `"false"`, and `DEMO_MODE`, `INSTANCE_NAME`, `ADMIN_EMAILS`, `CF_ACCOUNT_ID`, `CF_API_TOKEN` plus every `*_CLIENT_ID`/`*_CLIENT_SECRET` to empty values. Stats requests therefore take the D1 fallback by default. Tests that need a var supply it per request, e.g. `{ ...env, DEMO_MODE: "true" }`; tests of Analytics Engine reads or domain sync pass fake CF credentials and stub `fetch`.

`.dev.vars` holds secrets for `wrangler dev`; see `.dev.vars.example` for the keys (Better Auth secret/URL, admin emails, `CF_ACCOUNT_ID` + `CF_API_TOKEN` for Analytics Engine reads and domain sync, and at least one OAuth provider pair).

## Architecture

### Request flow (`src/index.ts`)
A single Hono app wires every route. Order matters:

1. `onError` returns JSON errors without leaking internals.
2. A global `*` middleware sets the security headers and CSP in a `finally`, so `onError` responses get them too (see Security).
3. `trimTrailingSlash({ alwaysRedirect: true })` 301s `/foo/` to `/foo` so each path has one canonical URL. `alwaysRedirect` is required: the catch-all serves the SPA with a 200, so the default 404-only mode would never fire.
4. The demo write-block on `/api/*` (see Demo mode).
5. Request body caps (see Security).
6. Better Auth serves `/api/auth/*` and handles its own auth.
7. `GET /api/config` is public.
8. Authenticated `/api/*` mounts (see Auth and Rate limits). In Hono `/x/*` also matches `/x`, so each prefix is registered once as `/api/<x>/*`; a bare-path twin would run the auth and rate-limit chain twice. The links and campaigns sub-apps register their `/:id` loaders once as `/:id/*` for the same reason.
9. `/api/public-report/:token` is unauthenticated but IP-rate-limited.
10. Unmatched `/api/*` paths get a JSON 404 and never reach the SPA shell.
11. `GET /` handles custom-domain root redirects, and `GET|POST /:slug` is the redirect engine.
12. The catch-all hands every remaining request to the `ASSETS` binding.

`assets.run_worker_first: true` sends every request, `/:slug` included, to the Worker before static files, so the `assets_navigation_prefers_asset_serving` compat flag has no effect. `assets.not_found_handling: "single-page-application"` makes the binding answer any path with no file with `index.html`.

### Data layer
- `src/db/schema.ts` is the single Drizzle schema. Better Auth tables (`user`, `session`, `account`, `verification`, `passkey`) live alongside product tables (`links`, `link_stats`, `campaigns`, `link_campaigns`, `link_targets`, `domain_config`, `domain_access`, `api_keys`, `public_reports`, `teams`, `team_members`, `team_invites`).
- `getDb(env.DB)` in `src/db/index.ts` wraps the D1 binding in a new Drizzle client on each call.
- Migrations are generated by drizzle-kit (`npm run db:generate -- --name <name>`), numbered sequentially, and applied by Wrangler (`d1 migrations apply`). Never edit an applied migration; generate a new one.
- **`schema.ts` is the sole source of DDL**, including the partial unique index and all three CHECK constraints. Never hand-write DDL into a migration. If `schema.ts` can't express it, fix that.
- `link_stats` is keyed by `(linkId, date)` and `public_reports` by `linkId`. Neither has a surrogate id.
- Slug uniqueness is domain-scoped: the same slug can exist on different domains. A composite unique index `(slug, domainHostname)` enforces it, plus a partial unique index `idx_links_slug_default WHERE domainHostname IS NULL`, because SQLite treats NULLs as distinct in composite indexes. Create and update rely on the indexes and map the UNIQUE error to a 409 (`rethrowAsSlugConflict`). Bulk's per-item pre-check must mirror both indexes.

### Auth (`src/auth/index.ts`, `src/middleware/auth.ts`)
`createAuth(env)` builds Better Auth and `getAuth(env)` memoizes it in a `WeakMap`. `src/lib/providers.ts` enables each social provider whose `*_CLIENT_ID` and `*_CLIENT_SECRET` are both set. The passkey plugin is gated on `PASSKEY_ENABLED=true`.

`src/middleware/auth.ts` exposes `requireAuth`, `requireAdmin` and `requireAuthOrApiKey`, which put the user on `c.var.user` (typed via `AppEnv` in `src/types.ts`). `toAuthUser()` is the one place that builds `AuthUser`, for session and API-key auth alike. It copies fields one by one and derives `isAdmin`; never spread the Better Auth user into it. `requireAuth` gets its user from `sessionUser()`. `requireAuthOrApiKey` delegates to `requireAuth` in demo mode or when there is no Bearer header.

**Admin model**: admin status comes from the comma-separated `ADMIN_EMAILS` env var, checked in `toAuthUser()`. There is no `role` column. `requireAdmin` guards admin-only routes (domain sync/config/access, admin user and team management).

**API keys**: `veer_` prefix + 43 base62 chars (~256 bits), hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, max 10 per user. `/api/me` (an API client's whoami), `/api/links`, `/api/stats`, `/api/campaigns`, `/api/bulk` and `/api/reports` accept a key via `requireAuthOrApiKey`. `/api/keys`, `/api/teams`, `/api/domains` and `/api/admin` are session-only (`requireAuth`), so a leaked key cannot create keys or escalate.

### Rate limits (`src/middleware/rate-limit.ts`)
All limits are KV fixed-window counters and advisory, since KV lacks atomic increment.
- 60 req/min per API key. Each API-key route runs `rateLimitApiKeyCheck`, `requireAuthOrApiKey`, then `rateLimitApiKeyIncrement`. The check reads the counter by token prefix before auth, so an over-limit key costs no HMAC, no D1 join and no `lastUsedAt` write. The increment writes it after auth, so an unknown key costs no KV write; otherwise a client rotating the prefix per request would drain the free tier's 1,000 KV writes/day and break every route that awaits a KV write. Session requests are not metered.
- 30 req/min per IP on `/api/public-report/:token`, under `rl:pub:{ip}:{window}`.
- 5 password attempts per 15 min per link+IP on the `POST /:slug` gate, via `checkPasswordRateLimit`, under `rl:pw:{linkId}:{ip}:{window}`.
- `checkRateLimit` appends `:{windowEpoch}` to the prefix it is given. Every counter write sets `expirationTtl` to twice the window, because a KV put without it clears the key's expiry.

### Redirect engine (`src/routes/redirect.ts`)
The hot path: slug lookup, expiry/internal/max-click gates, bot preview, password gate, geo/device/A-B target resolution, click write to Analytics Engine, daily aggregate upsert to `link_stats`, then 301/302. It reads `src/services/kv-cache.ts` to avoid a D1 read per request and falls through to the SPA for unknown slugs.

**KV keys are domain-scoped**: `{hostname}:{slug}` for custom domains, bare `{slug}` for the primary host (derived from `BETTER_AUTH_URL`). Every get/set/delete in `kv-cache.ts` takes an optional hostname. Always pass it for custom-domain links, or you will read or write the wrong key.

**Hot-path invariants**:
- `AnalyticsEngineDataset.writeDataPoint()` is synchronous and returns nothing. Do not wrap it in `waitUntil`.
- D1 writes on the redirect path (the `upsertDailyStats()` call) go through `c.executionCtx.waitUntil()` to keep latency off the response.
- Bot/OG-meta detection runs before the password gate so social previews work on protected links. A protected link's crawler page carries the `og:*` tags and `og:url` (the short URL) but no meta refresh, so the destination never leaves the server unauthenticated.
- `isHttpUrl()` validates `rootRedirect` / `notFoundRedirect` before redirecting: defense in depth against a `javascript:` or `data:` URL in `domain_config` from a compromised admin.
- Reserved slugs are checked before any KV or D1 read, since misses are not cached and every SPA route or static file would otherwise cost a KV get plus a D1 select. `handleRedirectPost` returns `next()` for one immediately. `handleRedirect` does the same on the primary host, and on a custom domain sends it to the same `notFoundRedirect` as any unknown slug. `validateSlug` rejects reserved slugs, so no link can hold one, but adding a slug to `RESERVED_SLUGS` after launch black-holes any existing link on it.
- Targeting and param forwarding run only once the request is going to redirect, so a password-gated or bot request never spends an A/B roll.
- 302s carry `Cache-Control: private, no-store`: expiry, `maxClicks`, A/B, geo and password gating decide the destination per request, so a cached 302 would replay the wrong one. 301s stay cacheable.
- Hono routes HEAD through the GET handler, so click tracking is guarded by `c.req.method === "GET"` and link checkers do not consume `maxClicks`.

### Analytics (`src/services/analytics.ts`)
- **Writes:** `trackClick()` in `redirect.ts` writes each click twice: to Analytics Engine (synchronous) and a daily-aggregate upsert into `link_stats` via `upsertDailyStats()` inside `waitUntil`, which always writes today's row. Every AE write goes through `writeClickEvent()`, whose comment documents the positional layout (index1=linkId, blob1=slug, blob2=country, blob3=user-agent, blob4=referer, blob5=city, blob6=destinationUrl, blob7=region, double1=timestamp). Its two writers are `trackClick` via `requestVisitor(req)` and the demo cron in `src/scheduled.ts`. Every reader in `src/routes/api/stats.ts` must match the layout.
- **Reads:** Worker-side `fetch()` to the Analytics Engine SQL REST API with `CF_ACCOUNT_ID` + `CF_API_TOKEN`; there is no read binding, and the token never reaches the client. `stats.ts` routes every AE read through its `withAE` helper, against the dataset named by the `AE_DATASET` var. The SQL API has no parameter binding, so every interpolated value is validated first.

### Frontend (`frontend/src/` → `public/dist/`)
- Entry: `frontend/src/app.js`. Routing is a tiny homegrown router (`router.js`); views are plain functions that render into a root `HTMLElement`. Each navigation creates a fresh `<div>` inside `#main` and hands the view that div, so an async render that finishes late writes into a detached node instead of the live page. A view's root is never `#main` itself, so direct-child selectors keyed on `#main` would not match.
- `GET /api/me` is the only source of `currentUser`, and `app.js` passes it to `renderDashboard` (which forwards it to `renderTeamDetail`) and `renderSettings`. Outside demo mode `app.js` calls `authClient.getSession()` first, because that client call is the only request that rolls the session cookie.
- Signed-out routes go through one `authed(view)` wrapper in `app.js`, which renders the login view in place, so the OAuth `callbackURL` is the current location. Anything that changes how unauthenticated routes render must leave the URL intact, or deep links break.
- `renderSettings(container, { activeTab, user })` and `renderTeamDetail` re-render themselves in place, passing the open tab back in so a refresh does not snap to the first tab.
- `public/index.html` is a static SPA shell, not built. The bundle has no code splitting; the SPA has no dynamic import.
- Web Awesome Free components are imported individually (tree-shaken) from `@awesome.me/webawesome`, after three WA stylesheets in `app.js`: `styles/native.css` (resets plus native-element/table styling for light-DOM markup), `styles/themes/awesome.css` and `styles/utilities.css`. All three live in `@layer wa-*` and `app.css` is unlayered, so project rules always win regardless of import order.
- `frontend/src/auth-client.js` is the only place that talks to Better Auth from the browser, through the bundled `better-auth/client`.
- Charts use Chart.js + `chartjs-chart-geo` + `topojson-client` directly (no WA Pro chart components).
- **Theme**: `wa-light`/`wa-dark` class on `<html>`, persisted to `localStorage`, initialized from `prefers-color-scheme`. WA re-reads the custom properties on its own, but Chart.js resolves colors at construction. `lib/chart-helper.js` reads chart colors from `--wa-color-*` and caches them; never hardcode them. The toggle in `components/nav-bar.js` dispatches `theme-change` on `document`, and chart-helper drops the cache and re-colours every tracked chart. Only charts that go through `createChart()` or `registerChart()` are tracked; an unregistered `new Chart()` keeps the old palette until reload and is never destroyed. A tracked chart whose canvas has left the document is destroyed on the next `createChart`/`registerChart` call or theme change, so a view can replace its markup without explicit teardown. `createChart` merges `plugins` and `scales` one level deep, so a caller's own `options.scales` keeps the themed axis colors.
- The `max-width: 480px` rule in `app.css` that hides a third table column is scoped to `#links-table`, the dashboard container in `views/dashboard.js`. Renaming that id silently disables the rule, and dropping the id from the selector would hide the third column of every `.link-table`. `BULK_MAX` in `dashboard.js` must track the server-side cap of 50 links per bulk request. No test enforces either coupling.
- `components/link-form.js` exports only `bindLinkFormDialog(dialog, getOptions, onSaved)`. It renders the form on each `wa-show` and runs `onSaved` after a full save, or on `wa-after-hide` after a partial one. The form saves in two phases and holds state: once the link row exists it remembers the id, so any further submit is a `PUT`. A failed targets save keeps the dialog open. `expiresAt` is sent only when it differs from the loaded value, relying on the API treating an absent field as no-change.
- Internal anchors and fixed-path navigation buttons (`wa-button href="…"`) carry `data-link`, and one click delegate in `app.js` routes them. A button that only opens a dialog uses WA's declarative `data-dialog="open <id>"`.
- **Shared UI helpers** in `lib/ui.js`; reuse them instead of reinventing:
  - `apiFetch(url, opts)` never rejects. It resolves to the parsed JSON, `{}` for a 2xx with no body, or `null` on an HTTP, network or parse failure, after it has toasted the error or redirected a 401. Callers write `if (!result) return;` with no `.catch` or `try`.
  - `withLoadingBtn(btn, fn)` manages loading state only and does not catch errors; `apiFetch` owns error reporting.
  - `renderTable({ label, columns, rows })` (object columns are `{ sortKey, html }`) builds every table. It emits `class="link-table"`, which `app.css` keys on, and the `data-sort` header attributes, so never hand-write a table scaffold.
  - `loadTableSection(el, { url, label, headers, renderRow, empty, error, onPageChange })` loads every paginated collection and owns its spinner, empty and error states.
  - `renderPagination(container, { page, total, limit, onPageChange })` wraps `wa-pagination` in a centered `wa-cluster` div because the component is `display: contents`.
  - Also `shortUrl(link)` (domain-aware), `SPINNER`, `emptyState`, `errorCallout`, `statCard`, `bindConfirmDialog({ dialog, confirmBtn, onConfirm })`, `setTeamOptions(select, teams, { prefix, selected })` and `bindSearchInput`.
- Other shared modules:
  - `lib/chart-helper.js`: `createChart()`, `themeColors()` (cached until the next theme change, safe inside scriptable Chart.js options) and `registerChart(chart)` for a bare `new Chart()`.
  - `lib/stats-common.js`: `SKELETON`, `CHART_SKELETON` (a `wa-frame:landscape` div holding a `wa-skeleton`), `noData`, `fetchJSON`, `statsCard(title, body)`.
  - `lib/config.js`: `getInstanceName()`, `isDemoMode()` and `getLoginOptions()`, valid once `loadConfig()` resolves. The login view renders synchronously from `getLoginOptions()`.
  - `components/toast.js`: `showToast(message, variant)`, and `showNotice(content, variant)` for a persistent notice that takes trusted markup. Both call `create()` on one lazily created `<wa-toast>`.
  - `lib/escape.js`.

### Environment & bindings (`wrangler.jsonc`)
`DB` (D1), `KV` (cache, rate-limit counters), `ANALYTICS` (Analytics Engine dataset `veer_clicks`) and `ASSETS` (static site) are all required. `compatibility_flags: ["nodejs_compat"]` is required because Better Auth imports `node:async_hooks`. `compatibility_date` is capped at the newest date the workerd bundled with `@cloudflare/vitest-pool-workers` accepts; a later date makes `npm test` fail at startup.

`WORKER_NAME` must equal the Worker's `name`: domain sync lists the hostnames Cloudflare routes to the Worker of that name. `AE_DATASET` must equal the env's `analytics_engine_datasets` `dataset`, so a self-hoster who renames the dataset changes both.

The only provisioned environment is `demo`, which has its own D1/KV/AE resources and sets `DEMO_MODE=true`, `INSTANCE_NAME="Veer Demo"`, `AE_DATASET="veer_clicks_demo"` and a `demo.veer.ing` custom-domain route. It inherits `build`, `triggers`, observability and the compatibility settings from the top level. The top-level env is an unprovisioned template: its `BETTER_AUTH_URL` is a placeholder and no `veer` Worker, `veer-db` D1 or KV namespace exists yet, so a bare `npm run deploy` would create all of them from scratch. Provision them and set a real `BETTER_AUTH_URL` before deploying it.

Anything in `wrangler.jsonc` `vars` is emitted by `wrangler types` as a literal union of the configured values, so it must never be redeclared in `src/env.d.ts`. Only secrets and `.dev.vars`-only keys belong there, always as plain `string`.

Every command aimed at the demo instance takes `--env demo`: `wrangler d1 migrations apply veer-db-demo --remote --env demo`, `npm run seed:remote`, `wrangler deploy --env demo`. Without it Wrangler resolves the top-level template and would create the unprovisioned resources.

### Instance branding (`INSTANCE_NAME`)
`INSTANCE_NAME` is an optional plain `var` in `wrangler.jsonc`, not a secret, since it is public branding. Empty or unset falls back to `"Veer"`. Resolve it via `getInstanceName(env)` in `src/lib/branding.ts`. The SPA reads it from the public `GET /api/config`, which returns `{ instanceName, demoMode, providers, passkey }` with no envelope. `frontend/src/lib/config.js` fetches it once before the first render and caches it; `getLoginOptions()` returns `{ providers, passkey }`, or `null` when the fetch failed. `public/index.html` ships an empty `<title>` that `loadConfig()` fills in. The passkey `rpName` reads the resolved name at `getAuth()` time, so changing `INSTANCE_NAME` after passkey credentials exist only affects new registrations. Add future public knobs (logo URL, footer text, etc.) to `/api/config` rather than a new endpoint.

### Demo mode (`DEMO_MODE=true`)
Setting `DEMO_MODE=true` (plain `var` in `wrangler.jsonc`) turns the same codebase into a public read-only showcase. Resolve it via `isDemoMode(env)` in `src/lib/branding.ts`. Three things change:

1. **Auth is bypassed.** `sessionUser()` returns the synthetic `DEMO_USER` from `src/lib/demo.ts` (id `demo-user`, `isAdmin: false`), so `requireAuth` and `requireAuthOrApiKey` both resolve to it. No session row, no OAuth, no `/login` view. The SPA loads the same user from `GET /api/me` and skips `authClient.getSession()`.
2. **Non-GET `/api/*` requests return 403** with `{ error, demoMode: true }`. That includes `POST /api/auth/*`, since demo has no login flow. One middleware registered on `/api/*` after `trimTrailingSlash`, before any route mount, does this. Non-`/api/` writes like the `POST /:slug` password form pass through.
3. **An hourly cron** (`triggers.crons: ["0 * * * *"]`) wakes `src/scheduled.ts`, which returns early unless demo mode is on. In demo mode it writes 1–5 synthetic AE click events per seeded link and adds the same count to today's `link_stats` row.

The SPA signals demo mode with a `.demo-mode` class on `<body>` and a persistent `showNotice()` toast. CSS keyed on `body.demo-mode` hides the top-level create buttons, and the nav bar omits the Logout item. Impersonation is skipped in demo mode, and any leftover impersonation flag is cleared.

`scripts/seed.ts` runs under plain Node type stripping (`node scripts/seed.ts`, Node 22.18+) and writes SQL to stdout. The npm scripts redirect it into `scripts/seed.generated.sql` (gitignored) and apply it with `wrangler d1 execute --file`. Every row uses a stable ID and `INSERT OR REPLACE`, so re-running replaces the fixture set rather than growing it. Fixtures cover the showcase surface: plain, password-gated (password is `demo`), expired, max-clicks-capped, A/B in a campaign, custom-domain and team-owned. The seed imports `src/services/password.ts` and `src/lib/demo.ts`, so those modules may hold only `import type` or `.ts`-suffixed relative imports; `tsconfig.json` sets `allowImportingTsExtensions` for this.

### Directory map
```
src/
  index.ts              # Hono app + route wiring (named `app` export for tests)
  scheduled.ts          # Cron handler (demo synthetic clicks; no-op outside demo)
  types.ts              # AppEnv (Hono Bindings/Variables) + AuthUser
  env.d.ts              # Secrets/optional vars not in wrangler.jsonc (merged into Env)
  auth/index.ts         # Better Auth setup
  db/{index,schema}.ts  # Drizzle client + schema
  middleware/           # auth, rate-limit
  routes/
    redirect.ts         # /:slug hot path
    api/                # links, stats, campaigns, domains, keys, bulk, reports, teams, admin
  services/             # analytics, kv-cache, password, slug, useragent
  lib/                  # branding, crypto, csp, date, demo, errors, link-access, providers, request, team, validators
frontend/src/
  app.js, router.js, auth-client.js
  views/                # one file per SPA screen
  components/           # reusable web components & helpers
  styles/, lib/
public/                 # SPA shell + esbuild output (dist/)
drizzle/migrations/     # numbered SQL migrations (0000_initial.sql, 0001_schema_cleanup.sql, …)
scripts/                # seed.ts (DEMO_MODE seed → seed.generated.sql, gitignored)
test/
  setup.ts              # applies drizzle/migrations to the test D1
  helpers.ts            # shared test helpers
  unit/, integration/   # vitest suites
```

## Conventions

### Core
- Never hardcode `veer.ing` or any other hostname in source. Everything is driven by `BETTER_AUTH_URL`, `domain_config` or the request host.
- Never hardcode the brand string `"Veer"` in user-facing UI or server-rendered HTML. Use `getInstanceName(env)` on the server (`src/lib/branding.ts`) and `getInstanceName()` on the client (`frontend/src/lib/config.js`); both fall back to `"Veer"` when `INSTANCE_NAME` is empty.
- Slugs are user-supplied and required. `src/services/slug.ts` only validates and normalizes; it never generates. **Never store or look up a raw slug**: run it through `validateSlug()` (which returns the canonical form) or `normalizeSlug()` first. The SPA bundles `slug.ts` through `components/link-form.js`, so it must not import server-only code.
- When adding a table, update `src/db/schema.ts` and generate a migration. Tests pick it up automatically.
- When adding an AE field, update `ClickEvent` and the layout comment in `writeClickEvent()` (`src/services/analytics.ts`), both writers (`requestVisitor` and the `SYNTHETIC_VISITORS` entries in `src/scheduled.ts`), and every reader in `src/routes/api/stats.ts`.
- API routes that third-party integrations should reach go behind `rateLimitApiKeyCheck` + `requireAuthOrApiKey` + `rateLimitApiKeyIncrement`, not `requireAuth`.
- `tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `npm run typecheck` fails on an unused local, import or parameter. Prefix an intentionally unused parameter with `_`.

### Frontend (Web Awesome)
- **Load the `webawesome` skill and verify every `wa-*` element against its docs before shipping.** WA has diverged from Shoelace; memory is unreliable. `.claude/skills/webawesome` links into `node_modules`, so it resolves only after `npm install`.
- Shoelace renames to watch for: `start`/`end` not `prefix`/`suffix`, `with-clear` not `clearable`, `hint` not `help-text`, `brand` not `primary`, unprefixed `input`/`change` events. Set a `wa-select`'s initial value with `selected` on `wa-option` or `value` on the select.
- **Style hierarchy** (first available wins): WA utility classes (`wa-stack`, `wa-cluster`, `wa-split`, `wa-grid`, `wa-flank`, `wa-frame`, `wa-gap-*`, `wa-align-items-*`) → semantic tokens (`--wa-color-text-quiet`, `--wa-color-neutral-border-normal`) → custom CSS in `app.css` → inline `style`. Never write inline `display:flex`/`gap`/`align-items` when a WA utility exists, and never use numeric palette tokens (`--wa-color-neutral-300`).

### Backend (Workers)
- **Verify backend code against the `wrangler` and `workers-best-practices` skills** before considering work complete.
- API handlers await KV cache writes, so the cache is consistent before the response. Link create, single and bulk, is the exception and defers via `waitUntil`: no prior cache entry exists, and awaiting would fail a create whose D1 row already committed. Redirect-handler KV writes (cache fill on miss, password counter) and the public-report counter also use `waitUntil`.
- Never cache secrets in KV. Use boolean flags (e.g. `hasPassword`, not the hash).
- Use Drizzle types for update objects: `Partial<typeof table.$inferInsert>`, not `Record<string, ...>`.
- Columns embedded in a raw `sql` fragment render unqualified (`"userId"`, not `"links"."userId"`) when the select has a single table. A correlated subquery written as ``sql`(SELECT count(*) FROM ${links} WHERE ${links.userId} = ${userTable.id})` `` therefore compares `links.userId` to `links.id` and silently returns 0. Bind the outer value (`${user.id}`) or qualify the outer column explicitly. For counts, use `db.$count(table, filter)`, which keeps both sides qualified.
- Route handlers behind auth middleware use `c.var.user!` (the variable is typed as optional because middleware doesn't run on every route).

### Security
- Rate-limit all public endpoints that accept user input.
- Never leak protected data in API responses: password-protected links strip `destinationUrl` to `hasPassword: boolean`.
- HTML-escape all interpolated values in server-generated HTML (password gate, 403/410 message pages, OG meta pages).
- The CSP lives in `src/lib/csp.ts` as one directive array; anything added to the policy belongs there. The global `*` middleware in `src/index.ts` sets it with the other security headers, and only when the handler set no policy of its own. That is how the password gate keeps its `PASSWORD_GATE_CSP`: Chrome enforces `form-action` across a submission's redirect chain, and the gate answers a correct password with a 302 off-origin. Never give the gate a `form-action`.
- `connect-src` includes `https://cdn.jsdelivr.net` because the choropleth fetches world-atlas at runtime, and `font-src` allows `https://fonts.bunny.net`. `script-src` carries one hash, of the inline theme script in `public/index.html`; regenerate it whenever that script changes.
- Hono `bodyLimit` in `src/index.ts` caps `/api/*` bodies at 10 KB and `/api/bulk/*` at 100 KB, and leaves `/api/auth/*` uncapped. It counts streamed bodies without a `Content-Length` too, and answers 413 `Request body too large`.
- The public report endpoint 404s an internal link, and `POST`/`PUT /api/reports/:linkId` refuse to enable a report for one. An internal link's redirect requires a session, so its stats must not be reachable through a shareable token.
- Password hashing: PBKDF2-SHA256 (100k iterations, 16-byte salt) via Web Crypto; verify with `crypto.subtle.timingSafeEqual()`.

### Shared helpers (reuse, don't reinvent)
- Backend `src/lib/`:
  - `branding.ts`: `getInstanceName`, `isDemoMode`.
  - `demo.ts`: `DEMO_USER`, `DEMO_USER_ID`, `DEMO_BLOCKED_MESSAGE`.
  - `validators.ts`: `isHttpUrl`, `validateHttpUrl`, `parseOptionalHttpUrl`, `parseName`, `parseExpiresAt`, `getPrimaryHostname`, `resolveDomainHostname`, `validateDomainAccess(db, hostname, email, isAdmin)`, `assertInternalAllowed`, `assertLinkQuota`.
  - `link-access.ts`: `accessibleLinks(userId)` is the SQL predicate for owned links plus current team links; never hand-write a second OR/subquery. `requireAccessibleLink(db, linkId, userId)` loads one link in one query and 404s whether it is missing or denied.
  - `team.ts`: `requireTeamMember(db, teamId, userId, notFoundMessage?)`, `memberWithUser`.
  - `request.ts`: `parseJsonBody`, `parseOptionalJsonBody`, `parsePagination`, `parseDays` (30 when absent, invalid or below 1; capped at 90), `searchFilter(q, ...columns)` (escaped case-insensitive LIKE across columns, undefined for an empty query), `stripPassword`.
  - `errors.ts`: typed HTTP helpers, each requiring a message, and `isUniqueViolation(e)`.
  - `crypto.ts`: `hashApiKey`, `generateApiKey`.
  - `date.ts`: `formatDate`, `formatHour`, `formatWeek`, `statsCutoff(days)`.
- `src/services/analytics.ts`: `writeClickEvent`, `requestVisitor(req)`, `upsertDailyStats(db, linkId, clicks)`, `sumClicks(db, linkId, since?)`, `dailyClickSeries(db, linkId, days)`. `src/services/kv-cache.ts`: `toCachedRedirect`, `loadCachedRedirect(db, link)` and the get/set/delete helpers.
- `src/middleware/rate-limit.ts`: `checkRateLimit(kv, prefix, limit, windowSecs)` returns `{ exceeded, secondsRemaining, count, hit }`, and `hit()` records the attempt. Also `checkPasswordRateLimit(kv, linkId, ip)`, `rateLimitApiKeyCheck` and `rateLimitApiKeyIncrement`.
- `parseDevice` in `src/services/useragent.ts` is the single device classifier, shared by redirect device targeting and the stats device breakdown. Never add a second one.
- Frontend: see the Frontend architecture section above.

### Tests
- New tests use the shared helpers in `test/helpers.ts` instead of inlining setup: `api(method, path, { body, headers, env, ctx })` (binds the app and defaults to the test env), `postLink`, `setupAuth(overrides)`, `newUser`, `uniq`, `adminEnv(email)`, `createTestLink`, `createTestDomain`, `createTestTeam(userId, role)`, `addTestTeamMember`, `insertClickStat(linkId, clicks, date)`, `isoDaysAgo`, `dayLabel`, `cachedRedirect`, `cfRequest`, `mockExecutionCtx`. They use the pool's env; none takes a `db` or `env` argument.
- `mockExecutionCtx()` swallows `waitUntil` rejections. A test that asserts on a background KV or D1 write must pass `createExecutionContext()` from `cloudflare:test` (via `api(..., { ctx })` or `app.request(path, init, env, ctx)`) and `await waitOnExecutionContext(ctx)`, which also rethrows a rejected background task. Otherwise it races the write.
- Unauthenticated 401 coverage lives in one `it.each` matrix in `test/integration/auth.test.ts`, one row per auth mount, plus `admin.test.ts`'s own matrix. A new authenticated mount needs a row there.
- `tsconfig.json` sets `"types": ["@cloudflare/vitest-pool-workers/types"]`, which is what makes the `cloudflare:test` module visible to `tsc`.
- `tsconfig.json` typechecks `scripts/**`, and the repo has no Node types. `scripts/seed.ts` and the modules it imports (`src/services/password.ts`, `src/lib/demo.ts`) therefore use only globals such as `crypto` and `console`, with no `node:` import; keep it that way or the typecheck breaks.

## Design decisions

The rationale behind choices that look odd. Read these before "cleaning up" anything here.

### Auth & API keys
- **Admin from the `ADMIN_EMAILS` env var, not a DB column**: ops rotate admins by redeploying, with no migration or role column.
- **API keys hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, not plain SHA-256**: prevents offline brute-force if D1 is dumped, since the attacker needs the secret too.
- **Key format `veer_` + 43 base62 chars**: ~256 bits of entropy and a grep-able prefix for secret scanners.
- **`getAuth()` cached in a `WeakMap` keyed on `env`**: Better Auth is expensive to construct, so it is built once per `env` object rather than per call.
- **Better Auth cookie session cache (5 min)**: cuts D1 session lookups for browser traffic. The staleness window is acceptable because logout clears the cookie.
- **Single-provider auto-redirect on login**: when exactly one OAuth provider is configured and passkey is disabled, the login view skips rendering and signs in directly.
- **Impersonation is client-side only**: `POST /api/admin/impersonate/:userId` echoes the target and logs the event, `stop-impersonate` echoes the admin, and the SPA keeps a `sessionStorage` flag that shows a banner. The session never switches, so every API call still runs as the admin. Server-side session switching was rejected to keep the security surface small.

### Domains
- **Admin-synced from the Cloudflare API, not user DNS verification**: Cloudflare already knows what is routed to this Worker, so a TXT-record dance is redundant.
- **`domain_config.hostname` is the primary key (no UUID)**: links reference `domainHostname` directly, so the redirect hot path needs no join.
- **Domain sync deletes links on a hostname Cloudflare no longer routes**: `POST /api/domains/sync` removes the `domain_config` row *and* its links, purging their KV entries first. The FK is `ON DELETE SET NULL`, so leaving the links would silently move them onto the primary host, where the partial unique index can reject them and fail every later sync.
- **`domain_config` holds a row for the primary host, but links on it store `domainHostname` NULL**: the row carries the primary host's root and 404 redirects and its access mode. `GET /api/domains` marks it `isPrimary`, and create, update and bulk collapse the primary hostname to a NULL `domainHostname`. A client picking a custom domain hides `isPrimary` rows.
- **Internal links are only allowed on the default domain**: the session cookie is host-only to the primary host, so an internal link on a custom domain would always 403. Create, update and bulk reject it rather than failing at redirect time.

### Teams & shared access
- **Access is checked against current membership, not the association row**: `link_campaigns` rows outlive a user's access to the link, so campaign detail and campaign stats filter through `accessibleLinks(userId)` instead of trusting the association. The row itself is left intact.
- **The invite route deletes expired invites for the same team + email before inserting**: the unique index on `team_invites(teamId, email)` means an expired invite still occupies the slot and would reject the new one. Any future invite path must do the same.
- **`GET /api/teams/:id/invites` returns the invite token**: the route is team-admin-only, and the token is a re-copyable invite link, not a credential of the requester. Do not strip it in a blanket "never return tokens" cleanup.
- **No user-deletion path exists**: enabling Better Auth's `user.deleteUser` or its admin plugin must add team cleanup, because the `team_members` cascade can leave a team with no admin.

### Slugs
- **Slugs are stored normalized (percent-decoded → NFC → lowercased), not folded at query time**: one canonical form in the database lets the existing unique indexes enforce case-insensitive uniqueness, and the redirect hot path stays a plain equality lookup. A `COLLATE NOCASE` index was the alternative, but SQLite's NOCASE only folds ASCII, which would have left `/CAFÉ` and `/café` as separate links.
- **Non-ASCII slugs are allowed**: a path segment is an IRI segment (RFC 3987), and browsers percent-encode it on the wire, so `/🎉` works. The ASCII character set is RFC 3986 `pchar` minus `%` (ambiguous once escapes are decoded) and `/ ? #` (they end the segment).
- **`MAX_SLUG_BYTES` (256) exists on top of `MAX_SLUG_LENGTH` (128)**: the KV cache key is `{hostname}:{slug}`, and KV caps keys at 512 bytes. Only non-ASCII slugs can hit the byte cap first (an emoji costs 4 bytes).

### Redirect hot path
- **KV stores `hasPassword: boolean`, not the hash**: verification always reads D1, so a KV dump can't expose password hashes.
- **`maxClicks` always queries D1, never the cache**: a cached counter would let clicks overrun the limit. The cap is still soft: the read and the `waitUntil` increment are not atomic, so concurrent clicks can slightly exceed it.
- **The password gate is self-contained HTML** (no SPA, no WA components, inline CSS with `prefers-color-scheme`): the redirect path can't afford to boot the SPA, and the form must work without JS.
- **Slug is immutable after creation**: editing it would require a KV cache migration and break existing inbound links.

### Analytics & stats
- **`link_stats` coexists with Analytics Engine**: AE retains detailed per-click events for ~90 days, and `link_stats` holds permanent daily aggregates so lifetime totals survive. Stats endpoints fall back only when AE is unreachable, meaning missing `CF_ACCOUNT_ID`/`CF_API_TOKEN` or a failed query. Timeseries and summary then read `link_stats`; geo, device, referrer and variant endpoints return empty data, since D1 holds no such breakdown. Every fallback response carries `fallback: true`. An empty AE result is reported as-is.
- **Every click writes both stores from `trackClick()`**: AE synchronously for detail, and a `waitUntil`-deferred `upsertDailyStats()` into `link_stats` for permanence. Don't remove the D1 write: `maxClicks` and lifetime totals read `link_stats`.
- **`link_stats` holds no unique count**: per-request code cannot know uniqueness, so unique visitors come only from AE's `uniq(blob3)` (distinct user-agents), and the D1 fallback reports none. Do not re-add the column.

### Bulk & public reports
- **Bulk create is two-phase: validate all, then batch-insert**: per-item error reporting requires the full validation pass before any write. Domain access checks are cached per request.
- **Bulk inserts go through one `db.batch()`**: the batch is atomic, so any failing row rolls the whole set back and every item reports `Insert failed (batch rolled back)`. Per-item errors come from the validation pass that runs before it, including intra-batch duplicate slugs. Max 50 links, 100 KB body.
- **Report access is link access, not link ownership**: `GET`/`POST`/`PUT /api/reports/:linkId` all go through `requireAccessibleLink`, so a team member of a team-owned link can manage its public report. `GET` is read-only and answers `{ data: null }` when no report exists rather than creating one.
- **One public report per link** (`linkId` is the primary key of `public_reports`): tokens are shareable and persistent, and more than one per link would confuse the UX.
- **Report tokens are `rpt_` + `crypto.randomUUID()` with dashes stripped**: 122 bits of entropy, enough for public tokens.

### Rate limiting
- **All rate limits are advisory**: KV lacks atomic increment, so concurrent requests can undercount. That is good enough for abuse prevention. The Workers Rate Limiting binding would not make them strict, because it is also permissive and counts per Cloudflare location.
- **Session requests bypass rate limits**: the browser UI is rate-limited by human behavior, and strict limits cause UX issues in normal use. Only Bearer traffic is metered. A session limiter would spend one KV write per request against the free tier's 1,000 writes/day. `test/unit/rate-limit.test.ts` guards against one with a 65-request authenticated burst.
- **The API-key counter is keyed on the first 16 chars of the token**: it identifies the key in KV without storing the secret.

### Frontend
- **Bundled `better-auth/client`, no esm.sh import map**: the `jose` dependency breaks under esm.sh's CDN resolver. Bundling with esbuild is the only stable path.
- **The impersonation banner renders into `wa-page`'s `banner` slot**: the slot is sticky above the header and reserves its own space, so nothing has to measure the banner and pad the body.

### Demo mode
- **Synthetic user via middleware, no Better Auth session**: `sessionUser()` in `src/middleware/auth.ts` returns `DEMO_USER` directly, which is cheaper than maintaining a real session. Only the demo seed inserts a matching `user` row, because the fixtures' foreign keys need it.
- **The cron stays registered for non-demo deploys**: `triggers.crons` is in the top-level `wrangler.jsonc`, and the scheduled handler returns early when `DEMO_MODE` is unset. That is cleaner than per-env triggers, at the cost of one cheap no-op invocation per hour on non-demo deployments.
- **Seed re-runs are idempotent through the FK cascade**: `INSERT OR REPLACE` on a parent deletes the conflicting row first, and D1 runs the `ON DELETE CASCADE` actions, so replacing a `links` row clears its `link_stats` and `link_targets`. That keeps the 90-day window from accumulating a trailing edge on a later calendar day. It also fixes the ordering: children must be emitted after their parent, or the parent's replacement wipes them.
- **The seed hashes the demo password with the runtime's `hashPassword`** from `src/services/password.ts`, so the seeded hash always matches the runtime's parameters and `salt:hash` format.
- **Demo state is a `body.demo-mode` class plus CSS, not per-view JS guards**: the campaign and team create buttons hide by id, and the links button group hides via `:has(#new-link-btn)`. Detail-page edit/delete buttons stay clickable and surface the demo 403 as a warning toast through `apiFetch`.
