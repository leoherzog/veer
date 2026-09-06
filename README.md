# 🔗 Veer

## What is this?

[Veer](https://demo.veer.ing/) is a self-hostable URL shortener that runs entirely on [Cloudflare Workers](https://workers.cloudflare.com/), with no servers, no containers, and no per-domain costs. It uses D1 for storage, KV for the redirect cache, and Analytics Engine for per-click events — every one of which has a free Cloudflare tier, so a personal instance costs nothing to run. Any hostname you point at the Worker can serve the app or act as a branded short domain.

### Features

- 🔗 Custom shortlink slugs served from any number of your own domains
- 📊 Click analytics infographs broken down by timeline, geographic, device, and referrer
- 🗺️ Geo-, device-, and A/B-targeted destinations, grouped into campaigns
- 🔒 Password-protected, expiring, click-capped, and sign-in-only links
- 🖼️ Per-link Open Graph title, description, and image — crawlers see the preview even on password-protected links
- 📱 A QR code for every link, with custom colors and PNG download
- 👥 Teams with shared link ownership, member roles, and email invitations
- 🔑 OAuth sign-in with Google, GitHub, Microsoft, and Discord, plus optional passkeys
- 🤖 A REST API with Bearer keys for links, campaigns, stats, and bulk creation, metered at an advisory 60 requests/minute per key
- 🎨 Set the branding on the entire instance with one environment variable

## Self-Hosting

### Prerequisites

- Node.js 22+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A domain with its nameservers pointed at Cloudflare

### Quick Start

```bash
# Clone and install
git clone git@github.com:leoherzog/veer.git && cd veer && npm install

# Login to Cloudflare
npx wrangler login

# Create the database and cache
npx wrangler d1 create veer-db
npx wrangler kv namespace create KV
```

Both commands print an ID. Open `wrangler.jsonc` and paste them in, then set `BETTER_AUTH_URL` to the hostname you'll serve from and add a route for it:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "veer-db", "database_id": "<paste-d1-id>", "migrations_dir": "drizzle/migrations" }
],
"kv_namespaces": [
  { "binding": "KV", "id": "<paste-kv-id>" }
],
"vars": {
  "WORKER_NAME": "veer",
  "BETTER_AUTH_URL": "https://links.example.com",
  "INSTANCE_NAME": "",
  "DEMO_MODE": ""
},
"routes": [
  { "pattern": "links.example.com", "custom_domain": true }
]
```

> [!IMPORTANT]
> `BETTER_AUTH_URL` has to exactly match the hostname you serve from, or sign-in cookies and OAuth callbacks won't work.

> [!IMPORTANT]
> `WORKER_NAME` has to match the `name` field at the top of `wrangler.jsonc`. Domain sync asks the Cloudflare API which hostnames route to the Worker of that name, so a mismatch imports another Worker's hostnames.

Two of the secrets come from Cloudflare, so have them ready before you start — each `wrangler secret put` prompts you to paste the value:

- **`CF_ACCOUNT_ID`** — run `npx wrangler whoami`, which prints your Account ID.
- **`CF_API_TOKEN`** — create one at [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → `Create Custom Token`, with two permissions: **Account · Account Analytics · Read**, to query click stats, and **Account · Workers Scripts · Read**, so the domain sync can list the hostnames routed to your Worker.

Then create the tables and set your secrets:

```bash
# Create the tables
npx wrangler d1 migrations apply veer-db --remote

# A random string, 32 characters or longer
npx wrangler secret put BETTER_AUTH_SECRET

# Comma-separated. Include your own address, or you'll have no admin
npx wrangler secret put ADMIN_EMAILS

# The two Cloudflare values from above — these power the stats dashboard
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN

# At least one OAuth pair. Google, GitHub, Microsoft, and Discord are supported,
# and each provider turns itself on once both of its values are present
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# Deploy
npm run deploy
```

Finally, register the callback URL with each OAuth provider you configured. Replace `{provider}` with `google`, `github`, `microsoft`, or `discord`:

```
https://links.example.com/api/auth/callback/{provider}
```

### A Note on Free Tier Limits

You can run Veer entirely on the Workers Free plan.

| Limit | Free tier | What consumes it |
| --- | --- | --- |
| [KV writes](https://developers.cloudflare.com/kv/platform/pricing/) | **1,000/day** | One cache fill per slug per week (the redirect cache holds each for 7 days), one per link created, edited, or bulk-imported, and one per rate-limit counter — API-key requests, password attempts, and public-report views |
| [Worker requests](https://developers.cloudflare.com/workers/platform/pricing/) | 100,000/day | Every redirect and API call. Static assets are free and unlimited |
| [D1 rows written](https://developers.cloudflare.com/d1/platform/pricing/) | 100,000/day | One daily-aggregate upsert per click |
| [Analytics Engine writes](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | 100,000/day | One event per click |
| [KV deletes](https://developers.cloudflare.com/kv/platform/pricing/) | **1,000/day** | One per link deleted. A `Settings → Domains → Sync` that drops a domain clears the cache for every link on it, one delete each |

KV has room for roughly 7,000 actively-hit slugs. The other three scale with traffic instead, at around 100,000 clicks per day. Which one you reach first depends on your mix. Signed-in dashboard browsing isn't metered.

### Additional Domains

Point another domain at the Worker as a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) in the Cloudflare dashboard, then open `Settings → Domains` in Veer and click `Sync`. No other setup required. The same slug will live on different domains, and each domain gets its own root and 404 redirects.

> [!WARNING]
> `Sync` also removes domains Cloudflare no longer routes to the Worker, **and deletes every link on them**. Move links you want to keep to another domain before you unroute one.

### Optional Settings

Set these in the `vars` block of `wrangler.jsonc`, or as secrets where noted:

| Setting | Effect |
| --- | --- |
| `INSTANCE_NAME` | Renames the instance everywhere in the UI. Defaults to "Veer" when empty |
| `PASSKEY_ENABLED` | Set to `true` (as a secret) to offer passkey sign-in alongside OAuth |
| `DEMO_MODE` | Set to `true` to turn the deployment into a public read-only showcase — auth is bypassed, all writes return `403`, and an hourly cron generates synthetic traffic |

### Demo Instance

`wrangler.jsonc` carries a `demo` environment with its own database, KV namespace, and Analytics Engine dataset. Every command aimed at it takes `--env demo`:

```bash
npx wrangler d1 migrations apply veer-db-demo --remote --env demo
npm run seed:remote          # generates the fixtures and applies them with --env demo
npx wrangler deploy --env demo
```

### Local Development

```bash
cp .dev.vars.example .dev.vars   # then fill it in
npm run dev
```

`npm run dev` migrates a local D1, builds the frontend, and starts Wrangler at `http://localhost:8787` with esbuild watching for changes. `npm test` runs the suite against a real workerd instance, and `npm run seed:local` fills your local database with the demo fixtures.

`npm run build` and `npm run typecheck` both run `wrangler types` first, which writes `worker-configuration.d.ts` from `wrangler.jsonc` and your `.dev.vars`. The file is generated and not checked in.

### Updating

```bash
git pull && npm install && npx wrangler d1 migrations apply veer-db --remote && npm run deploy
```

- - -

Feel free to take a look at the source and adapt as you please. I would love to see some pull requests for improvements.

Veer is licensed under the [MIT License](LICENSE).

- - -

## About Me

<a href="https://herzog.tech/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/link-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/link.svg.png">
    <img src="https://herzog.tech/signature/link.svg.png" width="32px">
  </picture>
</a>
<a href="https://mastodon.social/@herzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mastodon-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mastodon.svg.png">
    <img src="https://herzog.tech/signature/mastodon.svg.png" width="32px">
  </picture>
</a>
<a href="https://github.com/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/github-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/github.svg.png">
    <img src="https://herzog.tech/signature/github.svg.png" width="32px">
  </picture>
</a>
<a href="https://keybase.io/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/keybase-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/keybase.svg.png">
    <img src="https://herzog.tech/signature/keybase.svg.png" width="32px">
  </picture>
</a>
<a href="https://www.linkedin.com/in/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/linkedin-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/linkedin.svg.png">
    <img src="https://herzog.tech/signature/linkedin.svg.png" width="32px">
  </picture>
</a>
<a href="https://hope.edu/directory/people/herzog-leo/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/anchor-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/anchor.svg.png">
    <img src="https://herzog.tech/signature/anchor.svg.png" width="32px">
  </picture>
</a>
<br />
<a href="https://herzog.tech/$" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png">
    <img src="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png" alt="Buy Me A Tea" width="32px">
  </picture>
  Found this helpful? Buy me a tea!
</a>
