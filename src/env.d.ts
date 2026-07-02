/** Secrets and optional vars not in wrangler.jsonc (set via `wrangler secret put`). */
interface VeerSecrets {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  ADMIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
}

// Merge into both the global `Env` (used by app code via `AppEnv.Bindings`) and
// `Cloudflare.Env` (used by `cloudflare:test` in the vitest pool). `wrangler types`
// wires each to __BaseEnv_Env independently, so both need the augmentation.
interface Env extends VeerSecrets {}

declare namespace Cloudflare {
  interface Env extends VeerSecrets {}
}
