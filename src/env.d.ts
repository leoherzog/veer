/** Secrets and optional vars not in wrangler.jsonc (set via `wrangler secret put`). */
declare namespace Cloudflare {
  interface Env {
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
}
