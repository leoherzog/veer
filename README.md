# 🔗 Veer

## What is this?

[Veer](https://demo.veer.ing/) is a self-hostable URL shortener that runs entirely on [Cloudflare Workers](https://workers.cloudflare.com/), with no servers, no containers, and no per-domain costs. It uses D1 for storage, KV for the redirect cache, and Analytics Engine for per-click events. Each has a free Cloudflare tier, so a personal instance costs nothing to run. Any hostname you point at the Worker can serve the app or act as a branded short domain.

### Features

- 🔗 Custom shortlink slugs served from any number of your own domains
- 📊 Click analytics infographs broken down by timeline, geographic, device, and referrer
- 🗺️ Geo-, device-, and A/B-targeted destinations, grouped into campaigns
- 🔒 Password-protected, expiring, click-capped, and sign-in-only links
- 🖼️ Per-link Open Graph title, description, and image, which crawlers see even on password-protected links
- 📱 A QR code for every link, with custom colors and PNG download
- 👥 Teams with shared link ownership, member roles, and email-bound invite links
- 🔑 OAuth sign-in with Google, GitHub, Microsoft, and Discord, plus optional passkeys
- 🤖 A REST API with Bearer keys for links, campaigns, stats, and bulk creation, metered at an advisory 60 requests/minute per key
- 🎨 Set the branding on the entire instance with one environment variable

## Self-Hosting

### Prerequisites

- Node.js 22.18+, 24, or 26+
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
  "DEMO_MODE": "",
  "AE_DATASET": "veer_clicks"
},
"routes": [
  { "pattern": "links.example.com", "custom_domain": true }
]
```

> [!IMPORTANT]
> `BETTER_AUTH_URL` has to exactly match the hostname you serve from, or sign-in cookies and OAuth callbacks won't work.

> [!IMPORTANT]
> `WORKER_NAME` has to match the `name` field at the top of `wrangler.jsonc`. Domain sync asks the Cloudflare API which Custom Domains attach to the Worker of that name, so a mismatch imports another Worker's hostnames.

> [!IMPORTANT]
> `AE_DATASET` has to match the `dataset` in `analytics_engine_datasets`. Stats queries read the dataset it names, so a missing or wrong value drops stats to daily totals with no geo, device, referrer or A/B breakdown.

The `ratelimits` block needs no edit unless another Worker on your account already uses `namespace_id` `1001` or `1002`. The ids are account-wide, so two bindings with the same one share their counters.

Two of the secrets come from Cloudflare, so have them ready before you start. Each `wrangler secret put` prompts you to paste the value:

- **`CF_ACCOUNT_ID`**: run `npx wrangler whoami`, which prints your Account ID.
- **`CF_API_TOKEN`**: create one at [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → `Create Custom Token`, with two permissions: **Account · Account Analytics · Read**, to query click stats, and **Account · Workers Scripts · Read**, so the domain sync can list your Worker's Custom Domains.

Then create the tables and set your secrets:

```bash
# Create the tables
npx wrangler d1 migrations apply veer-db --remote

# A random string, 32 characters or longer
npx wrangler secret put BETTER_AUTH_SECRET

# Comma-separated. Include your own address, or you'll have no admin
npx wrangler secret put ADMIN_EMAILS

# The two Cloudflare values from above, for stats and domain sync
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

> [!IMPORTANT]
> Veer refuses a sign-up whose provider has not verified the email address, and the callback lands on `/api/auth/error?error=unable_to_create_user`. Google, GitHub, and Discord report verification without extra setup. Microsoft reports it only through optional claims: add `verified_primary_email` and `verified_secondary_email` to the ID token in the app registration's token configuration, or no Microsoft sign-up can succeed. Microsoft documents those claims for work and school accounts only, so expect personal Microsoft accounts to be refused. Unverified until tested with a personal account.

### A Note on Free Tier Limits

Veer's storage and traffic fit the Workers Free plan within the limits below. The one unknown is the Rate Limiting binding, since Cloudflare's docs do not say which plans include it. Unverified until a deploy to a Free-plan account succeeds.

| Limit | Free tier | What consumes it |
| --- | --- | --- |
| [KV writes](https://developers.cloudflare.com/kv/platform/pricing/) | **1,000/day** | One cache fill per slug per week (the redirect cache holds each for 7 days), one per link created, edited, or bulk-imported, and one per password attempt on a protected link |
| [Worker requests](https://developers.cloudflare.com/workers/platform/pricing/) | 100,000/day | Every redirect, API call, and page load of the app. Only `/dist/app.js`, `/dist/app.css`, `/data/countries-110m.json`, and `/favicon.svg` skip the Worker and are free |
| [D1 rows written](https://developers.cloudflare.com/d1/platform/pricing/) | 100,000/day | One daily-aggregate upsert per click |
| [Analytics Engine writes](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | 100,000/day | One event per click |
| [KV deletes](https://developers.cloudflare.com/kv/platform/pricing/) | **1,000/day** | One per link deleted or moved to another domain. A `Settings → Domains → Sync` that drops domains clears the cache for up to 500 of their links per sync, one delete each |

KV has room for roughly 7,000 actively-hit slugs. The other three scale with traffic instead, at around 100,000 clicks per day. Browsing the dashboard spends Worker requests but no KV writes, and is never rate limited.

### Additional Domains

Point another domain at the Worker as a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) in the Cloudflare dashboard, then open `Settings → Domains` in Veer and click `Sync`. No other setup required. The same slug will live on different domains, and each domain gets its own root and 404 redirects. `Sync` reads Custom Domains only, so a hostname that reaches the Worker through a zone route is not imported.

> [!WARNING]
> `Sync` also removes domains Cloudflare no longer routes to the Worker, **and deletes every link on them**. Move links you want to keep to another domain before you unroute one.

### Optional Settings

Set these in the `vars` block of `wrangler.jsonc`, or as secrets where noted:

| Setting | Effect |
| --- | --- |
| `INSTANCE_NAME` | Renames the instance everywhere in the UI. Defaults to "Veer" when empty |
| `PASSKEY_ENABLED` | Set to `true` (as a secret) to offer passkey sign-in alongside OAuth |
| `DEMO_MODE` | Set to `true` to turn the deployment into a public read-only showcase. Auth is bypassed, all API writes return `403`, and an hourly cron generates synthetic traffic |

### Demo Instance

`wrangler.jsonc` carries a `demo` environment with its own database, KV namespace, Analytics Engine dataset, and rate limiters. Every command aimed at it takes `--env demo`:

```bash
npx wrangler deploy --env demo
npx wrangler d1 migrations apply DB --remote --env demo   # DB resolves to veer-db-demo
npm run seed:remote          # generates the fixtures and applies them with --env demo
```

### Local Development

```bash
cp .dev.vars.example .dev.vars   # then fill it in
npm run dev
```

`npm run dev` migrates a local D1 and starts Wrangler at `http://localhost:8787`. Wrangler builds the frontend itself and rebuilds it when anything under `frontend/src` or `src` changes. `npm test` runs the suite against a real workerd instance, and `npm run seed:local` fills your local database with the demo fixtures. Git ignores `.dev.vars` and any `.dev.vars.<env>` file you add, so secrets stay untracked.

`npm run typecheck` runs `wrangler types` first, which writes `worker-configuration.d.ts` from `wrangler.jsonc` and your `.dev.vars`. `npm run dev` regenerates an existing file when it falls out of date but never creates one, so run `npm run typecheck` once after cloning. The file is generated and not checked in.

### Updating

```bash
git pull && npm install && npm run deploy && npx wrangler d1 migrations apply veer-db --remote
```

Deploy first when a new migration drops a column, because the running Worker still reads it until the new code is live. A migration that adds a column the new code reads goes the other way: apply it, then deploy.

- - -

Feel free to take a look at the source and adapt as you please. I would love to see some pull requests for improvements.

Veer is licensed under the [MIT License](LICENSE).

The world map draws `public/data/countries-110m.json` from [world-atlas](https://github.com/topojson/world-atlas) 2.0.2, built from public-domain [Natural Earth](https://www.naturalearthdata.com/) data and distributed under this license:

<details>
<summary>world-atlas license (ISC)</summary>

```
Copyright 2013-2019 Michael Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

</details>

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
