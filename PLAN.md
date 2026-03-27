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
    bindings.ts                # Env type re-exports (types from worker-configuration.d.ts) ✅
    types.ts                   # AppEnv + AuthUser types ✅ (added in M1)
    env.d.ts                   # Secret/optional env var declarations ✅ (added in M8)
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
        keys.ts                # /api/keys CRUD ✅
        bulk.ts                # /api/bulk creation ✅
        reports.ts             # /api/reports + public report viewer ✅
        teams.ts               # /api/teams (M7)
        admin.ts               # /api/admin (M7)
        setup.ts               # First-run setup (M8)
    middleware/
      auth.ts                  # Session + API key auth, injects user into c.var ✅
      cors.ts                  # CORS config for /api/* ✅
      rate-limit.ts            # KV-based rate limiting for API key requests ✅
    services/
      kv-cache.ts              # KV read/write/invalidate helpers ✅
      analytics.ts             # AE write (binding) + query (REST SQL API) helpers ✅
      slug.ts                  # Slug validation + SLUG_PATTERN/RESERVED_SLUGS constants ✅
    lib/
      team.ts                  # requireTeamMember() helper ✅ (added in M8)
      validators.ts            # validateHttpUrl(), validateDomainAccess() ✅ (added in M8)
      errors.ts                # Typed HTTP error helpers (badRequest, notFound, conflict) ✅
      providers.ts             # OAuth provider detection helper ✅ (added in M1)
      crypto.ts                # HMAC-SHA256 API key hashing + key generation ✅
      date.ts                  # Date formatting helpers ✅
  frontend/                    # Frontend source (ES modules)
    src/
      app.js                   # Main SPA: router init, auth state, rendering ✅
      router.js                # Client-side History API router ✅
      auth-client.js           # better-auth createAuthClient wrapper (bundled) ✅
      lib/
        escape.js              # HTML/attribute escaping utilities ✅ (added in M1)
        chart-helper.js        # Theme-aware Chart.js wrapper ✅
        stats-common.js        # Shared stats utilities (skeleton, noData, fetchJSON, cardError) ✅
        ui.js                  # Shared UI utilities (apiFetch, withLoadingBtn, shortUrl, etc.) ✅ (added in M8)
      views/
        home.js                # Landing / quick shorten ✅
        dashboard.js           # Link list (authenticated) ✅
        link-detail.js         # Single link + stats ✅
        login.js               # OAuth provider buttons (dynamic from /api/auth/providers) ✅
        settings.js            # Settings: domains (M5) ✅, API keys (M6) ✅, passkeys (M6) ✅
        campaigns.js           # Campaign management (M4)
        admin.js               # Admin panel (M7)
      components/
        link-form.js           # Create/edit link form ✅
        link-table.js          # HTML table + WA styling + pagination ✅
        stats-charts.js        # Chart.js line/bar/doughnut charts (M2)
        nav-bar.js             # Top nav with user avatar, login/logout, theme toggle ✅
        toast.js               # wa-callout-based toast notification helper ✅
      views/
        report.js              # Public report viewer (no auth required) ✅
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

1. Global: security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`) on all responses
2. `/api/*` - CORS middleware
3. `/api/auth/*` - Better Auth handler (no auth middleware — handles its own)
4. `/api/me` - `requireAuth` middleware (session only)
5. `/api/links`, `/api/links/*`, `/api/stats/*`, `/api/campaigns/*`, `/api/bulk/*`, `/api/reports/*` - `requireAuthOrApiKey` + `rateLimitApiKey` middleware (session or API key)
6. `/api/domains`, `/api/domains/*` - `requireAuth` (session only, admin routes further gated by `requireAdmin`)
7. `/api/keys`, `/api/keys/*` - `requireAuth` (session only — can't manage keys via API key)
8. `/api/public-report/:token` - IP-based rate limiting (no auth), public report viewer
9. `/:slug` - Redirect lookup (KV → D1 fallback) — calls `next()` on miss to fall through
10. `*` catch-all - `env.ASSETS.fetch(request)` serves SPA shell

The slug handler checks KV first (sub-ms, `cacheTtl: 30`), falls back to D1 on miss, writes KV on hit (`expirationTtl: 86400`). Inactive links in KV are skipped (fall through). If no slug found, falls through to SPA shell (which shows 404 client-side).

## Better Auth Configuration Pattern

```typescript
// src/auth/index.ts - cached per env object via WeakMap
// Provider detection extracted to src/lib/providers.ts (getConfiguredProviders)
// Passkey plugin loaded conditionally via PASSKEY_ENABLED env var
export function getAuth(env: Env) {
  const socialProviders = getConfiguredProviders(env);  // Record<string, {clientId, clientSecret}>
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

The `getConfiguredProviders()` helper iterates `["google", "github", "microsoft", "discord"]` and checks for `{PROVIDER}_CLIENT_ID` + `{PROVIDER}_CLIENT_SECRET` env vars, returning a `Record<string, { clientId, clientSecret }>` directly. It's also used by `GET /api/auth/providers` to return the list of available providers to the frontend login view. The providers endpoint also returns `passkey: true/false` based on `PASSKEY_ENABLED`.

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
- `user` (id, name, email, emailVerified, image, createdAt, updatedAt)
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
- `src/services/rate-limit.ts` — Shared KV-based rate limiting helper (`checkRateLimit`), used by both redirect password gate and API password check (deleted in M6, replaced by `src/middleware/rate-limit.ts`)
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
| `/settings` | settings (Domains tab) | Yes (admin-only content; expanded in M6 with API Keys + Passkeys tabs) |

---

## Milestone 6: API, Bulk Operations & Automation

**Delivers**: API key auth, bulk creation, stats API, rate limiting, public reports.

**Status**: All files implemented. API key auth, bulk creation, public reports, rate limiting, and passkey registration all functional.

### New Tables
- `api_keys` (id, userId, name, keyHash UNIQUE, prefix, lastUsedAt?, createdAt, expiresAt?)
  - Indexes: `idx_api_keys_keyHash` (unique), `idx_api_keys_userId`
- `public_reports` (id, linkId, token UNIQUE, isEnabled, createdAt)
  - Indexes: `idx_public_reports_token` (unique), `idx_public_reports_linkId` (unique — one report per link)

### API Endpoints Added
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/keys` | Session | List user's API keys |
| POST | `/api/keys` | Session | Create API key `{name, expiresAt?}` (max 10 per user) |
| DELETE | `/api/keys/:id` | Session | Delete API key |
| POST | `/api/bulk` | Session/Key | Bulk create links `{links: [{slug, destinationUrl, title?, redirectType?, domainHostname?}]}` (max 50) |
| POST | `/api/reports/:linkId` | Session/Key | Create or get existing public report for link |
| PUT | `/api/reports/:linkId` | Session/Key | Toggle report isEnabled |
| GET | `/api/public-report/:token` | None (IP rate limited) | Public report viewer data (slug, title, totalClicks, 30-day timeseries) |

### Key Changes
- `auth.ts` middleware — New `requireAuthOrApiKey` middleware: checks `Authorization: Bearer <key>` header first (HMAC-SHA256 hash lookup), falls back to session auth. Shared `checkSession`/`isAdminUser` helpers extracted from `requireAuth`. API key `lastUsedAt` updated via `waitUntil`.
- `rate-limit.ts` middleware — KV-based rate limiting (60 req/min) applied only to API key requests (Bearer token auth). Session requests pass through. Returns `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` headers. Advisory enforcement (KV lacks atomic increment).
- `crypto.ts` — `hashApiKey()` (HMAC-SHA256 using BETTER_AUTH_SECRET), `generateApiKey()` (`veer_` prefix + 43 base62 chars, ~256 bits entropy, rejection sampling).
- `bulk.ts` — Validates all inputs first (slug, URL, domain access), then batch-inserts. Domain access checks cached per-request. Max 50 links, 100KB body limit.
- `reports.ts` — Public report shows slug, title, total clicks, 30-day timeseries from `link_stats`. Deactivated links return 404. Public endpoint IP rate-limited (30 req/min via KV).
- `auth/index.ts` — WeakMap cache for auth instances (avoids re-creating per middleware call in same request). Added Drizzle schema import. Cookie session cache enabled (5 min).
- `bindings.ts` — **Deleted**. Env types now come from `worker-configuration.d.ts` (generated by `wrangler types`).
- `db/schema.ts` — Removed `role` column from `user` table (admin determined by `ADMIN_EMAILS` env var, not DB column).
- `redirect.ts` — Removed `incrementClickStats` import (stats now handled separately). Removed `checkRateLimit` import.
- `services/rate-limit.ts` — **Deleted**. Replaced by `middleware/rate-limit.ts`.
- `services/analytics.ts` — Removed `incrementClickStats` function.
- UI: Bulk create via textarea in dashboard, API key management and passkey registration in settings, public report toggle on link detail, public report viewer page.

### Verification
- Generate API key, use with curl to create links
- Bulk create 10 links in single request
- Public report link shows analytics without auth
- Rate limiting returns 429 after threshold
- Passkey registration and deletion works in settings

### Implementation Notes

**Implemented 2026-03-25. All M6 files complete.**

#### Files created
- `drizzle/migrations/0004_api_keys.sql` — Creates `api_keys` and `public_reports` tables
- `src/routes/api/keys.ts` — API key CRUD: list, create (with 10-key limit), delete (ownership-scoped)
- `src/routes/api/bulk.ts` — Bulk link creation with per-item validation, domain access caching, batch conflict resolution via `ON CONFLICT DO NOTHING`
- `src/routes/api/reports.ts` — Public report management (create-or-get, toggle) + `publicReportRoute` handler for unauthenticated access
- `src/middleware/rate-limit.ts` — KV-based rate limiting middleware for API key requests (60/min, identified by first 16 chars of bearer token)
- `src/lib/crypto.ts` — HMAC-SHA256 key hashing via Web Crypto API + secure key generation with rejection sampling
- `src/lib/date.ts` — `MONTHS` array + `formatDate()` helper for timeseries labels
- `frontend/src/views/report.js` — Public report page: loading state, error handling, Chart.js line chart for 30-day timeseries
- `test/integration/auth-apikey.test.ts` — API key authentication integration tests
- `test/integration/bulk.test.ts` — Bulk creation integration tests
- `test/integration/keys.test.ts` — API key CRUD integration tests
- `test/integration/reports.test.ts` — Public reports integration tests
- `test/unit/crypto.test.ts` — HMAC hashing and key generation unit tests
- `test/unit/date.test.ts` — Date formatting unit tests

#### Files modified
- `src/db/schema.ts` — Added `apiKeys` and `publicReports` tables. Removed `role` column from `user` table.
- `src/auth/index.ts` — WeakMap-based instance caching, explicit schema import for Drizzle adapter, cookie session cache (5 min maxAge)
- `src/bindings.ts` — **Deleted**. Types now sourced from `worker-configuration.d.ts` generated by `wrangler types`.
- `src/middleware/auth.ts` — Refactored into `checkSession()` + `isAdminUser()` shared helpers. Added `requireAuthOrApiKey` middleware with HMAC key lookup, expiry check, and background `lastUsedAt` update.
- `src/index.ts` — Mounted `/api/keys`, `/api/bulk`, `/api/reports` routes. Changed `/api/links`, `/api/stats`, `/api/campaigns` from `requireAuth` to `requireAuthOrApiKey` + `rateLimitApiKey`. Added `/api/public-report/:token` with inline IP rate limiting (30/min via KV).
- `src/routes/redirect.ts` — Removed `incrementClickStats` call and `checkRateLimit` import. AE `writeDataPoint` now asserts non-null binding (`c.env.ANALYTICS!`).
- `src/services/analytics.ts` — Removed `incrementClickStats` function (16 lines).
- `src/services/rate-limit.ts` — **Deleted**. Replaced by dedicated middleware in `src/middleware/rate-limit.ts`.
- `src/routes/api/links.ts` — Minor updates for consistency with new auth model.
- `frontend/src/app.js` — Added `/r/:token` route, imported `renderReport`, registered `wa-relative-time` and `wa-color-picker` components. Replaced `text-center` with `wa-stack wa-align-items-center`.
- `frontend/src/views/settings.js` — Major expansion: added API Keys tab (create form, key table with delete confirmation dialog, new-key callout with copy) and Passkeys tab (register via `authClient.passkey.addPasskey()`, list, delete). Three-tab layout: Domains, API Keys, Passkeys.
- `frontend/src/views/dashboard.js` — Added Bulk Create button and section (textarea CSV input, parse-and-submit to `/api/bulk`, results table with success/failure per slug). Fixed tab activation via `active` attribute.
- `frontend/src/views/link-detail.js` — Added Public Report card (toggle, copy link, open in new tab). Delete link now uses `wa-dialog` confirmation instead of `confirm()`. Replaced inline style classes with WA utilities.
- `frontend/src/views/report.js` — New public report viewer with loading/error states and Chart.js line chart.
- `frontend/src/components/toast.js` — Enhanced toast positioning/styling.
- `frontend/src/styles/app.css` — Updated styles for new sections.
- `wrangler.jsonc` — Changed `nodejs_compat` → `nodejs_compat_v2`. Removed placeholder IDs for D1/KV. Added `BETTER_AUTH_URL` to vars. Removed trace sampling. Added `env.staging` configuration (separate D1, KV, AE bindings).
- `worker-configuration.d.ts` — Regenerated: added `StagingEnv`, union type for `WORKER_NAME`, added `BETTER_AUTH_SECRET` to env types. Removed `StringifyValues` helper.
- `test/setup.ts` — Added `api_keys` and `public_reports` table DDL.
- `test/unit/rate-limit.test.ts` — Updated for new middleware-based rate limiter.
- `test/unit/analytics.test.ts` — Removed `incrementClickStats` tests.

#### Design decisions
- **API key format**: `veer_` prefix + 43 random base62 characters (~256 bits entropy). Prefix allows easy identification and grep-ability. Rejection sampling ensures uniform distribution.
- **Key hashing**: HMAC-SHA256 (not plain SHA-256) using `BETTER_AUTH_SECRET` as the HMAC key. Prevents offline brute-force if D1 database is compromised. Key prefix stored separately for display.
- **Key management via session only**: API key CRUD routes use `requireAuth` (session), not `requireAuthOrApiKey`. You can't create/delete API keys using an API key — prevents key escalation.
- **Rate limiting scope**: Only applies to API key requests (Bearer token auth). Session-authenticated requests (browser UI) are not rate-limited. 60 requests/min per key, identified by first 16 chars of the token.
- **Rate limiting is advisory**: KV lacks atomic increment — concurrent requests may read the same counter. Documented as soft limit; for strict enforcement, recommends Cloudflare's native Rate Limiting API binding.
- **Public report model**: One report per link (unique index on `linkId`). Token format: `rpt_` + 32 base62 chars. Report shows only aggregate data (total clicks, 30-day timeseries from `link_stats`). Deactivated links return 404 even if report exists.
- **Public report rate limiting**: IP-based (30 req/min via KV), inline in index.ts rather than middleware to avoid applying to other routes.
- **Bulk create**: Max 50 links per request, 100KB body limit. Two-phase approach: validate all inputs first (caches domain access checks), then batch-insert. Per-item error reporting (success/failure per slug in response). Uses `ON CONFLICT DO NOTHING` with post-insert verification for conflict detection.
- **`bindings.ts` removed**: Env types now derived from `worker-configuration.d.ts` generated by `wrangler types`. Eliminates manual type maintenance.
- **`role` column removed from user table**: Admin status was already determined by `ADMIN_EMAILS` env var (since M5). The `role` column was unused dead schema.
- **`incrementClickStats` removed from redirect path**: Click stats no longer incremented in the redirect handler. AE remains the source of truth for click data; `link_stats` aggregation handled separately.
- **Auth instance caching**: `getAuth()` uses a `WeakMap` keyed on the `env` object to avoid re-creating the Better Auth instance multiple times within the same request (e.g., when both `requireAuthOrApiKey` and route handler call it).
- **Cookie session cache**: Better Auth's `cookieCache` enabled (5 min maxAge) to reduce D1 session lookups for session-authenticated requests.
- **`nodejs_compat_v2`**: Upgraded from `nodejs_compat` in wrangler config — v2 is the current recommended flag.
- **Staging environment**: `wrangler.jsonc` now includes `env.staging` with separate D1 database, KV namespace, and AE dataset bindings.
- **Passkey registration**: Implemented in settings view using `authClient.passkey.addPasskey()` (Better Auth client method). Lists existing passkeys with delete option. Deferred from M1 login as originally planned.
- **Delete confirmation**: Link detail now uses `wa-dialog` for delete confirmation instead of browser `confirm()`, consistent with API key and passkey delete flows.

#### WA components registered in `app.js` (cumulative)
button, icon, button-group, input, card, details, avatar, spinner, callout, copy-button, radio-group, radio, skeleton, divider, switch, textarea, qr-code, badge, dropdown, dropdown-item, select, option, dialog, tab-group, tab, tab-panel, tooltip, relative-time, color-picker

#### Frontend routes (cumulative)
| Path | View | Auth required |
|------|------|---------------|
| `/` | home | No |
| `/login` | login | No |
| `/links` | dashboard (Links tab) | Yes |
| `/campaigns` | dashboard (Campaigns tab) | Yes |
| `/links/:id` | link-detail | Yes |
| `/campaigns/:id` | campaign-detail | Yes |
| `/settings` | settings (Domains/API Keys/Passkeys tabs) | Yes |
| `/r/:token` | report (public) | No |

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

## Milestone 8: Code Quality, Security Hardening & DRY Refactor

**Delivers**: Comprehensive refactoring pass extracting shared utilities, hardening security, fixing WA component patterns, and reducing frontend/backend code duplication. No new features — focuses on correctness, maintainability, and consistency across the entire codebase.

**Status**: All files implemented.

### Key Changes

#### Backend: Extracted shared utilities
- **`src/lib/validators.ts` (NEW)** — Extracted `validateHttpUrl()` and `validateDomainAccess()` from `links.ts`. Used by links, bulk, and targets validation.
- **`src/lib/team.ts` (NEW)** — Extracted `requireTeamMember()` from `teams.ts`. Used by links, stats, and teams routes.
- **`src/lib/request.ts`** — Added `parsePagination()` helper. Used by links, admin, and campaigns routes (replaced inline page/limit/offset parsing).
- **`src/lib/date.ts`** — Moved `formatHour()` and `formatWeek()` from `stats.ts` into shared module. Made `MONTHS` non-exported (internal).
- **`src/lib/constants.ts` (DELETED)** — `SLUG_PATTERN` and `RESERVED_SLUGS` moved into `src/services/slug.ts` (their only consumer).

#### Backend: Security hardening
- **`src/routes/redirect.ts`** — Added `isSafeRedirectUrl()` validation on `rootRedirect` and `notFoundRedirect` before issuing `c.redirect()`. HTML-escaped error messages in `passwordGatePage()` and `gonePage()` to prevent reflected XSS.
- **`src/index.ts`** — Added `Content-Security-Policy` header (default-src 'self', script-src 'self', font-src 'self' + jsdelivr CDN).
- **`src/services/password.ts`** — Replaced manual constant-time comparison loop with `crypto.subtle.timingSafeEqual()` (Web Crypto native).
- **`src/middleware/rate-limit.ts`** — Extracted shared `rateLimit()` function used by both `rateLimitApiKey` and `rateLimitSession`. Added `checkRateLimit()` standalone function for use outside middleware (public report endpoint).
- **`src/middleware/cors.ts`** — Instantiate `cors()` handler once per worker instance instead of per-request. Reads `BETTER_AUTH_URL` from env inside the origin callback.

#### Backend: Type safety & cleanup
- **`src/types.ts`** — Changed `Variables: { user: AuthUser }` to `{ user?: AuthUser }` (correct — middleware may not have run). All route handlers now use `c.var.user!` (non-null assertion after auth middleware has run).
- **`src/auth/index.ts`** — `getConfiguredProviders()` now returns `Record<string, ...>` directly (removed intermediate `Map` → `Record` conversion). Removed unused `Auth` type export. Removed `Env` import (uses global from `worker-configuration.d.ts`).
- **`src/lib/providers.ts`** — Simplified to return `Record<string, { clientId, clientSecret }>` directly. Removed `ProviderCredentials` interface and `envKey()` helper. Removed `Env` import.
- **`src/routes/api/reports.ts`** — Simplified `generateReportToken()` to use `crypto.randomUUID()` (replaces manual rejection sampling). PUT handler returns constructed response object instead of re-fetching from DB.
- **`src/routes/api/admin.ts`** — Uses `parsePagination()`. Deferred user existence check to after body validation (avoids unnecessary DB read on no-op).
- **`src/routes/api/links.ts`** — Exported `stripPassword()` (used by admin route). Removed `validateDestinationUrl()` and `validateOgImageUrl()` wrappers (replaced by direct `validateHttpUrl()` calls). Removed `validateDomainAccess()` (moved to `lib/validators.ts`).
- **`src/routes/api/teams.ts`** — Extracted `requireNotLastAdmin()` helper (used by leave, remove member, change role). Removed local `requireTeamMember()` (imported from `lib/team.ts`).
- **`src/routes/api/stats.ts`** — Added team member access check (team members can view stats for team-owned links).
- **`src/routes/api/bulk.ts`** — Uses `validateHttpUrl` and `validateDomainAccess` from `lib/validators.ts`.
- **`src/index.ts`** — Removed duplicate `/api/me/*` middleware registration. Public report rate limiting uses `checkRateLimit()` instead of inline logic.
- **`src/services/analytics.ts`** — Made `AERow`, `AEMeta`, `AEResult` types non-exported (internal to module).
- **`src/services/kv-cache.ts`** — Made `kvKey()` non-exported (internal helper).
- **`src/services/useragent.ts`** — Made `UAInfo` interface non-exported.
- **`src/env.d.ts` (NEW)** — Declares secrets (`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `ADMIN_EMAILS`) and optional OAuth vars on `Cloudflare.Env` via interface merging. These are set via `wrangler secret put` and not generated by `wrangler types`.
- **`tsconfig.json`** — Removed unused `paths` alias (`@/*`). Removed `globals: true` from vitest config.

#### Frontend: Shared UI utilities
- **`frontend/src/lib/ui.js` (NEW)** — Extracted 5 shared helpers used across all views:
  - `SPINNER` — Loading state HTML constant
  - `apiFetch(url, opts)` — Fetch wrapper with 401 redirect and error toast (returns parsed JSON or null)
  - `withLoadingBtn(btn, fn)` — Button loading/disabled guard
  - `shortUrl(link)` — Construct short URL from link object (domain-aware)
  - `emptyState(icon, message)` — Empty state with icon HTML
  - `bindConfirmDialog({ dialog, confirmBtn, cancelBtn, onConfirm })` — Confirm dialog wiring
  - `bindSearchInput(input, onSearch, opts)` — Debounced search with wa-clear support

#### Frontend: Views refactored
- **All views** (`admin.js`, `dashboard.js`, `link-detail.js`, `campaign-detail.js`, `campaigns.js`, `settings.js`, `teams.js`, `team-detail.js`, `login.js`) — Replaced inline fetch+error+loading patterns with `apiFetch()` and `withLoadingBtn()`. Net reduction: ~650 lines removed across frontend.
- **`login.js`** — Added error handling for single-provider auto-redirect (catches failed social sign-in). Shows "Failed to load login providers" on provider fetch failure instead of rendering empty buttons.
- **`campaign-detail.js`** — Fixed `wa-textarea` value assignment (set programmatically, not via HTML attribute). Used `#campaign-link-count` ID instead of fragile `.wa-heading-xl` selector.
- **`settings.js`** — Fixed `wa-textarea` value for access emails (set programmatically after render). Passkey delete now uses `authClient.passkey.deletePasskey()` instead of raw fetch to `/api/auth/passkey/delete-passkey`.

#### Frontend: WA component fixes
- **`wa-select` values** — Replaced `selected` attribute on `wa-option` with `value` attribute on `wa-select` parent (correct WA pattern). Applied in `link-form.js`, `dashboard.js`, `settings.js`.
- **`wa-flank`** — Fixed `wa-flank:end` to `wa-flank` (`:end` is not valid class syntax).
- **`wa-icon variant`** — Fixed `variant="regular"` to `variant="solid"` in `campaigns.js` (FA Free has no regular variant).
- **`wa-input hint`** — Fixed `slot="hint"` to `slot="help-text"` in `teams.js`.

#### Frontend: Build & helpers
- **`frontend/esbuild.mjs`** — Sourcemaps only in watch mode (`--watch` flag), not production builds.
- **`frontend/src/lib/chart-helper.js`** — Fixed typo: `--wa-color-wa-color-text-quiet` → `--wa-color-text-quiet`.
- **`frontend/src/lib/escape.js`** — Removed unnecessary `>` escaping in `escapeAttr()` (not required in HTML attributes).
- **`frontend/src/lib/stats-common.js`** — Added `cardError()` helper (wraps `noData()` in `wa-card`).
- **`frontend/src/components/link-table.js`** — Uses shared `shortUrl()` from `ui.js`.
- **`frontend/src/components/stats-devices.js`, `stats-geo.js`, `stats-referrers.js`** — Use `cardError()` for error states.

#### Test infrastructure
- **`test/helpers.ts`** — Expanded `createTestLink()` to support all M3+ fields (expiresAt, maxClicks, password, isInternal, ogTitle, ogDescription, ogImage, paramForwarding). Added shared helpers: `createTestDomain()`, `insertClickStat()`, `apiRequest()`. These replace duplicated setup code across test files.
- **`test/integration/app.test.ts`** — Removed redundant CORS tests (CORS behavior already covered by other integration tests).
- **Test files** (`auth-apikey`, `campaigns`, `keys`, `links-domain`, `domains`, `bulk`, `links`, `reports`, `redirect-advanced`, `stats`) — Use shared `apiRequest()` and `createTestDomain()` helpers instead of inline implementations.
- **`test/unit/providers.test.ts`** — Updated for new `Record<string, ...>` return type (was `Map`).
- **`test/unit/constants.test.ts`** — Imports from `slug.ts` instead of deleted `constants.ts`.
- **`test/unit/slug.test.ts`** — Imports from `slug.ts` instead of deleted `constants.ts`.
- **`vitest.config.ts`** — Removed `globals: true` (explicit imports preferred).

### Verification
- All existing tests pass after refactoring
- No new features or API surface changes
- `wrangler dev` + frontend builds correctly
- Auth, links, campaigns, teams, stats all function as before
- Security headers (CSP) applied to all responses
- Redirect URL validation prevents open redirect via domain config

### Implementation Notes

**Implemented 2026-03-25. All M8 files complete.**

#### Design decisions
- **`apiFetch()` returns null on failure**: Callers check `if (!result) return;` — this eliminates try/catch/finally boilerplate. Toast and 401 redirect are handled once.
- **`withLoadingBtn()` does NOT catch errors**: It only manages the loading/disabled state. Error handling is the caller's responsibility (typically via `apiFetch()` returning null).
- **`user?: AuthUser` in AppEnv**: The `user` variable is set by auth middleware, which doesn't run on all routes (e.g. `/api/auth/*`, `/:slug`). Making it optional is type-correct. Route handlers behind auth middleware use `c.var.user!`.
- **`constants.ts` deleted**: The slug pattern and reserved slugs were only used in `slug.ts`. Co-locating them eliminates a module that existed solely for two constants.
- **`requireTeamMember` extracted to `lib/team.ts`**: Used in teams, links (for team-scoped operations), and stats (for team member access). The `Database` type is imported from `db/index.ts`.
- **`validateDomainAccess` extracted to `lib/validators.ts`**: Used in links create/update and bulk create. Co-located with `validateHttpUrl` since both are input validation helpers.
- **`isSafeRedirectUrl()` in redirect.ts**: Prevents open redirect via malicious `rootRedirect`/`notFoundRedirect` in domain_config (defense in depth — admin controls these values, but validates at point of use).
- **`crypto.subtle.timingSafeEqual()`**: Available in Workers runtime. Replaces manual XOR loop for password verification — more correct and harder to accidentally break.
- **Report token simplified**: `crypto.randomUUID()` with dashes stripped provides 122 bits of entropy, sufficient for public report tokens. The previous rejection sampling approach was over-engineered.
- **Sourcemaps in dev only**: Production builds don't need sourcemaps and they add ~30% to bundle size.
- **CORS handler singleton**: `cors()` is now instantiated once rather than per-request. The origin callback reads `env.BETTER_AUTH_URL` at call time via the Hono context parameter, so it still works correctly with different env bindings.
- **Stats team access**: Team members can now view stats for links owned by their team. The middleware checks `link.teamId` and validates membership before allowing access.

#### Files created
- `frontend/src/lib/ui.js` — Shared frontend UI utilities
- `src/env.d.ts` — Secret/optional env var declarations (augments generated `Env`)
- `src/lib/team.ts` — `requireTeamMember()` helper
- `src/lib/validators.ts` — `validateHttpUrl()`, `validateDomainAccess()` helpers

#### Files deleted
- `src/lib/constants.ts` — Constants moved to `src/services/slug.ts`

---

## Migration Sequence

| File | Milestone | Tables |
|------|-----------|--------|
| `0000_initial.sql` | M1 ✅ | user, session, account, verification, passkey, links, link_stats |
| `0001_link_features.sql` | M3 | ALTER links (+expiration, password, internal, OG) |
| `0002_campaigns_targeting.sql` | M4 | campaigns, link_campaigns, link_targets, ALTER links |
| `0003_custom_domains.sql` | M5 | domains (original, superseded by 0004) |
| `0004_simplified_domains.sql` | M5 | domain_config, domain_access, ALTER links (+domainHostname), DROP domains |
| `0004_api_keys.sql` | M6 ✅ | api_keys, public_reports |
| `0005_teams.sql` | M7 | teams, team_members, team_invites, ALTER links/user |
| (none) | M8 | No schema changes — refactoring only |

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
  "compatibility_flags": ["nodejs_compat_v2"],  // Required for Better Auth
  "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": true },
  "placement": { "mode": "smart" },  // Route requests to colo nearest D1 to reduce latency
  "observability": {
    "enabled": true,
    "logs": { "head_sampling_rate": 1 }
  },
  "env": {
    "staging": { /* separate D1, KV, AE bindings */ }
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

Note: `@cloudflare/workers-types` is not a separate dep — `wrangler types` generates `worker-configuration.d.ts` directly. The original `src/bindings.ts` was deleted in M6; all env types now come from the generated file.
