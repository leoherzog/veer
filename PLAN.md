# Veer - URL Shortener Implementation Plan

## Context

Veer is a self-hostable URL shortener built on Cloudflare Workers. The goal is a clean, modular product that anyone can `git clone`, configure OAuth secrets via `.dev.vars` / `wrangler secret set`, and deploy with `wrangler deploy`. The architecture uses one Worker, one D1 database, one KV namespace, and one Analytics Engine dataset. The UI is an esbuild-bundled JS SPA using Web Awesome components, with Better Auth handling OAuth.

The canonical domain is `veer.ing` (redirects to the GitHub repo). Self-hosters configure their own domain(s)/routes.

This plan covers the full FEATURES.md scope across 8 milestones, starting with a minimal working core and layering features incrementally.

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Router | **Hono v4.x** | Lightweight, Workers-native, middleware support |
| Database | **D1** via **Drizzle ORM v0.45.x** | SQLite provider, migration tooling via drizzle-kit |
| Cache | **KV** | slug -> {url, redirectType} mapping, sub-ms edge reads |
| Analytics | **Analytics Engine** | Per-click events (90-day write via binding, read via REST SQL API) |
| Stats (permanent) | **D1 `link_stats`** | Daily aggregate clicks, survives beyond AE 90-day retention |
| Auth | **Better Auth v1.5.5** | Drizzle adapter, conditional OAuth + passkey from env vars |
| UI | **Web Awesome v3.3.1** | npm package, bundled via esbuild, `wa-` prefix, 50+ components |
| Charts | **Chart.js v4.x** | Direct usage with theme-aware wrapper, canvas-based rendering |
| Theme | **Awesome** | Bright palette, Purple brand color, light/dark mode via `wa-light`/`wa-dark` |
| Icons | **Font Awesome Free** 7.2.0 | Via Web Awesome's built-in CDN resolver (`ka-f.fontawesome.com`) |
| Frontend | **JS SPA** | ES modules, History API router, esbuild bundled |
| Build | **esbuild** | Bundles `frontend/src/` → `public/dist/`, minimal config |
| Config | **wrangler.jsonc** | JSON schema, assets binding with `run_worker_first: true` |

---

## Directory Structure

```
veer/
  .dev.vars                    # OAuth + AE secrets (gitignored)
  .dev.vars.example            # Template for required env vars
  .gitignore
  package.json
  wrangler.jsonc               # Worker config: D1, KV, Analytics Engine, Assets
  tsconfig.json
  drizzle.config.ts            # Drizzle Kit config for D1 migrations
  src/                         # Worker source (TypeScript)
    index.ts                   # Hono app entry point ✅
    bindings.ts                # Env type definition ✅
    types.ts                   # AppEnv + AuthUser types ✅ (added in M1)
    db/
      schema.ts                # All Drizzle table definitions ✅
      index.ts                 # drizzle(env.DB) factory ✅
    auth/
      index.ts                 # Better Auth factory (per-request, conditional providers) ✅
    routes/
      redirect.ts              # GET /:slug - the redirect engine ✅
      api/
        auth.ts                # /api/auth/* passthrough + /api/auth/providers ✅
        links.ts               # /api/links CRUD + PATCH /:id/active ✅
        stats.ts               # /api/stats/* analytics (M2)
        campaigns.ts           # /api/campaigns (M4)
        domains.ts             # /api/domains sync + config + access (M5) ✅
        keys.ts                # /api/keys (M6)
        bulk.ts                # /api/bulk (M6)
        teams.ts               # /api/teams (M7)
        admin.ts               # /api/admin (M7)
        setup.ts               # First-run setup (M8)
    middleware/
      auth.ts                  # Session check, injects user into c.var ✅
      cors.ts                  # CORS config for /api/* ✅
    services/
      kv-cache.ts              # KV read/write/invalidate helpers ✅
      analytics.ts             # AE write (binding) + query (REST SQL API) helpers ✅
      slug.ts                  # Slug validation (custom slugs only, no generation) ✅
    lib/
      constants.ts             # SLUG_PATTERN, RESERVED_SLUGS ✅
      errors.ts                # Typed HTTP error helpers (badRequest, notFound, conflict) ✅
      providers.ts             # OAuth provider detection helper ✅ (added in M1)
  frontend/                    # Frontend source (ES modules)
    src/
      app.js                   # Main SPA: router init, auth state, rendering ✅
      router.js                # Client-side History API router ✅
      auth-client.js           # better-auth createAuthClient wrapper (bundled) ✅
      lib/
        escape.js              # HTML/attribute escaping utilities ✅ (added in M1)
        chart-helper.js        # Theme-aware Chart.js wrapper ✅
        stats-common.js        # Shared stats utilities (skeleton, noData, fetchJSON) ✅
      views/
        home.js                # Landing / quick shorten ✅
        dashboard.js           # Link list (authenticated) ✅
        link-detail.js         # Single link + stats ✅
        login.js               # OAuth provider buttons (dynamic from /api/auth/providers) ✅
        settings.js            # Settings: domains (M5) ✅, API keys (M6)
        campaigns.js           # Campaign management (M4)
        admin.js               # Admin panel (M7)
      components/
        link-form.js           # Create/edit link form ✅
        link-table.js          # HTML table + WA styling + pagination ✅
        stats-charts.js        # Chart.js line/bar/doughnut charts (M2)
        nav-bar.js             # Top nav with user avatar, login/logout, theme toggle ✅
        toast.js               # wa-callout-based toast notification helper ✅
      styles/
        app.css                # Custom styles on top of WA theme ✅
    esbuild.mjs                # Build config: bundles src/ → public/dist/ ✅
  public/                      # Static assets + build output (served by Workers Assets)
    index.html                 # SPA shell (loads dist/app.js)
    dist/                      # esbuild output (gitignored)
  drizzle/
    migrations/                # Generated SQL migration files
```

## Routing Architecture (Critical)

`run_worker_first: true` means the Worker handles ALL requests. Hono routing priority as implemented in `src/index.ts`:

1. Global: security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) on all responses
2. `/api/*` - CORS middleware
3. `/api/auth/*` - Better Auth handler (no auth middleware — handles its own)
4. `/api/me`, `/api/links`, `/api/links/*` - `requireAuth` middleware applied
5. `/api/me` - Current user profile
6. `/api/links/*` - Link CRUD routes
7. `/:slug` - Redirect lookup (KV → D1 fallback) — calls `next()` on miss to fall through
8. `*` catch-all - `env.ASSETS.fetch(request)` serves SPA shell

The slug handler checks KV first (sub-ms, `cacheTtl: 30`), falls back to D1 on miss, writes KV on hit (`expirationTtl: 86400`). Inactive links in KV are skipped (fall through). If no slug found, falls through to SPA shell (which shows 404 client-side).

## Better Auth Configuration Pattern

```typescript
// src/auth/index.ts - created per-request with env bindings
// Provider detection extracted to src/lib/providers.ts (getConfiguredProviders)
// Passkey plugin loaded conditionally via PASSKEY_ENABLED env var
export function getAuth(env: Env) {
  const providers = getConfiguredProviders(env);  // Map<ProviderId, {clientId, clientSecret}>
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const [id, creds] of providers) {
    socialProviders[id] = creds;
  }
  const origin = env.BETTER_AUTH_URL;
  const rpID = new URL(origin).hostname;
  const plugins = [];
  if (env.PASSKEY_ENABLED === "true") {
    plugins.push(passkey({ rpID, rpName: "Veer", origin }));
  }
  return betterAuth({
    database: drizzleAdapter(getDb(env.DB), { provider: "sqlite" }),
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    socialProviders,
    trustedOrigins: [origin],
    plugins,
  });
}
```

The `getConfiguredProviders()` helper iterates `["google", "github", "microsoft", "discord"]` and checks for `{PROVIDER}_CLIENT_ID` + `{PROVIDER}_CLIENT_SECRET` env vars. It's also used by `GET /api/auth/providers` to return the list of available providers to the frontend login view. The providers endpoint also returns `passkey: true/false` based on `PASSKEY_ENABLED`.

All auth methods (OAuth providers and passkey) are conditionally enabled — the login page only renders buttons for methods that are configured. If nothing is configured, the login page shows an administrator notice instead.

Client-side auth is bundled via esbuild (resolves `better-auth/client` from node_modules):
```javascript
// frontend/src/auth-client.js
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";
export const authClient = createAuthClient({ plugins: [passkeyClient()] });
```

## Theming: Awesome + Light/Dark Mode

Veer uses the **Awesome** theme with the **Bright** color palette and **Purple** brand color. Awesome provides a vibrant, modern look suitable for dashboards and tools.

### Setup

The theme CSS is imported via esbuild from npm. The `<html>` element receives both the theme and palette classes:

```html
<html class="wa-theme-awesome wa-palette-bright wa-brand-purple wa-light" lang="en">
```

**Theme + utilities import** (in `frontend/src/app.js`, bundled by esbuild):
```js
import '@awesome.me/webawesome/dist/styles/themes/awesome.css';
import '@awesome.me/webawesome/dist/styles/utilities.css'; // layout (wa-stack, wa-split, wa-cluster, wa-grid, wa-flank, wa-frame), gap, align-items, border-radius, text
```

### Light/Dark Mode

WA handles light/dark mode via CSS classes on `<html>`:
- **Light**: `class="wa-theme-matter wa-palette-mild wa-light"`
- **Dark**: `class="wa-theme-matter wa-palette-mild wa-dark"`

Toggle by swapping `wa-light` ↔ `wa-dark` on `document.documentElement`. All WA components (including charts) automatically re-render with updated colors — no extra code needed. Chart colors are derived from CSS custom properties (`--fill-color-*`, `--border-color-*`, `--grid-color`) that the theme redefines per mode.

The user's preference is persisted to `localStorage` and initialized from `prefers-color-scheme` on first visit:

```js
// frontend/src/app.js
const root = document.documentElement;
const saved = localStorage.getItem('theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
root.classList.add(saved || (prefersDark ? 'wa-dark' : 'wa-light'));
```

A toggle button in the nav bar swaps the class and saves the preference. This is wired up in M1 and refined in M8 with a dedicated settings toggle.

### Key Design Tokens

| Token | Value |
|-------|-------|
| `--wa-color-brand-fill-loud` | Purple brand (buttons, active states) |
| `--wa-color-surface-default` | White (light) / dark surface (dark) |
| `--wa-color-surface-raised` | Raised surface — cards, panels |
| `--wa-color-text-normal` | Default text color |
| `--wa-color-text-quiet` | Secondary/muted text |
| `--wa-color-neutral-border-normal` | Default border color |

---

## Milestone 1: Core Foundation — COMPLETE

**Delivers**: Working URL shortener with auth, link CRUD, redirects, basic click counting.

**Status**: All files implemented and frontend builds successfully (`public/dist/` populated).

### Database Schema

**Better Auth tables** (generated via `npx auth@latest generate`):
- `user` (id, name, email, emailVerified, image, createdAt, updatedAt, role)
- `session` (id, expiresAt, token, ipAddress, userAgent, userId, createdAt, updatedAt)
- `account` (id, accountId, providerId, userId, accessToken, refreshToken, ...)
- `verification` (id, identifier, value, expiresAt, createdAt, updatedAt)
- `passkey` (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, transports, createdAt, aaguid) — via `@better-auth/passkey` plugin, conditional on `PASSKEY_ENABLED`

**Application tables**:
- `links` (id TEXT PK, userId FK, slug TEXT UNIQUE, destinationUrl TEXT, redirectType INT DEFAULT 302, title TEXT?, createdAt INT, updatedAt INT, isActive INT DEFAULT 1)
  - Indexes: `idx_links_slug` (unique), `idx_links_userId`
- `link_stats` (id INT PK, linkId FK, date TEXT 'YYYY-MM-DD', clicks INT DEFAULT 0, uniqueClicks INT DEFAULT 0)
  - Index: `idx_link_stats_linkId_date` (unique composite)

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| * | `/api/auth/*` | -- | Better Auth (login, callback, session, logout) |
| GET | `/api/auth/providers` | -- | List configured OAuth providers |
| GET | `/api/links` | Yes | List user's links (`?page=&limit=&q=`) |
| POST | `/api/links` | Yes | Create link `{destinationUrl, slug, redirectType?, title?}` (slug required) |
| GET | `/api/links/:id` | Yes | Get link details + total clicks |
| PUT | `/api/links/:id` | Yes | Update link (destination, redirectType, title — slug is immutable) |
| PATCH | `/api/links/:id/active` | Yes | Toggle `isActive` (invalidates/repopulates KV) |
| DELETE | `/api/links/:id` | Yes | Delete link + purge KV |
| GET | `/api/me` | Yes | Current user profile |
| GET | `/:slug` | No | Redirect (KV -> D1 fallback, write analytics, increment stats) |

### KV Cache Design
- Key: slug string (e.g. `"abc123"`)
- Value: JSON `{"url":"https://...","redirectType":302,"linkId":"xxx","isActive":true}`
- Write-through on create/update/activate, delete on delete/deactivate
- Read with `cacheTtl: 30` for edge caching
- Write with `expirationTtl: 86400` (24h TTL)

### Analytics Engine Data Points (Write via Binding)
- `indexes`: `[linkId]`
- `blobs`: `[slug, country, userAgent, referer, city, destinationUrl, region]`
- `doubles`: `[Date.now()]`
- Country/city/region from `request.cf.country` / `request.cf.city` / `request.cf.region`
- Click stats upserted to `link_stats` D1 table via `c.executionCtx.waitUntil()`

### Analytics Engine Querying (Read via REST SQL API)
- Endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/analytics_engine/sql`
- Auth: `Authorization: Bearer {API_TOKEN}`
- Requires secrets: `CF_ACCOUNT_ID` (env var) + `CF_API_TOKEN` (wrangler secret)
- Worker-side only; token never exposed to client
- Falls back to `link_stats` D1 table for data older than 90 days

### SPA Views (Milestone 1)
- **Login** - OAuth + passkey buttons (conditionally shown based on `GET /api/auth/providers`; shows admin notice if none configured)
- **Dashboard** - Link list with wa-copy-button, pagination, search
- **Link Detail** - Edit form, total click count, delete
- **Home** - Create link form with required slug field (authenticated) or marketing splash (unauthenticated)

### Key Files
- `wrangler.jsonc` - D1, KV, Analytics Engine, Assets bindings
- `src/index.ts` - Hono app: mount routes, middleware, SPA fallback
- `src/db/schema.ts` - All Drizzle tables
- `src/auth/index.ts` - Better Auth factory with conditional providers (Google, GitHub, Microsoft, Discord) + passkey plugin
- `src/routes/redirect.ts` - Core redirect engine
- `src/services/kv-cache.ts` - KV helpers
- `src/services/analytics.ts` - AE write (binding) + query (REST API) helpers
- `src/services/slug.ts` - Slug validation only (custom slugs required, no generation)
- `frontend/esbuild.mjs` - Build config: bundles frontend/src/ → public/dist/
- `frontend/src/app.js` - SPA orchestrator
- `frontend/src/router.js` - History API client-side router
- `frontend/src/auth-client.js` - better-auth/client wrapper (bundled from npm)
- `public/index.html` - SPA shell (loads dist/app.js, WA components bundled)

### Verification
1. `wrangler dev` -> `http://localhost:8787` shows SPA shell
2. OAuth login flow completes successfully
3. Create link via UI -> appears in dashboard with short URL
4. Visit short URL -> redirects to destination with correct status code (301/302)
5. Link detail shows click count incrementing
6. Edit destination -> next redirect goes to new URL
7. Delete link -> short URL returns "not found"
8. `wrangler deploy` succeeds

### Implementation Notes

**Implemented 2026-03-10. All M1 files complete.**

#### Deviations from plan
- **`src/types.ts` added** — Defines `AuthUser` and `AppEnv` types (shared Hono env). Not in original directory listing but referenced throughout.
- **`src/lib/providers.ts` added** — Extracted OAuth provider detection into a reusable `getConfiguredProviders()` function returning a `Map<ProviderId, ProviderCredentials>`. Used by both `src/auth/index.ts` and `src/routes/api/auth.ts` (for the `/api/auth/providers` endpoint).
- **`frontend/src/lib/escape.js` added** — HTML/attribute escaping utilities for safe DOM rendering in the SPA views.
- **`PATCH /api/links/:id/active` added** — Toggle `isActive` endpoint not in original plan. Invalidates KV cache on deactivate, re-populates on activate.
- **Auth factory** uses `getConfiguredProviders()` helper + `trustedOrigins: [env.BETTER_AUTH_URL]` (not in plan snippet).
- **KV cache stores `isActive` flag** — `CachedRedirect` includes `isActive` boolean. Redirect engine checks it to avoid serving inactive links from cache.
- **KV write-through uses 24h TTL** — `expirationTtl: 86400` on `kv.put()`, with `cacheTtl: 30` on reads.
- **Request body size check** — Links create/update endpoints reject `Content-Length > 10KB` with 413.
- **Search escapes SQL wildcards** — `%` and `_` in search queries are escaped before `LIKE`.
- **`uniqueClicks` not yet tracked** — `incrementClickStats` sets `uniqueClicks: 0` with a TODO for IP-hash or cookie-based deduplication in a future milestone.
- **Observability enabled** — `wrangler.jsonc` includes `observability` block with 100% log sampling and 1% trace sampling.
- **Passkey support added** — `@better-auth/passkey` plugin conditionally loaded when `PASSKEY_ENABLED=true`. Passkey table added to `0000_initial.sql`. Login view shows "Sign in with passkey" button only when enabled. Passkey registration deferred to settings page (M6).
- **Session table expanded** — Better Auth 1.5.5 requires `createdAt` and `updatedAt` on the `session` table (not in 1.5.4). Schema and migration updated.
- **Login conditional rendering** — OAuth buttons and passkey button only appear for configured methods. If nothing is configured, login shows "Have your administrator configure at least one login provider".

#### WA components registered in `app.js`
button, icon, button-group, input, card, details, avatar, spinner, callout, copy-button, radio-group, radio, skeleton

#### Frontend routes
| Path | View | Auth required |
|------|------|---------------|
| `/` | home | No (shows marketing splash or create form) |
| `/login` | login | No (redirects to home if logged in) |
| `/links` | dashboard (Links tab) | Yes (redirects to login) |
| `/campaigns` | dashboard (Campaigns tab) | Yes (redirects to login) |
| `/links/:id` | link-detail | Yes (redirects to login) |

---

## Milestone 2: Rich Analytics & Reporting

**Delivers**: Per-link analytics dashboard with geographic, device, referrer, and timeline data.

### API Endpoints Added
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats/:linkId/timeseries` | Clicks over time (`?period=hour\|day\|week`) |
| GET | `/api/stats/:linkId/geo` | Clicks by country/region/city |
| GET | `/api/stats/:linkId/devices` | Browser/OS/device breakdown |
| GET | `/api/stats/:linkId/referrers` | Top referrers |
| GET | `/api/stats/:linkId/summary` | Aggregate stats |

Queries Analytics Engine via REST SQL API (using `CF_ACCOUNT_ID` + `CF_API_TOKEN` secrets). Falls back to `link_stats` D1 table for data older than 90 days or if AE is unavailable.

### Chart Components (Chart.js)

All charts use Chart.js directly via a thin theme-aware wrapper (`frontend/src/lib/chart-helper.js`). The wrapper reads WA design tokens (`--wa-color-text-normal`, `--wa-color-text-quiet`, `--wa-color-neutral-border-normal`, `--wa-color-brand-fill-loud`) from computed styles to auto-theme charts to the current light/dark mode.

```js
// frontend/src/lib/chart-helper.js
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

export function createChart(canvas, type, config) { /* theme-aware defaults */ }
export function destroyChart(instance) { /* cleanup */ }
```

#### Clicks Over Time — Line Chart

Primary analytics view. Fetches `/api/stats/:linkId/timeseries` and renders a `<canvas>`.

```js
// frontend/src/components/stats-charts.js
wrap.innerHTML = `<canvas id="clicks-timeline" style="height:200px;"></canvas>`;
const canvas = wrap.querySelector("#clicks-timeline");
createChart(canvas, "line", {
  data: { labels, datasets: [{ label: "Clicks", data: clicks, fill: true }] },
});
```

Period selector (hour/day/week) destroys the previous chart instance and creates a new one.

#### Device & Browser Breakdown — Doughnut Charts

Doughnut charts for browsers, OS, and device type. Each rendered into its own `<canvas>` inside a `wa-grid`.

```js
// frontend/src/components/stats-devices.js
createChart(canvas, "doughnut", {
  data: { labels: items.map(i => i.name), datasets: [{ label: "Clicks", data: items.map(i => i.clicks) }] },
});
```

#### Top Referrers — Horizontal Bar Chart

Horizontal bars to accommodate long referrer domain names. Uses `indexAxis: "y"`.

```js
// frontend/src/components/stats-referrers.js
createChart(canvas, "bar", {
  data: { labels: referrers.map(r => r.source), datasets: [{ label: "Clicks", data: referrers.map(r => r.clicks) }] },
  options: { indexAxis: "y" },
});
```

#### Geographic Breakdown — Bar Chart

Top countries/cities as vertical bar charts.

#### Shared Patterns

- **Dynamic data**: All charts created after API fetch. Previous instances destroyed before re-creation on period change.
- **Dark mode**: Chart colors derived from WA CSS custom properties via `getComputedStyle()`, with fallbacks for both light and dark modes.
- **Cleanup**: Every chart component tracks its Chart.js instances and calls `destroyChart()` before re-rendering.

### New Files
- `src/routes/api/stats.ts` - Stats endpoints (queries AE SQL API, falls back to D1)
- `src/services/useragent.ts` - Lightweight UA parser (regex, no library)
- `frontend/src/lib/chart-helper.js` - Theme-aware Chart.js wrapper (createChart/destroyChart)
- `frontend/src/components/stats-charts.js` - Orchestrates all chart components, handles API fetches and period selection
- `frontend/src/components/stats-devices.js` - Browser/OS/device doughnut charts
- `frontend/src/components/stats-geo.js` - Country/city bar charts
- `frontend/src/components/stats-referrers.js` - Top referrers horizontal bar chart

### Verification
- Link detail shows interactive timeline chart (clicks over 30 days)
- Period selector (hour/day/week) updates the line chart dynamically
- Browser and OS shown as doughnut charts with correct proportions
- Top referrers displayed as horizontal bars
- Geographic breakdown shows country/region/city data as bar chart
- All charts adapt to dark/light theme toggle
- Charts are accessible (label + description on every chart element)

---

## Milestone 3: Advanced Link Features

**Delivers**: URL expiration, password protection, internal links, QR codes, social metadata.

### Schema Changes (ALTER links)
- `expiresAt` INT? - Unix timestamp expiration
- `maxClicks` INT? - Expire after N clicks
- `password` TEXT? - Hashed password
- `isInternal` INT DEFAULT 0 - Requires auth to redirect
- `ogTitle` TEXT?, `ogDescription` TEXT?, `ogImage` TEXT?

### New Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/links/:id/check-password` | Validate password for protected link |

### Key Changes
- `redirect.ts` - Check expiration, click limits, password, internal flags before redirecting
- `frontend/src/components/link-form.js` - Add expiration, password, internal toggle fields
- New `frontend/src/components/qr-code.js` using `wa-qr-code` with PNG download
- Password gate page served inline when password-protected link is visited

### Verification
- Expired link returns 410 Gone
- maxClicks link stops redirecting after threshold
- Password-protected link shows form, correct password redirects
- Internal link requires auth
- QR code renders and downloads as PNG

### Implementation Notes

**Implemented 2026-03-18. All M3 files complete.**

#### Files created
- `drizzle/migrations/0001_link_features.sql` — 7 ALTER TABLE statements for new columns
- `src/services/password.ts` — PBKDF2-SHA256 (100k iterations, 16-byte salt) hash/verify using Web Crypto API
- `frontend/src/components/qr-code.js` — `<wa-qr-code>` wrapper with PNG download button (Canvas-based, no SVG export)

#### Files modified
- `src/db/schema.ts` — Added 7 columns to `links`: expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage
- `src/services/kv-cache.ts` — Exported `CachedRedirect` interface, added expiresAt, maxClicks, hasPassword, isInternal, ogTitle, ogDescription, ogImage fields
- `src/lib/errors.ts` — Added trailing newline (no new helpers; forbidden/gone responses are inline HTML in `redirect.ts`)
- `src/routes/redirect.ts` — Refactored into resolveSlug/checkConstraints/trackClick helpers. Added: expiration check (410 HTML), password gate (inline HTML form with dark mode), internal link auth check (403), max clicks check (D1 query). New `handleRedirectPost` for password form submission.
- `src/routes/api/links.ts` — All CRUD endpoints handle new fields. Password hashed on create/update, stripped to `hasPassword: boolean` in responses. New `checkPassword` export (public JSON endpoint). Slug is immutable after creation (PUT handler ignores slug field).
- `src/index.ts` — Mounted `POST /api/links/:id/check-password` before auth middleware (public). Added `POST /:slug` for password gate form.
- `frontend/src/app.js` — Registered WA components: switch, textarea, qr-code, badge, dropdown, dropdown-item. Also imported `utilities.css`.
- `frontend/src/components/link-form.js` — Advanced Options collapsible with: expiration datetime, max clicks, password (with touch tracking for edit), internal toggle, OG title/description/image
- `frontend/src/views/link-detail.js` — Badges (Expired/Expires, Password Protected, Internal), click limit display, OG social preview card, QR code section, Edit button toggle
- `frontend/src/views/login.js` — Single-provider auto-redirect, fixed `slot="prefix"` → `slot="start"` on icons
- `frontend/src/views/dashboard.js` — Fixed `slot="prefix"` → `slot="start"`, `clearable` → `with-clear`, `wa-input` → `input` event, inline flex → `wa-split`
- `frontend/src/views/home.js` — Authenticated users redirect straight to `/dashboard` instead of showing create form on home
- `frontend/src/components/nav-bar.js` — Replaced inline nav with `wa-split`/`wa-cluster`, added avatar dropdown menu (wa-dropdown) for logged-in users
- `frontend/src/components/toast.js` — Uses `wa-callout` (closable, with auto-dismiss) in a fixed-position container for toast-style notifications
- `frontend/src/components/stats-charts.js` — Fixed `--wa-color-neutral-500` → `--wa-color-text-quiet`, `wa-change` → `change` event, inline flex → `wa-split`
- `frontend/src/components/link-table.js` — Used `wa-align-items-center` instead of inline `text-align:center`
- `frontend/src/styles/app.css` — Removed custom flex rules replaced by WA utility classes (`wa-split`, `wa-cluster`, `wa-stack`)
- `frontend/esbuild.mjs` — Added `--watch` flag support for dev mode
- `package.json` — `dev` script runs esbuild watch + auto-applies D1 migrations; `db:migrate:local` uses `wrangler d1 migrations apply`
- `wrangler.jsonc` — Added `migrations_dir` to D1 binding
- `test/integration/redirect.test.ts` — Updated KV test data to include new M3 `CachedRedirect` fields
- `test/unit/kv-cache.test.ts` — Updated test data to include new M3 `CachedRedirect` fields

#### Design decisions
- **Single-provider auto-redirect**: When exactly one OAuth provider is configured and passkey is disabled, the login view skips rendering buttons and immediately calls `authClient.signIn.social()` to redirect to that provider. Shows "Redirecting to {name}…" while the redirect initiates. Multiple providers or passkey enabled still show the full login page.
- **Password gate**: Self-contained HTML page (no SPA/WA deps) with inline CSS, `prefers-color-scheme` dark mode, standard form POST to `/:slug`
- **KV cache stores `hasPassword: boolean`** not the actual hash — password verification always hits D1
- **maxClicks always queries D1** for accurate count (can't rely on cached click counts)
- **Internal link check** uses `getAuth(env).api.getSession()` directly in redirect handler
- **Password field in form** tracks "touched" state to avoid sending empty password on edit (which would clear it)
- **Slug is immutable** — PUT endpoint does not accept slug changes; frontend disables slug field when editing
- **WA convention fixes across M1/M2 files** — `slot="prefix"` → `slot="start"`, `clearable` → `with-clear`, `wa-input`/`wa-change` → `input`/`change` events, `--wa-color-neutral-*` → `--wa-color-text-quiet`, inline flex → WA utility classes (`wa-split`, `wa-cluster`)
- **Home view simplified** — Authenticated users redirect to `/dashboard`; home is landing page only
- **Nav bar avatar dropdown** — Logged-in users get a `wa-dropdown` menu under their avatar (theme toggle + logout) instead of separate buttons

#### WA components registered in `app.js` (cumulative)
button, icon, button-group, input, card, details, avatar, spinner, callout, copy-button, radio-group, radio, skeleton, divider, switch, textarea, qr-code, badge, dropdown, dropdown-item

---

## Milestone 4: Targeting & Campaigns

**Delivers**: Geo-targeting, mobile targeting, param forwarding, campaign management.

### New Tables
- `campaigns` (id, userId, name, description, createdAt, updatedAt)
- `link_campaigns` (linkId, campaignId) - many-to-many
- `link_targets` (id, linkId, type "geo"|"device", matchValue, destinationUrl, priority)
- ALTER links: add `paramForwarding` INT DEFAULT 0

### Key Changes
- `redirect.ts` - Evaluate targeting rules (country from `request.cf`, UA for device), append params
- `kv-cache.ts` - KV value now includes targeting rules
- New campaign CRUD endpoints and views

### Verification
- Geo-targeting: US visitors -> URL A, UK visitors -> URL B
- Mobile targeting: iOS -> App Store, Android -> Play Store
- `yourdomain.com/abc?ref=twitter` -> `example.com/page?ref=twitter`
- Campaign aggregates click stats across grouped links

### Implementation Notes

**Implemented 2026-03-18. All M4 files complete.**

#### Files created
- `drizzle/migrations/0002_campaigns_targeting.sql` — Migration adding `campaigns`, `link_campaigns`, `link_targets` tables and `paramForwarding` column to `links`
- `src/routes/api/campaigns.ts` — Full CRUD for campaigns with link association management and aggregate stats endpoint
- `frontend/src/views/campaigns.js` — Campaign list view with create form
- `frontend/src/views/campaign-detail.js` — Campaign detail with edit/delete, link list, aggregate stats, "Add Links" dialog

#### Files modified
- `src/db/schema.ts` — Added `primaryKey` import, `paramForwarding` column on links, and `campaigns`, `linkCampaigns`, `linkTargets` table definitions
- `src/services/kv-cache.ts` — Added `CachedTarget` interface and `paramForwarding`/`targets` fields to `CachedRedirect`
- `src/routes/redirect.ts` — Added `detectDeviceType()`, `resolveDestination()` (targeting + param forwarding evaluation), updated `resolveSlug` to fetch targeting rules, updated both `handleRedirect` and `handleRedirectPost` to use resolved destination URLs
- `src/routes/api/links.ts` — Added `paramForwarding` and `campaignId` to create/update handlers, added `GET /:id/targets` and `PUT /:id/targets` endpoints, updated GET /:id to return targets and campaigns, updated all KV cache writes to include `paramForwarding` and `targets`
- `src/index.ts` — Mounted campaign routes with auth middleware
- `src/lib/constants.ts` — Added "campaigns" to `RESERVED_SLUGS`
- `frontend/src/components/link-form.js` — Added param forwarding toggle, campaign assignment select, targeting rules section with dynamic add/remove rows
- `frontend/src/views/link-detail.js` — Shows targeting rules table, param forwarding badge, campaign name badge
- `frontend/src/app.js` — Added `wa-select`, `wa-option`, `wa-dialog` component imports; campaign view routes
- `frontend/src/components/nav-bar.js` — Added "Campaigns" nav link for logged-in users
- `frontend/src/styles/app.css` — Campaign card hover, targeting rule row styling

#### Design decisions
- **Targeting evaluation**: Rules sorted by priority (descending), first match wins. Geo matches `request.cf.country` (2-letter ISO). Device detection via lightweight regex (no library).
- **Param forwarding**: Appends incoming query params to destination URL, only adding params not already present in destination.
- **Campaign-link relationship**: Many-to-many via `link_campaigns` table. Link form shows single campaign select (first association) but schema supports multiple.
- **Campaign stats**: Dedicated `GET /api/campaigns/:id/stats` endpoint aggregates `link_stats` across all campaign links.
- **KV cache includes targets**: Targeting rules cached in KV alongside redirect data to avoid D1 lookups in hot path.
- **D1 batch not used for target replacement**: Delete-then-insert is sequential; soft consistency is acceptable for targeting rule updates (not a hot path).

#### WA components registered in `app.js` (cumulative)
button, icon, button-group, input, card, details, avatar, spinner, callout, copy-button, radio-group, radio, skeleton, divider, switch, textarea, qr-code, badge, dropdown, dropdown-item, select, option, dialog

#### Frontend routes (cumulative)
| Path | View | Auth required |
|------|------|---------------|
| `/` | home | No |
| `/login` | login | No |
| `/links` | dashboard (Links tab) | Yes |
| `/campaigns` | dashboard (Campaigns tab) | Yes |
| `/links/:id` | link-detail | Yes |
| `/campaigns/:id` | campaign-detail | Yes |

---

## Milestone 5: Custom Domains & Branding

**Delivers**: Custom branded domains (admin-synced from Cloudflare), root/404 redirects, domain access control, branded QR codes.

### New Tables
- `domain_config` (hostname TEXT PK, rootRedirect?, notFoundRedirect?, accessMode TEXT DEFAULT 'all', updatedAt INT)
- `domain_access` (hostname TEXT FK, email TEXT, PK(hostname, email)) — controls which users can create links on restricted domains
- ALTER links: add `domainHostname` TEXT? FK → `domain_config.hostname`

### Admin Model (No DNS Verification)

Domains are **not** user-created. Instead, an admin clicks "Sync from Cloudflare" which calls `POST /api/domains/sync`. The sync endpoint:
1. Fetches `GET /accounts/{CF_ACCOUNT_ID}/workers/domains?service={WORKER_NAME}` from the Cloudflare API to discover hostnames routed to this Worker
2. Always includes the primary hostname (from `BETTER_AUTH_URL`)
3. Upserts new hostnames into `domain_config` with `accessMode: "all"` (preserves existing config)
4. Deletes hostnames no longer in Cloudflare (except primary)

Admin status is determined by `ADMIN_EMAILS` env var (comma-separated list checked in `requireAuth` middleware). The `requireAdmin` middleware guards admin-only routes.

### Domain Access Control

Each domain has an `accessMode`:
- `"all"` — any authenticated user can create links on this domain
- `"restricted"` — only emails listed in `domain_access` (or admins) can create links on this domain

Link create/update validates domain access via `validateDomainAccess()` in `links.ts`.

### API Endpoints Added
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/domains` | Yes | List domains (admin sees all; non-admin sees `accessMode='all'` + domains they have access to) |
| POST | `/api/domains/sync` | Admin | Sync domains from Cloudflare API → D1 |
| GET | `/api/domains/:hostname` | Admin | Get domain config + access email list |
| PUT | `/api/domains/:hostname` | Admin | Update rootRedirect, notFoundRedirect, accessMode |
| GET | `/api/domains/:hostname/access` | Admin | List access emails for domain |
| PUT | `/api/domains/:hostname/access` | Admin | Replace access emails (array of emails) |

### Key Changes
- `redirect.ts` — `resolveHostInfo()` compares Host header to primary hostname. `resolveSlug()` scopes by `domainHostname` (IS NULL for default, specific hostname for custom). `handleCustomDomainRoot()` serves `rootRedirect` on bare custom domain visits. Slug miss on custom domain checks `notFoundRedirect` before falling through.
- `kv-cache.ts` — `kvKey()` helper: `{hostname}:{slug}` for custom domains, bare `{slug}` for default. All get/set/delete functions accept optional `hostname` parameter.
- `middleware/auth.ts` — `requireAuth` computes `isAdmin` from `ADMIN_EMAILS` env var, injects into `c.var.user`. New `requireAdmin` middleware checks `c.var.user.isAdmin`.
- `links.ts` — `domainHostname` field in create/update. `validateDomainAccess()` checks domain exists + user has access. All KV operations pass domain hostname for scoped keys. Domain change in PUT deletes old KV key before writing new one.
- Branded QR codes with customizable fill/background colors

### Verification
- Admin syncs domains from Cloudflare, sees them in Settings
- Configure rootRedirect and notFoundRedirect per domain
- Restrict domain access to specific emails
- Create link on custom domain → `brand.co/slug` redirects correctly
- Root domain and 404 redirects work
- Branded QR code renders with custom colors

### Implementation Notes

**Implemented 2026-03-18. All M5 files complete. Reviewed and fixed 2026-03-20.**

#### Files created
- `drizzle/migrations/0003_custom_domains.sql` — Original per-user domain schema (superseded by 0004)
- `drizzle/migrations/0004_simplified_domains.sql` — Reworked schema: CREATE TABLE domain_config + domain_access, ADD domainHostname to links, migrate data from 0003 domains table, DROP old tables. Includes partial unique index `idx_links_slug_default` for NULL domainHostname.
- `src/routes/api/domains.ts` — Domain sync (Cloudflare API), config CRUD, access management (all admin-only except GET list)
- `src/services/rate-limit.ts` — Shared KV-based rate limiting helper (`checkRateLimit`), used by both redirect password gate and API password check
- `frontend/src/views/settings.js` — Settings page with Domains tab (admin-only), sync button, inline edit rows

#### Files modified
- `src/db/schema.ts` — Added `domainConfig` table (hostname PK, rootRedirect, notFoundRedirect, accessMode, updatedAt), `domainAccess` table (hostname+email composite PK), added `domainHostname` column + index to `links` table. Composite unique index `(slug, domainHostname)` + partial unique index comment for NULL enforcement.
- `src/services/kv-cache.ts` — Added `domainHostname` to `CachedRedirect` interface, added `kvKey()` helper for domain-scoped keys (`hostname:slug`), updated all three functions to accept optional `hostname` parameter
- `src/routes/redirect.ts` — Added `isCustomDomainHost()` (shared host comparison), `resolveHostInfo()` (Host header parsing), `lookupDomain()` (D1 lookup for domain config), `handleCustomDomainRoot()` (root redirect for custom domains). Updated `resolveSlug` to scope by `domainHostname`. Custom domain slug miss checks `notFoundRedirect` before falling through to SPA. Bot/OG meta check runs before password gate. Rate limiting uses shared `checkRateLimit` with per-slug key.
- `src/routes/api/links.ts` — Added `domainHostname` to create/update bodies, `validateDomainAccess()` (domain exists + access check via accessMode/domain_access table). GET /:id returns `domainHostname`. All KV write/delete operations pass domain hostname. Domain change in PUT deletes old KV key before writing new one and validates slug uniqueness on target domain. Rate limiting uses shared `checkRateLimit`.
- `src/routes/api/domains.ts` — Domain sync cleans up orphaned KV entries before deleting domains. PUT returns re-fetched record for consistent timestamps. Email array validation filters non-string elements.
- `src/index.ts` — Mounted domain routes with auth middleware, admin-only middleware on sync/config/access routes, added `handleCustomDomainRoot` handler for `/` before `/:slug`
- `src/middleware/auth.ts` — `requireAuth` checks `ADMIN_EMAILS` env var, sets `isAdmin` on user. Added `requireAdmin` middleware export.
- `src/types.ts` — Added `isAdmin: boolean` to `AuthUser` type
- `src/bindings.ts` — Added `ADMIN_EMAILS`, `WORKER_NAME` to Env interface
- `src/lib/constants.ts` — Added "settings" to RESERVED_SLUGS
- `wrangler.jsonc` — Added `WORKER_NAME: "veer"` to vars
- `frontend/src/app.js` — Added settings route + import, registered tab-group/tab/tab-panel/tooltip WA components
- `frontend/src/components/nav-bar.js` — Added "Settings" dropdown item with gear icon, wired up navigation
- `frontend/src/components/link-form.js` — Added domain select dropdown (fetches `/api/domains` for available domains), `domainHostname` in submission data
- `frontend/src/components/qr-code.js` — Branded QR with color pickers (native `<input type="color">`), real-time fill/background updates via `wa-qr-code` fill/background attributes
- `frontend/src/views/link-detail.js` — Uses `domainHostname` from API response, constructs `https://{hostname}/{slug}` short URL for custom domains, "Custom Domain" badge
- `frontend/src/views/settings.js` — Hostnames escaped in CSS selectors (`CSS.escape`) and URL paths (`encodeURIComponent`). Non-admins see helpful message instead of empty tab group.
- `frontend/src/styles/app.css` — Settings view, domain row, domain edit row styles. Dead CSS removed (`.nav-link`, `.domain-verify-info`). Text utility classes consolidated (`.text-quiet, .text-subdued`).
- `frontend/src/components/link-table.js` — Short URLs use `link.domainHostname` when present
- `frontend/src/views/campaign-detail.js` — Short URLs use `link.domainHostname` when present
- `test/setup.ts` — Added domain_config/domain_access DDL, `idx_links_domainHostname` index, `idx_links_slug_default` partial unique index
- `test/helpers.ts` — `createTestLink` accepts `domainHostname` override
- `test/unit/kv-cache.test.ts` — Domain-scoped KV key tests (kvKey format, roundtrip, isolation, delete)
- `test/integration/redirect.test.ts` — Added `domainHostname: null` to test CachedRedirect objects
- `test/unit/redirect.test.ts` — Added `domainHostname: null` to cachedRedirect helper and test objects

#### Design decisions
- **No DNS verification needed**: Since domains are synced from the Cloudflare API (which already knows what's routed to this Worker), manual DNS TXT verification is unnecessary. This is a significant simplification over the original plan.
- **Admin-synced, not user-created**: Domain lifecycle is managed by admins, not individual users. Admins sync from Cloudflare, then configure per-domain settings (redirects, access control).
- **`ADMIN_EMAILS` env var**: Admin status is determined by checking the user's email against a comma-separated `ADMIN_EMAILS` env var, computed in `requireAuth` middleware. No DB role column needed.
- **`WORKER_NAME` env var**: Used to query the Cloudflare API for domains routed to this specific Worker. Defaults to `"veer"`.
- **Hostname as primary key**: `domain_config` uses `hostname` as PK (not a UUID). Links reference `domainHostname` directly (FK to `domain_config.hostname`), eliminating joins for display.
- **Access control model**: `accessMode` is either `"all"` (any user) or `"restricted"` (only emails in `domain_access` table). Admins always have access.
- **KV key scoping**: Custom domain keys use `{hostname}:{slug}` format, default domain uses bare `{slug}`. Backwards compatible — existing KV entries unaffected.
- **Domain-scoped slug uniqueness**: Composite unique index `(slug, domainHostname)` + partial unique index `idx_links_slug_default WHERE domainHostname IS NULL` (SQLite treats NULLs as distinct in composite indexes). Same slug can exist on different domains. Manual check-then-insert also guards against races in the create handler.
- **Domain sync KV cleanup**: Before deleting a domain during sync, all KV entries for links on that domain are deleted to prevent orphaned `hostname:slug` keys.
- **Slug uniqueness on domain change**: PUT handler validates slug uniqueness on the target domain when `domainHostname` changes, matching the CREATE handler's check.
- **Custom domain root handling**: Separate `handleCustomDomainRoot` handler on `/` (before `/:slug`) checks for rootRedirect on custom domains.
- **Custom domain 404**: When slug not found on custom domain, checks `notFoundRedirect` before falling through to SPA. Domain lookup only runs in the `!resolved` branch (not on the hot path).
- **Hostname is immutable in domain_config**: Hostnames come from Cloudflare sync only. PUT endpoint only accepts rootRedirect/notFoundRedirect/accessMode changes.
- **KV key migration on domain change**: PUT link handler deletes old domain-scoped KV key before writing new one when domainHostname changes.
- **Bot/OG meta before password gate**: Bot user-agent check runs before the password gate so social preview crawlers see OG meta tags for password-protected links with OG metadata.
- **Shared rate limiting**: `src/services/rate-limit.ts` provides a single `checkRateLimit(kv, key, limit, windowSeconds)` function used by both the redirect password POST and the API password check endpoint. Keys include slug/link ID for per-link granularity.
- **Branded QR**: Uses native `<input type="color">` (not wa-input) for color pickers since WA input doesn't support type="color". Updates `wa-qr-code` fill/background attributes in real-time.
- **Link detail domain resolution**: GET /api/links/:id returns `domainHostname` directly (no join needed since it's stored on the link), avoiding an extra fetch from the frontend.
- **Migration path**: 0003 creates the original per-user domain schema, 0004 replaces it with the simplified admin model and migrates any existing data. For fresh deployments these could be squashed.

#### Resolved issues (from initial review 2026-03-20)
All issues identified during code review have been fixed:
- ~~Slug uniqueness not domain-scoped~~ → Composite + partial unique index, manual check in create/update
- ~~Password POST handler ignores domain scoping~~ → Fixed with domain-scoped WHERE clause
- ~~Unused D1 query in handleRedirectPost~~ → Removed
- ~~Domain lookup on every custom domain redirect~~ → Moved to `!resolved` branch only
- ~~Empty settings page for non-admins~~ → Shows "No settings available" message
- ~~Link table shows wrong short URLs for custom domains~~ → Uses `link.domainHostname` when present
- ~~No test coverage for M5 functionality~~ → Domain-scoped KV tests added (kvKey format, roundtrip, isolation, delete); test helpers support `domainHostname`
- ~~Domain sync orphans KV cache entries~~ → KV cleanup before domain deletion
- ~~Slug uniqueness not checked on domain change in PUT~~ → Added check excluding current link
- ~~Rate limit not atomic / duplicated~~ → Shared `checkRateLimit` helper with per-slug keys
- ~~Domain config PUT returns inconsistent timestamp~~ → Re-fetches after update
- ~~Email array elements not validated as strings~~ → Filtered before `.trim()`
- ~~Bot check after password gate~~ → Moved before password gate
- ~~Host resolution logic duplicated~~ → Extracted `isCustomDomainHost()` helper
- ~~Dead/duplicate CSS~~ → Removed `.nav-link`, `.domain-verify-info`; consolidated `.text-quiet`/`.text-subdued`
- ~~Hostname unescaped in CSS selector / URL~~ → `CSS.escape()` and `encodeURIComponent()`
- ~~PLAN.md wrong design token names~~ → Fixed to `--wa-color-text-normal`, `--wa-color-text-quiet`, `--wa-color-neutral-border-normal`

#### Resolved issues (from WA audit 2026-03-20)
All issues identified during Web Awesome component audit have been fixed:
- ~~`wa-callout` `closable` property used in toast.js~~ → Removed; not a valid callout property
- ~~`wa-callout` `wa-hide` event used in toast.js~~ → Removed; callout has no events. Toasts rely on `setTimeout` for auto-dismiss.
- ~~`wa-icon variant="regular"` on FA Free icon in campaigns.js~~ → Removed; FA Free only has solid (default) and brands families
- ~~`wa-copy-button` `--font-size` custom property~~ → Changed to standard `font-size` CSS property; `--font-size` is not a documented copy-button custom property
- **`wa-button circle` attribute** — Not a native WA attribute. Kept as a project convention with custom CSS in `app.css` (`wa-button[circle]::part(base)`) to achieve circular icon buttons. WA has no built-in circle button variant.

#### WA components registered in `app.js` (cumulative)
button, icon, button-group, input, card, details, avatar, spinner, callout, copy-button, radio-group, radio, skeleton, divider, switch, textarea, qr-code, badge, dropdown, dropdown-item, select, option, dialog, tab-group, tab, tab-panel, tooltip

#### Frontend routes (cumulative)
| Path | View | Auth required |
|------|------|---------------|
| `/` | home | No |
| `/login` | login | No |
| `/links` | dashboard (Links tab) | Yes |
| `/campaigns` | dashboard (Campaigns tab) | Yes |
| `/links/:id` | link-detail | Yes |
| `/campaigns/:id` | campaign-detail | Yes |
| `/settings` | settings (Domains tab) | Yes (admin-only content) |

---

## Milestone 6: API, Bulk Operations & Automation

**Delivers**: API key auth, bulk creation, stats API, rate limiting, public reports.

### New Tables
- `api_keys` (id, userId, name, keyHash UNIQUE, prefix, lastUsedAt?, createdAt, expiresAt?)
- `public_reports` (id, linkId, token UNIQUE, isEnabled, createdAt)

### Key Changes
- `auth.ts` middleware - Support `Authorization: Bearer <api_key>` alongside session cookies
- New rate limiting middleware (KV-based, per API key)
- Bulk create endpoint (JSON array input)
- UI: bulk create via textarea (CSV/line-by-line), API key management in settings

### Verification
- Generate API key, use with curl to create links
- Bulk create 10 links in single request
- Public report link shows analytics without auth
- Rate limiting returns 429 after threshold

---

## Milestone 7: Team & Enterprise

**Delivers**: Multi-user teams, roles, admin oversight, impersonation, quotas.

### New Tables
- `teams` (id, name, slug UNIQUE, createdAt, updatedAt)
- `team_members` (teamId, userId, role "admin"|"member", joinedAt)
- `team_invites` (id, teamId, email, role, token UNIQUE, expiresAt, createdAt)
- ALTER links: add `teamId` TEXT? FK
- ALTER user: add `maxLinks` INT?

### Key Changes
- Team-scoped link operations
- Role-based access control middleware
- Admin endpoints for user management and impersonation
- Invite flow via email token

### Verification
- Create team, invite member, member sees shared links
- Admin views all team links, manages quotas
- Impersonation works for troubleshooting

---

## Milestone 8: A/B Testing, Polish & Self-Hosting

**Delivers**: A/B testing, one-click social share, setup wizard, theme toggle, CSV export, README.

### New Tables
- `ab_tests` (id, linkId FK UNIQUE, isActive, createdAt)
- `ab_variants` (id, testId FK, destinationUrl, weight INT, clicks INT DEFAULT 0)

### Key Changes
- `redirect.ts` - Weighted random traffic splitting for A/B variants
- First-run setup wizard (create admin user on empty DB)
- Dark/light theme toggle (swap `wa-light` ↔ `wa-dark` on `<html>`, persist to `localStorage`)
- CSV export endpoint
- Comprehensive README.md with self-hosting guide

### One-Click Social Share

Share buttons appear on the link detail view, letting users quickly share their short URL to social platforms. Uses the WA Social Share pattern with `wa-button` + `wa-icon` brand icons inside a `wa-cluster`.

#### Component: `frontend/src/components/share-links.js`

```html
<div class="wa-cluster wa-gap-s">
  <wa-button size="large" variant="neutral" appearance="plain"
    ><wa-icon name="x-twitter" family="brands" label="Share on X"></wa-icon
  ></wa-button>
  <wa-button size="large" variant="neutral" appearance="plain"
    ><wa-icon name="facebook" family="brands" label="Share on Facebook"></wa-icon
  ></wa-button>
  <wa-button size="large" variant="neutral" appearance="plain"
    ><wa-icon name="bluesky" family="brands" label="Share on Bluesky"></wa-icon
  ></wa-button>
  <wa-button size="large" variant="neutral" appearance="plain"
    ><wa-icon name="linkedin" family="brands" label="Share on LinkedIn"></wa-icon
  ></wa-button>
  <wa-button size="large" variant="neutral" appearance="plain"
    ><wa-icon name="mastodon" family="brands" label="Share on Mastodon"></wa-icon
  ></wa-button>
  <wa-button size="large" variant="neutral" appearance="plain"
    ><wa-icon name="envelope-open" label="Share via email"></wa-icon
  ></wa-button>
</div>
```

Each button opens the platform's share URL in a new window via `window.open()`:
```js
const shareUrls = {
  'x-twitter': (url, title) => `https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
  facebook:    (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  bluesky:     (url, title) => `https://bsky.app/intent/compose?text=${encodeURIComponent(title + ' ' + url)}`,
  linkedin:    (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  mastodon:    (url, title) => `https://share.joinmastodon.org/#text=${encodeURIComponent(title + ' ' + url)}`,
  email:       (url, title) => `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`,
};
```

The component also includes a "Copy Link" button using `wa-copy-button` for the short URL. On devices that support it, a native share fallback is offered via `navigator.share()`.

### Verification
- A/B test splits traffic correctly per weights
- Setup wizard runs on first deploy, then hides
- Theme toggle works
- Social share buttons open correct platform share dialogs with pre-filled short URL
- `navigator.share()` fallback works on mobile
- CSV export produces valid file
- Fresh clone + configure + `wrangler deploy` works end-to-end

---

## Migration Sequence

| File | Milestone | Tables |
|------|-----------|--------|
| `0000_initial.sql` | M1 ✅ | user, session, account, verification, passkey, links, link_stats |
| `0001_link_features.sql` | M3 | ALTER links (+expiration, password, internal, OG) |
| `0002_campaigns_targeting.sql` | M4 | campaigns, link_campaigns, link_targets, ALTER links |
| `0003_custom_domains.sql` | M5 | domains (original, superseded by 0004) |
| `0004_simplified_domains.sql` | M5 | domain_config, domain_access, ALTER links (+domainHostname), DROP domains |
| `0004_api_keys.sql` | M6 | api_keys, public_reports |
| `0005_teams.sql` | M7 | teams, team_members, team_invites, ALTER links/user |
| `0006_ab_testing.sql` | M8 | ab_tests, ab_variants |

## Frontend Conventions (Web Awesome)

**The `webawesome` skill is the canonical reference.** Always read the component's doc (slots, attributes, events, variants) before using it. Do not guess from memory or Shoelace conventions — WA has diverged. Every slot name, event name, attribute name, and variant value must come from the skill docs for the specific component being used.

### Verification rule

Before a milestone is considered complete, load the `webawesome` skill and verify every `wa-*` element in changed files against its docs. Common things that differ from Shoelace and are easy to get wrong:

- **Slot names** — WA uses `start`/`end` (not `prefix`/`suffix`), but not every component has them. If the docs only list a `(default)` slot, don't use named slots.
- **Attribute names** — e.g. `hint` not `help-text`, `with-clear` not `clearable`.
- **Event names** — Standard DOM events (`input`, `change`) are unprefixed. Only component-specific events use `wa-` prefix.
- **Variant values** — WA uses `brand` not `primary`. Always check the component's variant list.
- **Declarative features** — Use `data-dialog="close"` / `data-dialog="open {id}"` instead of manual JS when no async logic is needed.

### Style hierarchy

When writing styles, prefer in this order (first available wins):

1. **WA utility classes** — `wa-stack`, `wa-cluster`, `wa-split`, `wa-grid`, `wa-flank`, `wa-frame`, `wa-gap-*`, `wa-align-items-*`, `wa-justify-content-*`, `wa-align-self-*`, `wa-border-radius-*`, `wa-visually-hidden`. See layout docs in the `webawesome` skill.
2. **WA design tokens** — Semantic tokens only (`--wa-color-text-quiet`, `--wa-color-neutral-border-normal`). Never use numeric palette tokens (`--wa-color-neutral-300`).
3. **Custom CSS in `app.css`** — Only for things WA utilities genuinely can't express (e.g. `max-width`, `position`, `flex:1`, table styling).
4. **Inline `style` attributes** — Last resort, for one-off values like `--min-column-size`, `--width`, `--size`.

**Never write inline `display:flex`, `align-items`, `justify-content`, `gap`, or `flex-direction` when a WA utility class exists.**

### Project-specific patterns

- **Toast**: `showToast(message, variant, duration)` in `frontend/src/components/toast.js`. Uses `wa-callout` in a fixed container.
- **QR codes**: `<wa-qr-code>` renders via Canvas API, not SVG. Export via `shadowRoot.querySelector("canvas").toDataURL()`.

---

## Backend Conventions (Cloudflare Workers)

**IMPORTANT: All backend code MUST be verified against the `wrangler` and `workers-best-practices` skills before considering a milestone complete.**

### Security

- **Rate-limit all public endpoints** that accept user input (password checks, login attempts, etc.). Use KV-based rate limiting with key format `ratelimit:{type}:{ip}` and `expirationTtl` for auto-cleanup.
- **Never leak protected data in API responses.** If a resource is gated (e.g. password-protected links), API responses must not include the gated payload (e.g. `destinationUrl`). Return only validation results; let the client follow the normal access path.
- **HTML-escape all interpolated values** in server-generated HTML pages (password gate, error pages, OG meta pages).
- **Bot/crawler detection**: When links carry OG metadata, serve an HTML page with `<meta property="og:*">` tags to known bot user-agents (facebookexternalhit, Twitterbot, LinkedInBot, Discordbot, etc.) and a `<meta http-equiv="refresh">` fallback redirect.

### D1 / Drizzle

- **Use Drizzle's types for update objects**: `Partial<typeof table.$inferInsert>`, not `Record<string, ...>`.
- **Extract shared validation helpers** when the same parsing/validation logic appears in both create and update handlers.
- **Atomic operations**: Where check-then-act patterns span multiple tables (e.g. maxClicks check vs stats increment), document whether the cap is soft or hard. Prefer atomic D1 queries (single UPDATE with WHERE) where possible.

### KV Cache

- **Write-through on create/update**, delete on deactivate/delete.
- API handler KV writes use `await` (consistency before response). Redirect handler KV writes use `waitUntil` (non-blocking).
- Cache only what the redirect path needs. Never cache secrets (password hashes). Use boolean flags (e.g. `hasPassword`) instead.

### Workers Patterns

- `AnalyticsEngineDataset.writeDataPoint()` is synchronous — do NOT wrap in `waitUntil`.
- D1 writes in the redirect hot path MUST use `c.executionCtx.waitUntil()` to avoid blocking the redirect response.
- Avoid constructing expensive objects (like Better Auth instances) in hot paths when a lighter check would suffice.

---

## Workers Configuration Requirements

```jsonc
// wrangler.jsonc key fields
{
  "compatibility_date": "2026-03-06",
  "compatibility_flags": ["nodejs_compat"],  // Required for Better Auth
  "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": true },
  "placement": { "mode": "smart" },  // Route requests to colo nearest D1 to reduce latency
  "observability": {
    "enabled": true,
    "logs": { "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 0.01 }
  }
}
```

### Required Secrets (via `wrangler secret put`)
- `BETTER_AUTH_SECRET` - Encryption secret (min 32 chars)
- `CF_API_TOKEN` - Cloudflare API token for Analytics Engine SQL API queries
- OAuth secrets (conditional, at least one login method required):
  - `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
  - `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`
  - `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET`
  - `DISCORD_CLIENT_ID` + `DISCORD_CLIENT_SECRET`

### Required Env Vars (via wrangler.jsonc `vars`)
- `BETTER_AUTH_URL` - Base URL of the deployment
- `CF_ACCOUNT_ID` - Cloudflare account ID (not secret, used for AE API URL and domain sync)
- `WORKER_NAME` - Worker service name for Cloudflare API domain sync (default: `"veer"`)
- `PASSKEY_ENABLED` - Set to `"true"` to enable WebAuthn passkey login (optional, no extra secrets needed)
- `ADMIN_EMAILS` - Comma-separated list of admin email addresses (optional, enables admin features like domain management)

---

## Dependencies (as installed)

**Runtime**: `hono@^4.12.5`, `better-auth@^1.5.5`, `@better-auth/passkey@^1.5.5`, `drizzle-orm@^0.45.1`, `@awesome.me/webawesome@^3.3.1`, `chart.js@^4.5.0`
**Dev**: `wrangler@^4.74.0`, `drizzle-kit@^0.31.9`, `typescript@^5.9.3`, `esbuild@^0.27.3`
**Frontend (bundled by esbuild)**: `better-auth/client` + `@better-auth/passkey/client` (from runtime deps), `@awesome.me/webawesome` (components + theme CSS), `chart.js` (analytics charts)

Note: `@cloudflare/workers-types` is not a separate dep — `wrangler types` generates `bindings.ts` directly.
