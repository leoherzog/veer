# AGENTS.md

This file provides guidance to Claude Code, Gemini, Codex, etc when working with code in this repository.

## Project

Veer is a self-hostable URL shortener that runs entirely on Cloudflare Workers. It is a Hono-based TypeScript Worker plus a vanilla-JS SPA bundled by esbuild. It uses D1 (SQLite) for persistent data, KV for the redirect cache and password-gate counters, the Workers Rate Limiting binding for API-key and public-report limits, and Analytics Engine for per-click events. No domain is hardcoded: any hostname can serve the app or act as a branded custom domain.

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
npm run db:migrate:local # apply drizzle/migrations to the local D1 (binding DB)
npm run seed:local       # node scripts/seed.ts > scripts/seed.generated.sql, applied to the local D1
npm run seed:remote      # same, applied to the remote demo D1 (binding DB, --env demo)
```

`wrangler.jsonc` sets `build.command` to `npm run build:frontend`, so Wrangler bundles the SPA itself on `dev`, `deploy` and `types`, and `npm run typecheck` bundles it too. During `dev` it re-runs the build on changes under `src` and `frontend/src`; there is no separate esbuild watcher.

Run a single test file or name: `npx vitest run test/integration/links.test.ts` / `npx vitest run -t "creates link"`.

Tests run against a real workerd instance via `@cloudflare/vitest-plugin`. `vitest.config.ts` reads `drizzle/migrations/` with `readD1Migrations()` and passes them through the `TEST_MIGRATIONS` binding; `test/setup.ts` applies them to the test D1 in a `beforeAll`. The suite therefore enforces the same indexes, CHECKs and defaults a real deployment gets, and a new migration needs no test-side change. Vitest collects only `test/**/*.test.ts`, so checkout copies under `.claude/worktrees`, which `.gitignore` also excludes, never run.

The pool loads the developer's `.dev.vars`, so `vitest.config.ts` pins every var the app reads. `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` (`http://localhost:8787`) get test values, `PASSKEY_ENABLED` is `"false"`, and `AE_DATASET` and `WORKER_NAME` keep their `wrangler.jsonc` values. `DEMO_MODE`, `INSTANCE_NAME`, `ADMIN_EMAILS`, `CF_ACCOUNT_ID`, `CF_API_TOKEN` and every `*_CLIENT_ID`/`*_CLIENT_SECRET` are empty, so stats requests take the D1 fallback by default. A new var the app reads needs a pin there too. Tests that need a var supply it per request, e.g. `{ ...env, DEMO_MODE: "true" }`; tests of Analytics Engine reads or domain sync pass fake CF credentials and stub `fetch`.

`.dev.vars` holds secrets for `wrangler dev`; see `.dev.vars.example` for the keys (Better Auth secret/URL, admin emails, `CF_ACCOUNT_ID` + `CF_API_TOKEN` for Analytics Engine reads and domain sync, and at least one OAuth provider pair). `.gitignore` excludes every `.dev.vars*` file except `.dev.vars.example`, and every `.env*` file.

## Architecture

### Request flow (`src/index.ts`)
A single Hono app wires every route. Order matters:

1. `onError` returns JSON errors without leaking internals.
2. A global `*` middleware sets the security headers and CSP after `await next()`. Hono runs `onError` inside `next()`, so error responses get them too (see Security).
3. `trimTrailingSlash({ alwaysRedirect: true })` 301s `/foo/` to `/foo` so each path has one canonical URL. `alwaysRedirect` is required: the catch-all serves the SPA with a 200, so the default 404-only mode would never fire.
4. The demo write-block on `/api/*` (see Demo mode).
5. Request body caps (see Security).
6. Better Auth serves `/api/auth/*` and handles its own auth.
7. `GET /api/config` is public.
8. Authenticated `/api/*` mounts (see Auth and Rate limits). In Hono `/x/*` also matches `/x`, so each prefix is registered once as `/api/<x>/*`; a bare-path twin would run the auth chain, and meter a Bearer request, twice. The links and campaigns sub-apps register their `/:id` loaders once as `/:id/*` for the same reason.
9. `/api/public-report/:token` is unauthenticated but IP-rate-limited by `rateLimitPublicReport`.
10. Unmatched `/api/*` paths get a JSON 404 and never reach the SPA shell.
11. `GET /` handles custom-domain root redirects, and `GET|POST /:slug` is the redirect engine. `POST /:slug` has a 4,096-byte body cap.
12. The catch-all hands every remaining request to the `ASSETS` binding.

`assets.run_worker_first` runs the Worker first for every path, `/` and `/:slug` included, except four exact files: `/dist/app.js`, `/dist/app.css`, `/data/countries-110m.json` and `/favicon.svg`. The asset worker serves those directly with the headers in `public/_headers`, so a route or middleware for them in `src/index.ts` never runs in production. Because every other path matches `/*`, the `assets_navigation_prefers_asset_serving` compat flag has no effect. `assets.not_found_handling: "single-page-application"` makes the binding answer any path with no file with `index.html`.

Negate exact files, never a prefix: the asset worker answers a miss under a negated prefix with the SPA shell and no CSP. To make a new static file skip the Worker, add an exact `!` entry in `wrangler.jsonc` and a matching rule in `public/_headers`. Renaming an esbuild output or the world-atlas file needs the same two edits. Without them the file is still served, through the catch-all, as a metered Worker request.

### Data layer
- `src/db/schema.ts` is the single Drizzle schema. Better Auth tables (`user`, `session`, `account`, `verification`, `passkey`) live alongside product tables (`links`, `link_stats`, `campaigns`, `link_campaigns`, `link_targets`, `domain_config`, `domain_access`, `api_keys`, `public_reports`, `teams`, `team_members`, `team_invites`).
- `getDb(env.DB)` in `src/db/index.ts` wraps the D1 binding in a new Drizzle client on each call. It carries no schema, so `db.query` is empty; use `db.select()`. The Better Auth adapter gets the schema directly in `src/auth/index.ts`.
- Migrations are generated by drizzle-kit (`npm run db:generate -- --name <name>`), numbered sequentially, and applied by Wrangler (`d1 migrations apply`). Never edit an applied migration; generate a new one.
- D1 ignores `PRAGMA foreign_keys=OFF`, because it runs every query in an implicit transaction. A generated migration that drops and recreates a table other tables reference therefore fires their `ON DELETE CASCADE` and `SET NULL` actions and wipes or detaches their rows. `PRAGMA defer_foreign_keys = on` defers only the constraint checks, so the drop's implicit delete still runs those actions. Read every generated migration for a table rebuild before applying it. A rebuild of a referenced table needs a schema change that avoids the rebuild, or an owner decision.
- **`schema.ts` is the sole source of DDL**, including the partial unique index and all three CHECK constraints. Never hand-write DDL into a migration. If `schema.ts` can't express it, fix that.
- `team_members.role`, `team_invites.role` and `link_targets.type` are Drizzle text enums, each backed by a CHECK that must list the same values. `domain_config.accessMode` is a type-only enum with no CHECK, so routes still validate it. Code that writes these columns passes narrowed literals.
- `link_stats` is keyed by `(linkId, date)` and `public_reports` by `linkId`. Neither has a surrogate id.
- `user.email` is unique, and `session.userId` and `verification.identifier` are indexed.
- Slug uniqueness is domain-scoped: the same slug can exist on different domains. A composite unique index `(slug, domainHostname)` enforces it, plus a partial unique index `idx_links_slug_default WHERE domainHostname IS NULL`, because SQLite treats NULLs as distinct in composite indexes. Create and update rely on the indexes and map the UNIQUE error to a 409 (`rethrowAsSlugConflict`). Bulk's per-item pre-check must mirror both indexes.
- Link create and link update are each one atomic `db.batch()` that includes their `link_campaigns` writes, so a rejected slug leaves no association behind.
- D1 caps a statement at 100 bound parameters. Multi-row writes go one insert per row inside a `db.batch()`, and every `inArray` over a value list is capped (`BULK_MAX`, `CAMPAIGN_LINKS_MAX`, `SYNC_PURGE_SELECT_CHUNK`).

### Auth (`src/auth/index.ts`, `src/middleware/auth.ts`)
`createAuth(env)` builds Better Auth and `getAuth(env)` memoizes it in a `WeakMap`. `createAuth` throws `BETTER_AUTH_SECRET is not set` when the secret is empty or missing, since Better Auth would otherwise sign with its public default secret outside production. `src/lib/providers.ts` enables each social provider whose `*_CLIENT_ID` and `*_CLIENT_SECRET` are both set. The passkey plugin is gated on `PASSKEY_ENABLED=true` through `isPasskeyEnabled(env)`. Its rpID and origin derive from `baseURL` (`BETTER_AUTH_URL`), and its rpName from `appName`, which is `getInstanceName(env)`.

Sign-up requires an email the provider has verified. `databaseHooks.user.create.before` refuses any other user, because `isAdmin`, domain access and invite acceptance all trust `user.email`. Better Auth then redirects the OAuth callback to `/api/auth/error?error=unable_to_create_user`. Google, GitHub and Discord report verification without extra setup.

Microsoft runs on Better Auth's default `common` tenant, so work, school and personal accounts all reach the callback. Better Auth reads verification from the ID token. An `email_verified` claim decides when present, but Entra's optional-claims reference offers none. Otherwise the email counts as verified only when it appears in `verified_primary_email` or `verified_secondary_email`, optional claims the app registration must add to the ID token. Microsoft documents those two for work and school accounts only, so a personal account is likely refused. Unverified until tested with a personal Microsoft account.

`src/middleware/auth.ts` exposes `requireAuth`, `requireAdmin` and `requireAuthOrApiKey`, which put the user on `c.var.user`. `toAuthUser()` is the one place that builds `AuthUser`, for session and API-key auth alike. It copies fields one by one and derives `isAdmin`; never spread the Better Auth user into it. `requireAuth` gets its user from `sessionUser()`. `requireAuthOrApiKey` delegates to `requireAuth` in demo mode or when there is no Bearer header.

**Admin model**: admin status comes from the comma-separated `ADMIN_EMAILS` env var, checked in `toAuthUser()`, and also needs `emailVerified`, since anyone can claim an unverified address. There is no `role` column. `requireAdmin` guards admin-only routes: the whole `/api/admin` mount, and every domain route below the list, through `domainRoutes.use("/:hostname/*", requireAdmin)` in `src/routes/api/domains.ts`, which also matches `/sync`.

**API keys**: `veer_` prefix + 43 base62 chars (~256 bits), hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, max 10 per user. `/api/me` (an API client's whoami), `/api/links`, `/api/stats`, `/api/campaigns`, `/api/bulk` and `/api/reports` accept a key via `requireAuthOrApiKey`. `/api/keys`, `/api/teams`, `/api/domains` and `/api/admin` are session-only (`requireAuth`), so a leaked key cannot create keys or escalate.

### Rate limits (`src/middleware/rate-limit.ts`)
The API-key and public-report limits use the Workers Rate Limiting binding, which counts per Cloudflare location and is eventually consistent, so both are approximate. The password gate keeps a KV fixed-window counter, because its 15-minute window exceeds the binding's longest period of 60 seconds.
- 60 req/min per API key (`API_KEY_LIMIT`) through `API_KEY_RATE_LIMITER`. `requireAuthOrApiKey` calls it with the token's first 16 characters before the HMAC and the D1 lookup, so an over-limit key costs neither. A metered response carries `X-RateLimit-Limit`. Session and demo-mode requests never call the limiter.
- 30 req/min per IP (`cf-connecting-ip`) on `/api/public-report/:token`, through `PUBLIC_REPORT_RATE_LIMITER` in `rateLimitPublicReport`.
- Both limiters answer through `rateLimited(c, limit)`: a 429 `{ error: "Rate limit exceeded", retryAfter: 60 }` with `Retry-After: 60` and `X-RateLimit-Limit`. The binding reports only success, so `Retry-After` is always the full period.
- The binding does not expose its configuration, so the `ratelimits` limits and periods in `wrangler.jsonc` must match the constants in `rate-limit.ts`.
- 5 password attempts per 15 min per link+IP on the `POST /:slug` gate, via `checkPasswordRateLimit`, under `rl:pw:{linkId}:{ip}:{window}`. `checkRateLimit` appends `:{windowEpoch}` to the prefix it is given. Every counter write sets `expirationTtl` to twice the window, because a KV put without it clears the key's expiry.

### Redirect engine (`src/routes/redirect.ts`)
The hot path: slug validation, lookup, expiry/internal/max-click gates, bot preview, password gate, geo/device/A-B target resolution, click write to Analytics Engine, daily aggregate upsert to `link_stats`, then 301/302. It reads `src/services/kv-cache.ts` to avoid a D1 read per request and falls through to the SPA for unknown slugs.

**KV keys are domain-scoped**: `{hostname}:{slug}` for custom domains, bare `{slug}` for the primary host (derived from `BETTER_AUTH_URL`). Every get/set/delete in `kv-cache.ts` takes an optional hostname. Always pass it for custom-domain links, or you will read or write the wrong key. `requestHost(c)` returns null for the primary host, `localhost` and `127.0.0.1`, so local dev resolves primary-host links.

**Hot-path invariants**:
- `AnalyticsEngineDataset.writeDataPoint()` is synchronous and returns nothing. Do not wrap it in `waitUntil`.
- D1 writes on the redirect path (the `upsertDailyStats()` call) go through `c.executionCtx.waitUntil()` to keep latency off the response.
- Bot/OG-meta detection runs before the password gate so social previews work on protected links. A protected link's crawler page carries the `og:*` tags and `og:url` (the short URL) but no meta refresh, so the destination never leaves the server unauthenticated.
- `isHttpUrl()` validates `rootRedirect` / `notFoundRedirect` before redirecting: defense in depth against a `javascript:` or `data:` URL in `domain_config` from a compromised admin.
- Both handlers run `validateSlug` before the link lookup, so an empty, malformed or reserved slug costs no KV get and no `links` select. Misses are not cached, so every SPA route or static file would otherwise cost both. `handleRedirectPost` calls `next()` for one. `handleRedirect` calls `next()` for one on the primary host, and on a custom domain sends it to the domain's `notFoundRedirect` like any unknown slug, at the cost of one `domain_config` read. No link can hold a reserved slug, but adding a slug to `RESERVED_SLUGS` after launch black-holes any existing link on it. `/favicon.svg` never reaches the Worker, so on a custom domain it serves the instance favicon instead of redirecting.
- `handleRedirectPost` reads the link from D1, since KV holds no hash, and answers 405 with `Allow: GET, HEAD` for a link without a password. It checks the expiry, internal and max-clicks gates before reading the password, and loads targets only once the password verifies.
- `chooseTarget` picks the highest-priority matching geo or device rule, and equal priorities keep stored order. A/B rolls only when no geo or device rule matched, even when the matched rule points at the link's own URL. `forwardParams` appends the request params the destination lacks to its raw query string and never re-serializes it.
- Targeting runs only once the request has a destination to show. A request stopped by the password gate never spends an A/B roll, and neither does a crawler on a protected link. A crawler on an unprotected link with OG fields rolls once for its meta refresh but records no click.
- 302s carry `Cache-Control: private, no-store`: expiry, `maxClicks`, A/B, geo and password gating decide the destination per request, so a cached 302 would replay the wrong one. 301s stay cacheable.
- Hono routes HEAD through the GET handler, so click tracking is guarded by `c.req.method === "GET"` and link checkers do not consume `maxClicks`.

### Analytics (`src/services/analytics.ts`)
- **Writes:** `trackClick()` in `redirect.ts` writes each click twice: to Analytics Engine (synchronous) and a daily-aggregate upsert into `link_stats` via `upsertDailyStats()` inside `waitUntil`, which always writes today's row. Every AE write goes through `writeClickEvent()`, whose comment documents the positional layout: index1=linkId, blob1=slug, blob2=country, blob3=user-agent, blob4=referer, blob5=city, blob6=destinationUrl, blob7=region. There are no doubles, since AE's own `timestamp` dates each event. blob6 is the chosen target before param forwarding, so `/ab` groups clicks by variant. Its two writers are `trackClick` via `requestVisitor(req)` and the demo cron in `src/scheduled.ts`. Every reader in `src/routes/api/stats.ts` must match the layout.
- **Reads:** `queryAnalyticsEngine(accountId, apiToken, sql)` POSTs to the Analytics Engine SQL REST API with `CF_ACCOUNT_ID` + `CF_API_TOKEN` and returns the `data` rows of the `{ meta, data, rows }` body. It throws on a non-2xx answer, with the response text in the message, and on a body with no `data` array. There is no read binding, and the token never reaches the client. `stats.ts` routes every AE read through its `withAE` helper, against the dataset named by the `AE_DATASET` var; `withAE` logs a failed query with `routePath(c)` and answers from the D1 fallback. The SQL API has no parameter binding, so every interpolated value is validated first.
- **Counts:** AE samples busy indexes, so every count is `SUM(_sample_interval)`, and unique visitors are `count(DISTINCT blob3)`.
- **Series:** `clickSeries` zero-fills buckets. A daily window runs from `statsCutoff(days)` through today, so it has `days + 1` points, and the hourly window has `hours + 1`. Weeks are Monday-start UTC weeks summed from daily rows in the Worker. The D1 fallback always returns daily buckets, whatever `period` asks for. `/summary`'s `topReferrer` comes from the same hostname aggregation as `/referrers`, so the two agree.

### Frontend (`frontend/src/` → `public/dist/`)
- Entry: `frontend/src/app.js`. Routing is a tiny homegrown router (`router.js`); views are plain functions that render into a root `HTMLElement`. Each navigation creates a fresh `<div>` inside `#main` and hands the view that div, so an async render that finishes late writes into a detached node instead of the live page. A view's root is never `#main` itself, so direct-child selectors keyed on `#main` would not match. `navigate(path)` replaces the history entry when `path` equals the current URL.
- `GET /api/me` is the only source of `currentUser`, and `app.js` passes it to `renderDashboard` (which forwards it to `renderTeamDetail`) and `renderSettings`. Outside demo mode `app.js` calls `authClient.getSession()` first, because that client call is the only request that rolls the session cookie. `/` and `/login` send a signed-in user to `/links` at route level, so `renderHome(container)` takes no user.
- Signed-out routes go through one `authed(view)` wrapper in `app.js`, which renders the login view in place, so the OAuth `callbackURL` is the current location. Anything that changes how unauthenticated routes render must leave the URL intact, or deep links break.
- `renderSettings(container, { user })` renders its shell synchronously, and each settings section loads, and reloads after a mutation, on its own. `renderTeamDetail` re-renders itself in place, passing the open tab back in so a refresh does not snap to the first tab; its `onTeamsChanged` fires only after a rename.
- Link detail, campaign detail and the campaigns panel keep their current markup while they refresh, showing the spinner only when the container is empty (a `childElementCount` guard), and render `errorCallout` when a load fails. During a post-edit refresh link detail also sets `inert` on its root, because the edit form still holds the pre-edit link.
- `public/index.html` is a static SPA shell, not built. Its header is `<header slot="header" id="nav">`, which `renderNavBar` fills. The bundle has no code splitting; the SPA has no dynamic import.
- Web Awesome Free components are imported individually (tree-shaken) from `@awesome.me/webawesome`, after three WA stylesheets in `app.js`: `styles/native.css` (resets plus native-element/table styling for light-DOM markup), `styles/themes/awesome.css` and `styles/utilities.css`. All three live in `@layer wa-*` and `app.css` is unlayered, so project rules always win regardless of import order.
- `frontend/src/auth-client.js` is the only place that talks to Better Auth from the browser, through the bundled `better-auth/client`; settings lists passkeys with `authClient.passkey.listUserPasskeys()`. A new passkey's nickname is stored with `updatePasskey` after `addPasskey()`, because `addPasskey({ name })` also sends the name as the WebAuthn account name the OS passkey picker shows.
- The SPA bundles three backend modules: `src/services/slug.ts` (`normalizeSlug`, `MAX_SLUG_LENGTH`) and `src/services/useragent.ts` (`DEVICE_TYPES`) through `components/link-form.js`, and `src/lib/limits.ts` (`BULK_MAX`) through `views/dashboard.js`. All three must stay import-free. esbuild runs with no target, so importing `validateSlug` would ship its `v`-flag regex literals as written.
- Charts use Chart.js and `chartjs-chart-geo` directly (no WA Pro chart components). The choropleth uses chartjs-chart-geo's `topojson` re-export and fetches `/data/countries-110m.json` (world-atlas 2.0.2, ISC) from the same origin.
- **Theme**: a `wa-light`/`wa-dark` class on `<html>`, which the inline script in `public/index.html` sets before first paint. `lib/theme.js` owns it afterwards: `toggleTheme()` stores an override in `localStorage` only when, at toggle time, it differs from the system preference, and a stored override survives a later system change that matches it. With nothing stored the page follows `prefers-color-scheme`, and it picks up a change made in another tab. Every change dispatches a plain `theme-change` Event, with no detail, on `document`.
- **Charts and theme**: WA re-reads the custom properties on its own, but Chart.js resolves colors at construction. `lib/chart-helper.js` themes `Chart.defaults` from the `--wa-color-*` tokens and caches the colors in `themeColors()`; never hardcode them. On `theme-change` it re-themes the defaults and updates every instance in `Chart.instances`. Build charts with `createChart()`, which first destroys every chart whose canvas has left the document, as a theme change also does, so a view can replace its markup without explicit teardown. It merges nothing into the config, because Chart.js merges per-chart options with the themed defaults.
- The `max-width: 480px` rule in `app.css` that hides a third table column is scoped to `#links-table`, the dashboard container in `views/dashboard.js`. Renaming that id silently disables the rule, and dropping the id from the selector would hide the third column of every `.link-table`. No test enforces this coupling. `bulk.test.ts` does enforce `BULK_MAX`: that many links succeed and one more answers 400.
- `components/link-form.js` exports only `bindLinkFormDialog(dialog, getOptions, onSaved)`. It renders the form on each `wa-show` and runs `onSaved` after a full save, or on `wa-after-hide` after a partial one. The form saves in two phases and holds state: once the link row exists it remembers the id, so any further submit is a `PUT`. A failed targets save keeps the dialog open.
- An edit sends `expiresAt`, `campaignIds` and `domainHostname` only when they differ from what the server holds, relying on the API treating an absent field as no change; a resent past expiry would fail the API's must-be-in-the-future check. It sends the two select fields only once their options have loaded. The targets `PUT` runs only when the normalized rule set differs from the saved one. Targeting rows carry native constraints, and the match control a type hides is also disabled, so an empty or malformed row blocks the submit.
- `renderLinkTable(container, { links, pagination, sort, onPageChange, onSort, empty, focusSort = false })` renders the link lists; callers must pass `empty`, the message shown when there are no rows. Sort headers are native `<button class="th-sort">` elements styled in `app.css` with `all: unset`.
- Internal anchors and fixed-path navigation buttons (`wa-button href="…"`) carry `data-link`, and one click delegate in `app.js` routes them. A button that only opens a dialog uses WA's declarative `data-dialog="open <id>"`. A row button that opens a shared dialog carries it too, plus `data-*` attributes; a `delegateClick` listener on the section container copies them onto the dialog, and runs before Web Awesome's document-level handler opens it.
- **Shared UI helpers** in `lib/ui.js`; reuse them instead of reinventing:
  - `apiFetch(url, { json, signal, ...init })` never rejects. It resolves to the parsed JSON, `{}` for a 2xx with no body, or `null` on an HTTP, network, parse or abort failure. `json` sets `Content-Type` and stringifies the body. A failure is toasted, a demo-mode 403 as a warning, and an abort resolves to `null` silently. A 401 reloads the page only when `/api/me` also answers 401, so `authed()` renders login in place on the same URL; a 401 under a live session is toasted. Callers write `if (!result) return;` with no `.catch` or `try`.
  - `withLoadingBtn(btn, fn)` manages loading state only and does not catch errors; `apiFetch` owns error reporting.
  - `renderTable({ label, columns, rows })` (object columns are `{ sortKey, html }`) builds every table. It emits `class="link-table"`, which `app.css` keys on, and the `data-sort` header attributes, so never hand-write a table scaffold.
  - `loadTableSection(el, { url, label, headers, renderRow, empty, error, onPageChange })` loads every paginated collection and owns its spinner, empty and error states. It aborts the previous load on the same element and returns null when superseded. An empty page past the first hands the previous page to `onPageChange` and returns null.
  - `renderPagination(container, { page, total, limit, onPageChange })` renders nothing unless `total > limit`. It wraps `wa-pagination` in a centered `wa-cluster` div because the component is `display: contents`.
  - `delegateClick(container, selector, fn(match, event))` handles clicks on matching elements rendered at any time. Bind it once per element: a view that renders itself again into the same container, such as the dashboard's `#teams-panel`, binds to an element that render created.
  - `afterClose(dialog, fn)` closes the dialog and runs `fn` after `wa-after-hide`, or at once if it is already closed, so a re-render never removes a dialog mid-animation.
  - `secretCallout({ variant, icon, value, copyLabel, before, after })` returns a callout with `value` in `<code class="secret-value">` beside a copy button. `variant`, `icon` and `value` are escaped; `before` and `after` are trusted markup.
  - `relativeTime(date, empty = "—")` returns `wa-relative-time` markup, or the escaped `empty` text when there is no date.
  - Also `shortUrl(link)` (domain-aware), `SPINNER`, `emptyState`, `errorCallout`, `statCard`, `bindConfirmDialog({ dialog, confirmBtn, onConfirm })`, `setTeamOptions(select, teams, { prefix, selected })` and `bindSearchInput`.
- Other shared modules:
  - `lib/chart-helper.js`: `createChart(canvas, type, config)`, `themeColors()` (rgba strings `text`, `subdued`, `border`, `surface`, `fill`, plus `brandRgb` as `"r, g, b"`; cached until the next theme change, so safe inside scriptable Chart.js options) and `clicksData(items, key = "name")`, one "Clicks" series.
  - `lib/theme.js`: `isDark()`, `toggleTheme()`.
  - `lib/stats-common.js`: `CHART_SKELETON` (a `wa-frame:landscape` div holding a `wa-skeleton`), `STAT_SKELETON`, `noData`, `fetchJSON(url, signal)`, `statsCard(title, body)`, `countryName(code)`, and `loadStatsCard(container, { title, url, signal, isEmpty, empty, error })`, which owns a card's skeleton, empty and error states and resolves to its data, or null once the card is final or the load aborted.
  - Stats components: `renderStatsCharts(container, linkId, { abContainer })` is synchronous and owns the period selector, the summary, every breakdown card and the A/B chart. `renderAbStats`, `renderStatsDevices`, `renderStatsGeo` and `renderStatsReferrers` take `(container, linkId, days, signal)`, and their modules export each card's loading markup (`AB_SKELETON`, `DEVICES_SKELETON`, `GEO_SKELETON`, `REFERRERS_SKELETON`).
  - `lib/config.js`: `getInstanceName()`, `isDemoMode()`, `getLoginOptions()` and `isPasskeyEnabled()`, valid once `loadConfig()` resolves. The login view renders synchronously from `getLoginOptions()`.
  - `components/toast.js`: `showToast(message, variant)`, and `showNotice(content, variant)` for a persistent notice that takes trusted markup. Both call `create()` on one lazily created `<wa-toast>`.
  - `lib/escape.js`: `escapeHtml(value)` is the single escaper for text and quoted attributes, and `escapeAttr` is an alias. Both turn null and undefined into `""`.
  - `auth-client.js`: `authClient`, and `isPasskeyCancel(error)`, true when the user dismissed, timed out or aborted a passkey ceremony.
  - `views/campaigns.js`: `campaignFields(campaign?)` and `campaignBody(form)`, the campaign form markup and its POST/PUT body, shared with campaign detail.
  - `components/`: `renderNavBar(container, user)`, `renderQrCode(container, shortUrl)`, `renderLinkTable` and `bindLinkFormDialog`.

### Environment & bindings (`wrangler.jsonc`)
`DB` (D1), `KV` (redirect cache, password-gate counters), `ANALYTICS` (Analytics Engine dataset `veer_clicks`), `ASSETS` (static site), and the `ratelimits` bindings `API_KEY_RATE_LIMITER` and `PUBLIC_REPORT_RATE_LIMITER` are all required. `compatibility_flags: ["nodejs_compat"]` is required: Better Auth imports `node:async_hooks`, and under the `workerd` condition its password module imports `node:crypto`, so the narrower `nodejs_als` flag is not enough. `compatibility_date` is capped at the newest date the workerd bundled with `@cloudflare/vitest-plugin` accepts; a later date makes `npm test` fail at startup.

A `ratelimits` `namespace_id` is an account-wide integer, and bindings with the same id share counters across Workers. The top level therefore uses 1001 and 1002 and `demo` uses 2001 and 2002. Named environments inherit no bindings, so `demo` declares its own `ratelimits` block.

`WORKER_NAME` must equal the Worker's `name`: domain sync lists the Workers Custom Domains attached to the Worker of that name. It does not list zone route patterns, so a hostname that reaches the Worker only through a route never syncs. `AE_DATASET` must equal the env's `analytics_engine_datasets` `dataset`, so a self-hoster who renames the dataset changes both.

The only provisioned environment is `demo`, which has its own D1/KV/AE resources and sets `DEMO_MODE=true`, `INSTANCE_NAME="Veer Demo"`, `AE_DATASET="veer_clicks_demo"` and a `demo.veer.ing` custom-domain route. It inherits `main`, `build`, `assets`, `triggers`, `observability` and the compatibility settings from the top level. `observability` sets `redact_query_string`, which keeps OAuth `code` and `state` values out of invocation logs. The top-level env is an unprovisioned template: its `BETTER_AUTH_URL` is a placeholder and no `veer` Worker, `veer-db` D1 or KV namespace exists yet, so a bare `npm run deploy` would create all of them from scratch. Provision them and set a real `BETTER_AUTH_URL` before deploying it.

Anything in `wrangler.jsonc` `vars` is emitted by `wrangler types` as a literal union of the configured values, so it must never be redeclared in `src/env.d.ts`. Only secrets and `.dev.vars`-only keys belong there, always as plain `string`.

Every command aimed at the demo instance takes `--env demo`; without it Wrangler resolves the top-level template and would create the unprovisioned resources. The npm D1 scripts address the database by binding `DB`, which Wrangler resolves to `veer-db` at the top level and `veer-db-demo` under `--env demo`. Deploy the demo in this order: `wrangler deploy --env demo`, then `wrangler d1 migrations apply DB --remote --env demo`, then `npm run seed:remote`.

The order matters for a migration that drops a column. The running Worker's Drizzle selects name every schema column and fail with `no such column` once it is gone, while the new Worker still runs against the old table if the column is nullable or has a default. A migration that adds a column the new code reads goes the other way: migrate, then deploy. Neither order is safe for a rename, so ship one as an added, backfilled column and drop the old column in a later release.

### Instance branding (`INSTANCE_NAME`)
`INSTANCE_NAME` is an optional plain `var` in `wrangler.jsonc`, not a secret, since it is public branding. Empty or unset falls back to `"Veer"`. Resolve it via `getInstanceName(env)` in `src/lib/branding.ts`. The SPA reads it from the public `GET /api/config`, which returns `{ instanceName, demoMode, providers, passkey }` with no envelope. `frontend/src/lib/config.js` fetches it once before the first render and caches it; `getLoginOptions()` returns `{ providers, passkey }`, or `null` when the fetch failed. `public/index.html` ships an empty `<title>` that `loadConfig()` fills in. The passkey `rpName` reads the resolved name at `getAuth()` time, so changing `INSTANCE_NAME` after passkey credentials exist only affects new registrations. Add future public knobs (logo URL, footer text, etc.) to `/api/config` rather than a new endpoint.

### Demo mode (`DEMO_MODE=true`)
Setting `DEMO_MODE=true` (plain `var` in `wrangler.jsonc`) turns the same codebase into a public read-only showcase. Resolve it via `isDemoMode(env)` in `src/lib/branding.ts`. Three things change:

1. **Auth is bypassed.** `sessionUser()` returns the synthetic `DEMO_USER` from `src/lib/demo.ts` (id `demo-user`, `isAdmin: false`), so `requireAuth` and `requireAuthOrApiKey` both resolve to it. No session row, no OAuth, no `/login` view. The SPA loads the same user from `GET /api/me` and skips `authClient.getSession()`.
2. **Non-GET `/api/*` requests return 403** with `{ error, demoMode: true }`. That includes `POST /api/auth/*`, since demo has no login flow. One middleware registered on `/api/*` after `trimTrailingSlash`, before any route mount, does this. Non-`/api/` writes like the `POST /:slug` password form pass through.
3. **An hourly cron** (`triggers.crons: ["0 * * * *"]`) wakes `src/scheduled.ts`, which returns early unless demo mode is on. In demo mode it writes 1-5 synthetic AE click events for each demo-user link that is unexpired and has no `maxClicks`, and adds the same count to today's `link_stats` row. The upserts run concurrently.

The SPA signals demo mode with a `.demo-mode` class on `<body>` and a persistent `showNotice()` toast. CSS keyed on `body.demo-mode` hides the top-level create buttons, and the nav bar omits the Logout item. Impersonation is skipped in demo mode, and any leftover impersonation flag is cleared.

`scripts/seed.ts` runs under plain Node type stripping (`node scripts/seed.ts`; `engines.node` is `^22.18.0 || ^24.0.0 || >=26.0.0`) and writes SQL to stdout. The npm scripts redirect it into `scripts/seed.generated.sql` (gitignored) and apply it with `wrangler d1 execute DB --file`. Every row uses a stable ID and `INSERT OR REPLACE`, so re-running replaces the fixture set rather than growing it. Fixtures cover the showcase surface: plain, password-gated (password is `demo`), expired, max-clicks-capped, A/B in a campaign, custom-domain and team-owned.

Rows are typed per table through `SeedRow`, built from a type-only import of `src/db/schema.ts` that Node erases, so a misspelt column, unknown table or missing required column fails the typecheck. An undefined value is left out, so the column takes its schema default. The seed imports `src/services/password.ts` and `src/lib/demo.ts` at runtime, so those modules may hold only `import type` imports and `.ts`-suffixed relative value imports. A type-only import uses `import type`, never an inline `import { type X }`: type stripping keeps the inline form as a runtime import, which fails on an extensionless path. tsc enforces neither rule under `moduleResolution: bundler`; `allowImportingTsExtensions` only permits the suffix.

### Directory map
```
src/
  index.ts              # Hono app + route wiring (named `app` export for tests)
  scheduled.ts          # Cron handler (demo synthetic clicks; no-op outside demo)
  types.ts              # AppEnv and AuthedEnv (Hono Bindings/Variables) + AuthUser
  env.d.ts              # Secrets/optional vars not in wrangler.jsonc (merged into Env)
  auth/index.ts         # Better Auth setup
  db/{index,schema}.ts  # Drizzle client + schema
  middleware/           # auth, rate-limit
  routes/
    redirect.ts         # /:slug hot path
    api/                # links, stats, campaigns, domains, keys, bulk, reports, teams, admin
  services/             # analytics, kv-cache, password, slug, useragent
  lib/                  # branding, crypto, csp, date, demo, errors, limits, link-access, providers, request, team, validators
frontend/src/
  app.js, router.js, auth-client.js
  views/                # one file per SPA screen
  components/           # render and bind modules for shared UI pieces (no custom elements)
  styles/, lib/
public/                 # SPA shell, _headers, favicon.svg, data/ (world atlas) + esbuild output (dist/)
drizzle/migrations/     # numbered SQL migrations (0000_initial.sql, …)
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
- Slugs are user-supplied and required. `src/services/slug.ts` only validates and normalizes; it never generates. **Never store or look up a raw slug**: run it through `validateSlug()` (which returns the canonical form) or `normalizeSlug()` first. The SPA bundles `slug.ts`, so it must stay import-free (see Frontend).
- When adding a table, update `src/db/schema.ts` and generate a migration. Tests pick it up automatically.
- When adding an AE field, update `ClickEvent` and the layout comment in `writeClickEvent()` (`src/services/analytics.ts`), both writers (`requestVisitor` and the `SYNTHETIC_VISITORS` entries in `src/scheduled.ts`), and every reader in `src/routes/api/stats.ts`.
- API routes that third-party integrations should reach go behind `requireAuthOrApiKey`, which also meters Bearer traffic, not `requireAuth`.
- `tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `npm run typecheck` fails on an unused local, import or parameter. Prefix an intentionally unused parameter with `_`.
- `tsconfig.json` sets `verbatimModuleSyntax` and `erasableSyntaxOnly`. Type-only imports must use `import type`, and enums, namespaces and parameter properties fail the typecheck.

### Frontend (Web Awesome)
- **Load the `webawesome` skill and verify every `wa-*` element against its docs before shipping.** WA has diverged from Shoelace; memory is unreliable. `.claude/skills/webawesome-design` is the matching design and layout skill. Both link into `node_modules`, so they resolve only after `npm install`.
- Shoelace renames to watch for: `start`/`end` not `prefix`/`suffix`, `with-clear` not `clearable`, `hint` not `help-text`, `brand` not `primary`, unprefixed `input`/`change` events. Set a `wa-select`'s initial value with `selected` on `wa-option` or `value` on the select.
- **Style hierarchy** (first available wins): WA utility classes (`wa-stack`, `wa-cluster`, `wa-split`, `wa-grid`, `wa-flank`, `wa-frame`, `wa-gap-*`, `wa-align-items-*`) → semantic tokens (`--wa-color-text-quiet`, `--wa-color-neutral-border-normal`) → custom CSS in `app.css` → inline `style`. Never write inline `display:flex`/`gap`/`align-items` when a WA utility exists, and never use numeric palette tokens (`--wa-color-neutral-300`).

### Backend (Workers)
- **Verify backend code against the `wrangler` and `workers-best-practices` skills** before considering work complete.
- API handlers await KV cache writes, so the cache is consistent before the response. Link create, single and bulk, is the exception and defers via `waitUntil`: no prior cache entry exists, and awaiting would fail a create whose D1 row already committed. Redirect-handler KV writes (cache fill on miss, password counter) also use `waitUntil`.
- Never cache secrets in KV. Use boolean flags (e.g. `hasPassword`, not the hash).
- Use Drizzle types for update objects: `Partial<typeof table.$inferInsert>`, not `Record<string, ...>`.
- Columns embedded in a raw `sql` fragment render unqualified (`"userId"`, not `"links"."userId"`) when the select has a single table. A correlated subquery written as ``sql`(SELECT count(*) FROM ${links} WHERE ${links.userId} = ${userTable.id})` `` therefore compares `links.userId` to `links.id` and silently returns 0. Bind the outer value (`${user.id}`) or qualify the outer column explicitly. For counts, use `db.$count(table, filter)`, which keeps both sides qualified.
- Sub-apps that `src/index.ts` mounts only behind `requireAuth` or `requireAuthOrApiKey` are `Hono<AuthedEnv>` (`src/types.ts`) and read `c.var.user` directly. `src/index.ts`, the middleware, `publicReportRoute`, `admin.ts` and `stats.ts` stay on `AppEnv`, where the variable is optional, so an authenticated handler there writes `c.var.user!`.

### Security
- Rate-limit all public endpoints that accept user input.
- Never leak protected data in API responses: password-protected links strip `destinationUrl` to `hasPassword: boolean`.
- Server-generated HTML (password gate, 403/410 message pages, OG meta page) is built with `hono/html`'s `html` tag and sent with `c.html` as `text/html; charset=UTF-8`. The tag escapes every interpolated string and inserts nested `html` fragments raw, so user input must never go through `raw()`.
- The CSP lives in `src/lib/csp.ts` as one directive array; anything added to the policy belongs there. The global `*` middleware in `src/index.ts` sets it with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`, and sets the CSP only when the handler set no policy of its own. That is how the password gate keeps its `PASSWORD_GATE_CSP`: Chrome enforces `form-action` across a submission's redirect chain, and the gate answers a correct password with a 302 off-origin. Never give the gate a `form-action`.
- The four files that skip the Worker get only `X-Content-Type-Options: nosniff` from `public/_headers`, and no CSP.
- `connect-src` is `'self' data: https://ka-f.fontawesome.com`: `wa-icon` fetches its default icon SVGs from the Font Awesome host and the system library's `data:` URIs. The choropleth's atlas is same-origin. `style-src` and `font-src` allow `https://fonts.bunny.net`, and `img-src` allows `data:` and any `https:` host.
- `script-src` carries one hash, of the exact text inside the inline theme script in `public/index.html`; regenerate it whenever that script changes. `test/integration/app.test.ts` fetches the shell through `ASSETS` and fails when any inline script's hash is missing from `script-src`.
- Hono `bodyLimit` in `src/index.ts` caps `/api/*` bodies at 10 KB, `/api/bulk/*` at 100 KB and `POST /:slug` at 4 KB, and leaves `/api/auth/*` uncapped. It counts streamed bodies without a `Content-Length` too, and answers 413 `Request body too large`.
- The public report endpoint 404s an internal link, and `POST`/`PUT /api/reports/:linkId` refuse to enable a report for one. An internal link's redirect requires a session, so its stats must not be reachable through a shareable token.
- Password hashing: PBKDF2-SHA256 (100k iterations, 16-byte salt) via Web Crypto; verify with `crypto.subtle.timingSafeEqual()`. Cloudflare's production runtime rejects PBKDF2 above 100,000 iterations, but local workerd has no cap, so no test catches a higher count. `verifyPassword` uses `Uint8Array.fromHex`. `hashPassword` also runs in the seed under Node, which lacks `Uint8Array.prototype.toHex`, so it keeps its hand-written `toHex`.

### Shared helpers (reuse, don't reinvent)
- Backend `src/lib/`:
  - `branding.ts`: `getInstanceName`, `isDemoMode`, `isPasskeyEnabled`.
  - `demo.ts`: `DEMO_USER`, `DEMO_USER_ID`, `DEMO_BLOCKED_MESSAGE`.
  - `limits.ts`: `BULK_MAX` (50 links per bulk request) and `CAMPAIGN_LINKS_MAX` (50 ids in `campaignIds` on a link write and in `linkIds` on `POST /api/campaigns/:id/links`; both answer 400 past the cap). Import-free, because the SPA bundles it.
  - `validators.ts`: `isHttpUrl`, `validateHttpUrl`, `parseOptionalHttpUrl`, `parseOptionalString(raw, fieldName)`, `parseName`, `parseDescription(raw)`, `parsePositiveInt(value, message)`, `parseExpiresAt`, `getPrimaryHostname`, `resolveDomainHostname`, `validateDomainAccess(db, hostname, email, isAdmin)`, `assertInternalAllowed`, `assertLinkQuota`. `parseLinkCore(raw, primaryHost)` returns a `LinkCore` and is the one sync parser for `slug`, `destinationUrl`, `domainHostname`, `isInternal`, `redirectType` and `title`, shared by link create and bulk; it runs before any D1 query.
  - `link-access.ts`: `accessibleLinks(userId)` is the SQL predicate for owned links plus current team links; never hand-write a second OR/subquery. `requireAccessibleLink(db, linkId, userId)` loads one link in one query and 404s whether it is missing or denied.
  - `team.ts`: `requireTeamMember(db, teamId, userId)` returns the member's role or 404s `Team not found`; `memberWithUser`.
  - `request.ts`: `parseJsonBody`, `parsePagination`, `parseDays` (30 when absent, invalid or below 1; capped at 90), `searchFilter(q, ...columns)` (escaped case-insensitive LIKE across columns, undefined for an empty query), `stripPassword`.
  - `errors.ts`: `badRequest`, `notFound`, `forbidden` and `conflict`, each requiring a message, and `isUniqueViolation(e)`.
  - `crypto.ts`: `hashApiKey`, `generateApiKey`.
  - `date.ts`: `HOUR_MS`, `DAY_MS`, `formatDate`, `formatHour`, `formatWeek`, `statsCutoff(days)`.
  - `providers.ts`: `getConfiguredProviders(env)`.
  - `csp.ts`: `CSP`, `PASSWORD_GATE_CSP`.
- `src/db/index.ts`: `getDb(d1)` and the `Database` type.
- `src/services/analytics.ts`: `writeClickEvent`, `requestVisitor(req)`, `upsertDailyStats(db, linkId, clicks)`, `sumClicks(db, linkId, since?)`, `clickSeries(rows, { start, end, step }, format)`, `dailyClickSeries(db, linkId, days)`, `queryAnalyticsEngine(accountId, apiToken, sql)`, and the `ClickSeries`, `Visitor` and `AERow` types.
- `src/services/kv-cache.ts`: `toCachedRedirect`, `loadCachedRedirect(db, link)`, `getCachedRedirect`, `setCachedRedirect`, `deleteCachedRedirect`, and the `CachedRedirect` and `CachedTarget` types.
- `src/services/slug.ts`: `validateSlug`, `normalizeSlug`, `MAX_SLUG_LENGTH`, `RESERVED_SLUGS`. `src/services/password.ts`: `hashPassword`, `verifyPassword`.
- `src/services/useragent.ts`: `parseDevice` is the single device classifier, shared by redirect device targeting and the stats device breakdown; never add a second one. `parseUserAgent(ua)` adds browser and OS for the stats breakdown. `DEVICE_TYPES` and `DeviceType` list the classes `parseDevice` returns. The module stays import-free, because the SPA bundles it.
- `src/middleware/rate-limit.ts`: `checkRateLimit(kv, prefix, limit, windowSecs)` returns `{ exceeded, secondsRemaining, count, hit }`, and `hit()` records the attempt. Also `checkPasswordRateLimit(kv, linkId, ip)`, `rateLimitPublicReport`, `rateLimited(c, limit)` and `API_KEY_LIMIT`.
- `src/middleware/auth.ts`: `requireAuth`, `requireAdmin`, `requireAuthOrApiKey`.
- Frontend: see the Frontend architecture section above.

### Tests
- New tests use the shared helpers in `test/helpers.ts` instead of inlining setup. They use the pool's env; none takes a `db` or `env` argument.
  - Requests: `api(method, path, { body, headers, env, ctx, cf })` binds the app and defaults to the test env. A string or `URLSearchParams` body is sent as is; any other body is JSON-encoded with `Content-Type: application/json`. `cf` becomes `request.cf`. Also `postLink(body, headers)`.
  - Users: `setupAuth(overrides)`, `newUser(label)`, `newAdmin(overrides)` (returns `{ user, headers, env }`, the env listing the user in `ADMIN_EMAILS`), `adminEnv(email)`, `createDemoUser()` (once per file) and `demoEnv`.
  - Fixtures: `createTestLink`, `createTestDomain`, `createDomainAccess(hostname, email)`, `createTestTeam(userId, role)`, `addTestTeamMember`, `removeTestTeamMember(teamId, userId)`, `createTeamLink(memberId)` (a team whose fresh admin owns one link, with `memberId` as a plain member), `insertClickStat(linkId, clicks, date)`.
  - Assertions and values: `totalClicks(linkId)`, `expectSpaShell(res)`, `isoDaysAgo`, `dayLabel`, `cachedRedirect`, `uniq`, `fakeLimiter(success = true)`, `mockExecutionCtx`.
- Fixtures insert through Drizzle with `Partial<typeof table.$inferInsert>` overrides, so schema defaults apply and `createTestLink({ expiresAt })` takes a `Date`. `setupAuth` overrides are user columns: `emailVerified` defaults to true, the email to `${id}@example.com`, and a duplicate email throws because `user.email` is unique. `uniq()` is unique within a test file only, which is enough because storage is per file.
- A test that asserts on `link_stats` after a redirect sums by link with `totalClicks` instead of filtering on a test-side date. A fall-through assertion uses `expectSpaShell`, since a bare `Location` check also passes on a 500.
- `mockExecutionCtx()` is a `cloudflare:test` execution context whose `waitUntil` swallows rejections, so `waitOnExecutionContext` accepts it but has nothing to rethrow. A test that asserts on a background KV or D1 write must pass its own `createExecutionContext()` (via `api(..., { ctx })` or `app.request(path, init, env, ctx)`) and `await waitOnExecutionContext(ctx)`, which also rethrows a rejected background task. Otherwise it races the write.
- The pool runs the real Rate Limiting bindings from `wrangler.jsonc`, so a test that sends more than 60 Bearer requests per key, or 30 public-report requests per IP, within a minute gets 429. A test that needs a specific limiter answer passes `fakeLimiter(success)` through the per-request env, e.g. `{ ...env, API_KEY_RATE_LIMITER: fakeLimiter(false) }`.
- `vitest.config.ts` sets `restoreMocks: true`, so tests do not add `afterEach(() => vi.restoreAllMocks())`. It does not undo `vi.setSystemTime`, so a test that freezes `Date` still calls `vi.useRealTimers()`.
- Unauthenticated 401 coverage lives in one `it.each` matrix in `test/integration/auth.test.ts`, one row per auth mount, plus `admin.test.ts`'s own matrix. A new authenticated mount needs a row there.
- `tsconfig.json` sets `"types": ["@cloudflare/vitest-plugin/types"]`, which is what makes the `cloudflare:test` module visible to `tsc`.
- `tsconfig.json` typechecks `scripts/**`, and the repo has no Node types. `scripts/seed.ts` and the modules it imports (`src/services/password.ts`, `src/lib/demo.ts`) therefore use only globals such as `crypto` and `console`, with no `node:` import; keep it that way or the typecheck breaks.

## Design decisions

The rationale behind choices that look odd. Read these before "cleaning up" anything here.

### Auth & API keys
- **Admin from the `ADMIN_EMAILS` env var, not a DB column**: ops rotate admins by redeploying, with no migration or role column.
- **API keys hashed with HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`, not plain SHA-256**: prevents offline brute-force if D1 is dumped, since the attacker needs the secret too.
- **Key format `veer_` + 43 base62 chars**: ~256 bits of entropy and a grep-able prefix for secret scanners.
- **`getAuth()` cached in a `WeakMap` keyed on `env`**: Better Auth is expensive to construct, so it is built once per `env` object rather than per call.
- **Better Auth cookie session cache (5 min)**: cuts D1 session lookups for browser traffic. The 5 minutes is Better Auth's default `maxAge`. The staleness window is acceptable because logout clears the cookie.
- **Single-provider auto-redirect on login**: when exactly one OAuth provider is configured and passkey is disabled, the login view renders its heading with a "Redirecting to …" notice and starts OAuth at once. If starting OAuth fails, it falls back to the provider button.
- **Impersonation is client-side only**: `POST /api/admin/impersonate/:userId` echoes the target and logs the event, `stop-impersonate` echoes the admin, and the SPA keeps a `sessionStorage` flag that shows a banner. The session never switches, so every API call still runs as the admin. Server-side session switching was rejected to keep the security surface small.

### Domains
- **Admin-synced from the Cloudflare API, not user DNS verification**: Cloudflare already knows which Custom Domains attach to this Worker, so a TXT-record dance is redundant.
- **`domain_config.hostname` is the primary key (no UUID)**: links reference `domainHostname` directly, so the redirect hot path needs no join.
- **Domain sync deletes links on a hostname Cloudflare no longer routes**: `POST /api/domains/sync` removes the `domain_config` row *and* its links, purging their KV entries first. The FK is `ON DELETE SET NULL`, so leaving the links would silently move them onto the primary host, where the partial unique index can reject them and fail every later sync.
- **Domain sync purges at most `SYNC_KV_PURGE_MAX` (500) KV entries per run**: a Worker invocation gets 1,000 KV operations. Entries past the cap stay on a host that no longer routes here and expire with the cache TTL. The purge select binds at most `SYNC_PURGE_SELECT_CHUNK` (90) removed hostnames per statement, to stay under D1's 100-parameter cap.
- **`domain_config` holds a row for the primary host, but nothing applies its redirects or access mode**: the row exists so `GET /api/domains` can list the primary host, marked `isPrimary`. `requestHost` treats the primary host as having no domain, and create, update and bulk collapse the primary hostname to a NULL `domainHostname`. Settings shows no Edit button on that row, and a client picking a custom domain hides `isPrimary` rows.
- **Internal links are only allowed on the default domain**: the session cookie is host-only to the primary host, so an internal link on a custom domain would always 403. Create, update and bulk reject it rather than failing at redirect time.
- **`PUT /api/links/:id` access-checks a domain only when the link moves**: a teammate without access to a restricted domain can still edit a link already on it.

### Teams & shared access
- **Access is checked against current membership, not the association row**: `link_campaigns` rows outlive a user's access to the link, so campaign detail and campaign stats filter through `accessibleLinks(userId)` instead of trusting the association. The row itself is left intact.
- **Campaigns are private to their owner**: `GET /api/links/:id` lists only the caller's campaigns, and `PUT /api/links/:id` with `campaignIds` replaces only the caller's own `link_campaigns` rows, so teammates keep their associations on a shared link.
- **The invite route deletes expired invites for the same team + email before inserting**: the unique index on `team_invites(teamId, email)` means an expired invite still occupies the slot and would reject the new one. The delete runs in the same batch as an `onConflictDoNothing` insert, and the insert is the duplicate check. Any future invite path must do the same.
- **Writes that must not race are insert-first**: the invite insert, the `accept-invite` membership insert and the `POST /api/reports/:linkId` insert each use `onConflictDoNothing`, so two concurrent requests cannot both win.
- **`GET /api/teams/:id/invites` returns the invite token**: the route is team-admin-only, and the token is a re-copyable invite link, not a credential of the requester. Do not strip it in a blanket "never return tokens" cleanup.
- **No user-deletion path exists**: enabling Better Auth's `user.deleteUser` or its admin plugin must add team cleanup, because the `team_members` cascade can leave a team with no admin.

### Slugs
- **Slugs are stored normalized (percent-decoded → NFC → lowercased), not folded at query time**: one canonical form in the database lets the existing unique indexes enforce case-insensitive uniqueness, and the redirect hot path stays a plain equality lookup. A `COLLATE NOCASE` index was the alternative, but SQLite's NOCASE only folds ASCII, which would have left `/CAFÉ` and `/café` as separate links.
- **Non-ASCII slugs are allowed**: a path segment is an IRI segment (RFC 3987), and browsers percent-encode it on the wire, so `/🎉` works. The ASCII character set is RFC 3986 `pchar` minus `%` (ambiguous once escapes are decoded) and `/ ? #` (they end the segment). A slug may hold any RGI emoji sequence, flags, skin tones and tag sequences included, except the `#` keycap, whose `#` would end the segment.
- **`validateSlug` strips emoji sequences before the character-class check**: one regex that alternates the class with `\p{RGI_Emoji}` backtracks exponentially when a slug fails. It tests the class on the raw slug first and strips emoji only when that fails.
- **`MAX_SLUG_BYTES` (256) exists on top of `MAX_SLUG_LENGTH` (128)**: the KV cache key is `{hostname}:{slug}`, and KV caps keys at 512 bytes. Only non-ASCII slugs can hit the byte cap first (an emoji costs 4 bytes).

### Redirect hot path
- **KV stores `hasPassword: boolean`, not the hash**: verification always reads D1, so a KV dump can't expose password hashes.
- **`maxClicks` always queries D1, never the cache**: a cached counter would let clicks overrun the limit. The cap is still soft: the read and the `waitUntil` increment are not atomic, so concurrent clicks can slightly exceed it.
- **The password gate is self-contained HTML** (no SPA, no WA components, inline CSS with `prefers-color-scheme`): the redirect path can't afford to boot the SPA, and the form must work without JS.
- **Slug is immutable after creation**: editing it would require a KV cache migration and break existing inbound links.
- **No Smart Placement**: with `run_worker_first`, every redirect and every SPA shell request would first travel to the placed Worker, and the shell would come from there through the `ASSETS` binding. A KV-cached redirect reads D1 only for a `maxClicks` link and writes it in `waitUntil`, so it gains little from running near the database.

### Analytics & stats
- **`link_stats` coexists with Analytics Engine**: AE retains detailed per-click events for ~90 days, and `link_stats` holds permanent daily aggregates so lifetime totals survive. Stats endpoints fall back only when AE is unreachable, meaning missing `CF_ACCOUNT_ID`/`CF_API_TOKEN` or a failed query. Timeseries and summary then read `link_stats`; geo, device, referrer and variant endpoints return empty data, since D1 holds no such breakdown. Every fallback response carries `fallback: true`. An empty AE result is reported as-is.
- **Every click writes both stores from `trackClick()`**: AE synchronously for detail, and a `waitUntil`-deferred `upsertDailyStats()` into `link_stats` for permanence. Don't remove the D1 write: `maxClicks` and lifetime totals read `link_stats`.
- **`link_stats` holds no unique count**: per-request code cannot know uniqueness, so unique visitors come only from AE's `count(DISTINCT blob3)` (distinct user-agents), and the D1 fallback reports none. Do not re-add the column.

### Bulk & public reports
- **Bulk create is two-phase: validate all, then batch-insert**: per-item error reporting requires the full validation pass before any write. The per-item format checks run first, then the team membership and quota checks, then the domain access checks, which are cached per request. A per-item error reports the canonical slug once `validateSlug` accepts it, and the raw input otherwise.
- **Bulk inserts go through one `db.batch()`**: the batch is atomic, so any failing row rolls the whole set back and every item reports `Insert failed (batch rolled back)`, with the failure logged as JSON under the message `Bulk insert failed`. Each insert uses `returning()`, and the returned rows build the KV entries. Per-item errors come from the validation pass that runs before it, including intra-batch duplicate slugs. Max `BULK_MAX` (50) links, 100 KB body.
- **Report access is link access, not link ownership**: `GET`/`POST`/`PUT /api/reports/:linkId` all go through `requireAccessibleLink`, so a team member of a team-owned link can manage its public report. `GET` is read-only and answers `{ data: null }` when no report exists rather than creating one.
- **One public report per link** (`linkId` is the primary key of `public_reports`): tokens are shareable and persistent, and more than one per link would confuse the UX.
- **Report tokens are `rpt_` + `crypto.randomUUID()` with dashes stripped**: 122 bits of entropy, enough for public tokens.

### Rate limiting
- **All rate limits are advisory**: the Rate Limiting binding counts per Cloudflare location and is eventually consistent, and the KV password counter lacks atomic increment, so concurrent requests can exceed any limit. That is good enough for abuse prevention.
- **The password gate stays on KV**: its 15-minute window exceeds the binding's longest period of 60 seconds.
- **Session requests bypass rate limits**: the browser UI is rate-limited by human behavior, and strict limits cause UX issues in normal use. Only Bearer traffic is metered. `test/unit/rate-limit.test.ts` asserts that session traffic on `/api/teams` and `/api/links` never calls `API_KEY_RATE_LIMITER`, and neither does a non-Bearer `Authorization` header such as Basic; neither sets `X-RateLimit-Limit`.
- **The `API_KEY_RATE_LIMITER` key is the first 16 chars of the token**: it identifies the key without passing the secret to the binding.

### Frontend
- **Bundled `better-auth/client`, no esm.sh import map**: the `jose` dependency breaks under esm.sh's CDN resolver. Bundling with esbuild is the only stable path.
- **The impersonation banner renders into `wa-page`'s `banner` slot**: the slot is sticky above the header and reserves its own space, so nothing has to measure the banner and pad the body.

### Demo mode
- **Synthetic user via middleware, no Better Auth session**: `sessionUser()` in `src/middleware/auth.ts` returns `DEMO_USER` directly, which is cheaper than maintaining a real session. Only the demo seed inserts a matching `user` row, because the fixtures' foreign keys need it.
- **The cron stays registered for non-demo deploys**: `triggers.crons` is in the top-level `wrangler.jsonc`, and the scheduled handler returns early when `DEMO_MODE` is unset. That is cleaner than per-env triggers, at the cost of one cheap no-op invocation per hour on non-demo deployments.
- **Seed re-runs are idempotent through the FK cascade**: `INSERT OR REPLACE` on a parent deletes the conflicting row first, and D1 runs the `ON DELETE CASCADE` actions, so replacing a `links` row clears its `link_stats` and `link_targets`. That keeps the 90-day window from accumulating a trailing edge on a later calendar day. It also fixes the ordering: children must be emitted after their parent, or the parent's replacement wipes them.
- **The seed hashes the demo password with the runtime's `hashPassword`** from `src/services/password.ts`, so the seeded hash always matches the runtime's parameters and `salt:hash` format.
- **Demo state is a `body.demo-mode` class plus CSS, not per-view JS guards**: the campaign and team create buttons hide by id, and the links button group hides via `:has(#new-link-btn)`. Detail-page edit/delete buttons stay clickable and surface the demo 403 as a warning toast through `apiFetch`.
