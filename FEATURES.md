# Features

The implemented product surface. Each bullet corresponds to shipped code; see `AGENTS.md` for architecture.

### 1. URL Management & Shortening
*   **Custom branded short URLs:** Serve links from any number of your own domains (e.g. `YourBrand.co/keyword`).
*   **Custom slugs:** Slugs are user-chosen and required, never auto-generated gibberish. The same slug can exist on different domains. Letters and numbers in any script work, as do URL-safe punctuation and any emoji, including flags, skin tones and tag sequences such as `/🎉`, `/🇺🇸` and `/👍🏽`. The one exception is the `#` keycap, whose `#` would end the path. Slugs are case-insensitive: `/Blah` resolves to `/blah`, and only one of the two can exist.
*   **Editable links:** Change the destination URL, title, and settings at any time (the slug itself is immutable).
*   **Redirect type:** Choose 301 (permanent) or 302 (temporary) per link.
*   **Bulk creation:** Paste `slug, url, title` lines into the bulk tool or POST `{ "links": [...] }` to `/api/bulk` (up to 50 links per request). Only the first two commas delimit fields, so a title may contain commas. A pasted line missing its slug or URL stops the batch before anything is sent. Each link that fails server-side validation is reported on its own while the rest are created.
*   **Link expiration:** Expire links after a date or after a maximum number of clicks.
*   **Password protection:** Gate any link behind a password (PBKDF2-hashed, rate-limited, works without JavaScript).
*   **Internal links:** Require a signed-in session before redirecting. Available on the default domain only, since the session cookie is host-only to it.
*   **Social preview control:** Set custom Open Graph title, description, and image per link; crawlers see the preview even on password-protected links.
*   **Param forwarding:** Optionally pass query parameters from the short link through to the destination.

### 2. Analytics & Reporting
*   **Dual-storage stats:** Detailed per-click events retained ~90 days (Analytics Engine) plus permanent daily aggregates (D1), so lifetime totals never expire.
*   **Timeline charts:** Click trends by hour or day over a selectable range, plus weekly buckets through the API.
*   **Geographic analytics:** Clicks by country and city, as a choropleth map and bar charts.
*   **Device & platform data:** Top browsers, operating systems, and device types (mobile/tablet/desktop).
*   **Referrer tracking:** See which sites drive traffic to each link.
*   **A/B variant stats:** Per-variant click breakdown for split-tested links.
*   **Public reports:** Opt in from a link's page to publish its stats at a shareable tokenized URL. No report exists until you enable one, and enabling can be reversed.

### 3. QR Codes
*   **Per-link QR codes:** Rendered for every short URL, with customizable foreground/background colors and PNG download.

### 4. Targeting & Campaigns
*   **Geo-targeting:** Redirect visitors to different destinations by country.
*   **Device targeting:** Redirect by device type (mobile, tablet, desktop).
*   **A/B testing:** Weighted random split across multiple destination URLs.
*   **Campaigns:** Group links into campaigns with aggregated click totals. Add any link you can reach, team links included, from a searchable picker. Each campaign is private to its owner.

### 5. Domains & Branding
*   **Multiple custom domains:** Admin-synced from the Worker's Custom Domains in the Cloudflare API, with no DNS verification dance. SSL is automatic via Cloudflare.
*   **Root & 404 redirects:** Each custom domain can redirect its bare domain and its unknown slugs.
*   **Instance branding:** Rename the whole instance via `INSTANCE_NAME`. No product name is hardcoded anywhere.

### 6. API & Automation
*   **REST API:** Full link, campaign, stats, and bulk management with Bearer API keys (`veer_` prefix, up to 10 per user, revocable, optional expiry).
*   **Stats API:** Pull click statistics into BI tools or dashboards.
*   **Rate limiting:** Advisory per-key limits on API traffic and per-IP limits on public reports; session traffic is unmetered.

### 7. Teams, Auth & Admin
*   **OAuth sign-in:** Google, GitHub, Microsoft, and Discord, each enabled simply by setting its env-var credential pair. Sign-up requires an email address the provider has verified.
*   **Passkeys (WebAuthn):** Optional passwordless sign-in, gated by `PASSKEY_ENABLED`.
*   **Teams:** Shared link ownership with member roles and copyable invite links bound to an email address.
*   **Admin oversight:** Per-user link quotas and instance-wide user and team lists, driven by an `ADMIN_EMAILS` allowlist (no role column). "Impersonate" only marks the admin's browser tab with a banner: the session never switches, so every request still runs as the admin.

### 8. Self-Hosting
*   **Runs entirely on Cloudflare Workers:** D1 (SQLite) + KV + Analytics Engine + Rate Limiting + static assets, with no servers and no containers.
*   **No hardcoded domains:** Any hostname can serve the app or act as a branded short domain.
*   **Demo mode:** One env var turns a deployment into a read-only public showcase with seeded links and synthetic traffic.
