# Features

The implemented product surface. Each bullet corresponds to shipped code — see `AGENTS.md` for architecture.

### 1. URL Management & Shortening
*   **Custom branded short URLs:** Serve links from any number of your own domains (e.g. `YourBrand.co/keyword`).
*   **Custom slugs:** Slugs are user-chosen and required — no auto-generated gibberish. Same slug can exist on different domains. Any URL-safe character works, including non-ASCII and emoji (`/🎉`), and slugs are case-insensitive: `/Blah` resolves to `/blah`, and only one of the two can exist.
*   **Editable links:** Change the destination URL, title, and settings at any time (the slug itself is immutable).
*   **Redirect type:** Choose 301 (permanent) or 302 (temporary) per link.
*   **Bulk creation:** Paste `slug, url, title` lines into the bulk tool or POST a JSON array to the API (up to 50 links per request, with per-item validation errors). Only the first two commas delimit fields, so a title may contain commas.
*   **Link expiration:** Expire links after a date or after a maximum number of clicks.
*   **Password protection:** Gate any link behind a password (PBKDF2-hashed, rate-limited, works without JavaScript).
*   **Internal links:** Require a signed-in session before redirecting. Available on the default domain only, since the session cookie is host-only to it.
*   **Social preview control:** Set custom Open Graph title, description, and image per link; crawlers see the preview even on password-protected links.
*   **Param forwarding:** Optionally pass query parameters from the short link through to the destination.

### 2. Analytics & Reporting
*   **Dual-storage stats:** Detailed per-click events retained ~90 days (Analytics Engine) plus permanent daily aggregates (D1), so lifetime totals never expire.
*   **Timeline charts:** Click trends by hour, day, or week over a selectable time range.
*   **Geographic analytics:** Clicks by country and city, in list and choropleth-map views.
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
*   **Campaigns:** Group links into campaigns with aggregated click totals.

### 5. Domains & Branding
*   **Multiple custom domains:** Admin-synced from the Cloudflare API — no DNS verification dance. SSL is automatic via Cloudflare.
*   **Root & 404 redirects:** Per-domain redirects for the bare domain and for unknown slugs.
*   **Instance branding:** Rename the whole instance via `INSTANCE_NAME` — no hardcoded product name anywhere.

### 6. API & Automation
*   **REST API:** Full link, campaign, stats, and bulk management with Bearer API keys (`veer_` prefix, up to 10 per user, revocable, optional expiry).
*   **Stats API:** Pull click statistics into BI tools or dashboards.
*   **Rate limiting:** Advisory per-key limits on API traffic; session traffic is unmetered.

### 7. Teams, Auth & Admin
*   **OAuth sign-in:** Google, GitHub, Microsoft, and Discord — each enabled simply by setting its env-var credential pair.
*   **Passkeys (WebAuthn):** Optional passwordless sign-in, gated by `PASSKEY_ENABLED`.
*   **Teams:** Shared link ownership with member roles and email-token invitations.
*   **Admin oversight:** Per-user link quotas and account impersonation for troubleshooting, driven by an `ADMIN_EMAILS` allowlist (no role column).

### 8. Self-Hosting
*   **Runs entirely on Cloudflare Workers:** D1 (SQLite) + KV + Analytics Engine + static assets — no servers, no containers.
*   **No hardcoded domains:** Any hostname can serve the app or act as a branded short domain.
*   **Demo mode:** One env var turns a deployment into a read-only public showcase with seeded links and synthetic traffic.
