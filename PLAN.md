# Veer - URL Shortener Implementation Plan

## Context

Veer is a self-hostable URL shortener built on Cloudflare Workers. The goal is a clean, modular product that anyone can `git clone`, configure OAuth secrets via `.dev.vars` / `wrangler secret set`, and deploy with `wrangler deploy`. The architecture uses one Worker, one D1 database, one KV namespace, and one Analytics Engine dataset. The UI is an esbuild-bundled JS SPA using Web Awesome Pro components, with Better Auth handling OAuth.

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
| UI | **Web Awesome Pro v3.3.1** | npm package, bundled via esbuild, `wa-` prefix, 60+ components |
| Theme | **Matter** (Pro) | Mild palette, Purple brand color, light/dark mode via `wa-light`/`wa-dark` |
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
  .npmrc                       # FA/WA registry config
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
        domains.ts             # /api/domains (M5)
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
      views/
        home.js                # Landing / quick shorten ✅
        dashboard.js           # Link list (authenticated) ✅
        link-detail.js         # Single link + stats ✅
        login.js               # OAuth provider buttons (dynamic from /api/auth/providers) ✅
        settings.js            # User settings, API keys, domains (M6)
        campaigns.js           # Campaign management (M4)
        admin.js               # Admin panel (M7)
      components/
        link-form.js           # Create/edit link form ✅
        link-table.js          # HTML table + WA styling + pagination ✅
        stats-charts.js        # wa-line-chart, wa-bar-chart, wa-pie-chart (M2)
        nav-bar.js             # Top nav with user avatar, login/logout, theme toggle ✅
        toast.js               # wa-toast notification helper ✅
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

## Theming: Matter + Light/Dark Mode

Veer uses the **Matter** Pro theme with the **Mild** color palette and **Purple** brand color. Matter provides a clean, modern look with pill-shaped buttons, floating form labels, subtle ripple effects, and rounded panels.

### Setup

The theme CSS is imported via esbuild from npm. The `<html>` element receives both the theme and palette classes:

```html
<html class="wa-theme-matter wa-palette-mild wa-light" lang="en">
```

**Theme import** (in `frontend/src/app.js`, bundled by esbuild):
```js
import '@web.awesome.me/webawesome-pro/dist/styles/themes/matter.css';
```

The `matter.css` file automatically imports the Mild palette and loads fonts from `fonts.bunny.net`:
- **Body**: Wix Madefor Text (sans-serif)
- **Code**: Roboto Mono (monospace)
- **Longform**: Roboto Serif (serif)

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

### Key Design Tokens (Matter)

| Token | Value |
|-------|-------|
| `--wa-color-brand-fill-loud` | Purple brand (buttons, active states) |
| `--wa-color-surface-default` | White (light) / Neutral-05 (dark) |
| `--wa-color-surface-raised` | Neutral-95 (light) / Neutral-10 (dark) — cards, panels |
| `--wa-border-radius-l` | Rounded panels (`border-radius-scale: 1.33`) |
| `--wa-form-control-border-radius` | Pill-shaped buttons (`border-radius-pill` in Matter) |
| `--wa-font-family-body` | Wix Madefor Text |

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
| PUT | `/api/links/:id` | Yes | Update link (destination, slug, redirectType, title) |
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
button, icon, button-group, input, card, details, avatar, spinner, toast, copy-button, radio-group, radio, skeleton

#### Frontend routes
| Path | View | Auth required |
|------|------|---------------|
| `/` | home | No (shows marketing splash or create form) |
| `/login` | login | No (redirects to home if logged in) |
| `/dashboard` | dashboard | Yes (redirects to login) |
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

### Chart Components (Web Awesome Pro)

All charts use WA Pro's Chart.js wrappers (since v3.3). They auto-theme to light/dark mode via CSS custom properties, require no Chart.js boilerplate, and accept data via the reactive `config` property for dynamic API-driven rendering.

**Imports** (bundled by esbuild from npm):
```js
import '@web.awesome.me/webawesome-pro/dist/components/line-chart/line-chart.js';
import '@web.awesome.me/webawesome-pro/dist/components/bar-chart/bar-chart.js';
import '@web.awesome.me/webawesome-pro/dist/components/doughnut-chart/doughnut-chart.js';
```

#### Clicks Over Time — `<wa-line-chart>`

Primary analytics view. Fetches `/api/stats/:linkId/timeseries` and sets `config` dynamically.

```html
<wa-line-chart
  id="clicks-timeline"
  x-label="Date"
  y-label="Clicks"
  min="0"
  label="Clicks Over Time"
  description="Line chart showing total and unique clicks over the selected time period"
>
</wa-line-chart>
```
```js
// frontend/src/components/stats-charts.js
const chart = document.querySelector('#clicks-timeline');
const data = await fetch(`/api/stats/${linkId}/timeseries?period=day`).then(r => r.json());

chart.config = {
  data: {
    labels: data.labels,           // ["Mar 1", "Mar 2", ...]
    datasets: [
      { label: 'Total Clicks', data: data.clicks, fill: true },
      { label: 'Unique Clicks', data: data.uniqueClicks }
    ]
  }
};
```

Key attributes used: `x-label`, `y-label`, `min="0"`, `fill: true` on the primary dataset for area emphasis. Period selector (hour/day/week) re-fetches and reassigns `config` to trigger re-render.

#### Device & Browser Breakdown — `<wa-doughnut-chart>`

Doughnut charts for proportional data. Hollow center works well in dashboard card layouts.

```html
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
  <wa-doughnut-chart
    id="browsers-chart"
    legend-position="bottom"
    label="Browser Breakdown"
    description="Doughnut chart showing click distribution across browsers"
  ></wa-doughnut-chart>

  <wa-doughnut-chart
    id="os-chart"
    legend-position="bottom"
    label="OS Breakdown"
    description="Doughnut chart showing click distribution across operating systems"
  ></wa-doughnut-chart>
</div>
```
```js
const browsersChart = document.querySelector('#browsers-chart');
const devicesData = await fetch(`/api/stats/${linkId}/devices`).then(r => r.json());

browsersChart.config = {
  data: {
    labels: devicesData.browsers.map(b => b.name),   // ["Chrome", "Safari", "Firefox", ...]
    datasets: [{ label: 'Clicks', data: devicesData.browsers.map(b => b.clicks) }]
  }
};
```

Separate doughnut charts for browsers, OS, and device type (desktop/mobile/tablet). Custom slice colors via `--fill-color-*` / `--border-color-*` CSS custom properties if the default 6-color palette needs extending.

#### Top Referrers — `<wa-bar-chart>`

Horizontal bars to accommodate long referrer domain names.

```html
<wa-bar-chart
  id="referrers-chart"
  orientation="horizontal"
  without-legend
  label="Top Referrers"
  description="Horizontal bar chart showing top traffic sources"
></wa-bar-chart>
```
```js
const refChart = document.querySelector('#referrers-chart');
const refData = await fetch(`/api/stats/${linkId}/referrers`).then(r => r.json());

refChart.config = {
  data: {
    labels: refData.map(r => r.source),    // ["google.com", "twitter.com", ...]
    datasets: [{ label: 'Clicks', data: refData.map(r => r.clicks) }]
  }
};
```

Uses `without-legend` since there's only one dataset. `orientation="horizontal"` renders bars left-to-right.

#### Geographic Breakdown — `<wa-bar-chart>`

Top countries as a vertical bar chart, with optional drill-down to cities.

```html
<wa-bar-chart
  id="geo-chart"
  without-legend
  x-label="Country"
  y-label="Clicks"
  label="Clicks by Country"
  description="Bar chart showing click distribution across countries"
></wa-bar-chart>
```

#### Shared Patterns

- **Dynamic data**: All charts set `config` property after API fetch. `config` is shallowly reactive — reassigning triggers re-render automatically.
- **Dark mode**: Charts auto-adapt when `wa-light` ↔ `wa-dark` toggles on `<html>`. The Matter theme's Mild palette provides distinct light/dark surface and text colors; chart grid lines, fills, and borders all update automatically via CSS custom properties.
- **Theming**: Default 6-color chart palette (blue, pink, green, yellow, purple, orange) works well with Matter's Mild palette. Override `--fill-color-1` through `--fill-color-6` and `--border-color-1` through `--border-color-6` for custom palettes. Colors support `var(--wa-color-*)` and `color-mix()`.
- **Accessibility**: Every chart gets `label` (short name, maps to `aria-label`) and `description` (insight-oriented text for screen readers).
- **Chart.js access**: After render, `chart.chart` exposes the raw Chart.js instance for programmatic updates or image export.

### New Files
- `src/routes/api/stats.ts` - Stats endpoints (queries AE SQL API, falls back to D1)
- `src/services/useragent.ts` - Lightweight UA parser (regex, no library)
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
- New `frontend/src/components/qr-code.js` using `wa-qr-code` with PNG/SVG download
- Password gate page served inline when password-protected link is visited

### Verification
- Expired link returns 410 Gone
- maxClicks link stops redirecting after threshold
- Password-protected link shows form, correct password redirects
- Internal link requires auth
- QR code renders and downloads as PNG/SVG

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

---

## Milestone 5: Custom Domains & Branding

**Delivers**: Custom branded domains, root/404 redirects, branded QR codes.

### New Table
- `domains` (id, userId, hostname UNIQUE, isVerified, rootRedirect?, notFoundRedirect?, createdAt, updatedAt)
- ALTER links: add `domainId` TEXT? FK

### Key Changes
- `redirect.ts` - Resolve domain from Host header, scope slug lookup by domain
- `kv-cache.ts` - KV key format: `{hostname}:{slug}` for custom domains, bare `{slug}` for default
- Domain CRUD with DNS verification
- Branded QR codes with customizable colors/logo

### Verification
- Add custom domain, verify DNS, create link on it
- `brand.co/slug` redirects correctly
- Root domain and 404 redirects work

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
| `0003_custom_domains.sql` | M5 | domains, ALTER links (+domainId) |
| `0004_api_keys.sql` | M6 | api_keys, public_reports |
| `0005_teams.sql` | M7 | teams, team_members, team_invites, ALTER links/user |
| `0006_ab_testing.sql` | M8 | ab_tests, ab_variants |

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
- `CF_ACCOUNT_ID` - Cloudflare account ID (not secret, used for AE API URL)
- `PASSKEY_ENABLED` - Set to `"true"` to enable WebAuthn passkey login (optional, no extra secrets needed)

---

## Dependencies (as installed)

**Runtime**: `hono@^4.12.5`, `better-auth@^1.5.5`, `@better-auth/passkey@^1.5.5`, `drizzle-orm@^0.45.1`, `@web.awesome.me/webawesome-pro@^3.3.1`
**Dev**: `wrangler@^4.74.0`, `drizzle-kit@^0.31.9`, `typescript@^5.9.3`, `esbuild@^0.27.3`
**Frontend (bundled by esbuild)**: `better-auth/client` + `@better-auth/passkey/client` (from runtime deps), `@web.awesome.me/webawesome-pro` (components + theme CSS)

Note: `@cloudflare/workers-types` is not a separate dep — `wrangler types` generates `bindings.ts` directly.
