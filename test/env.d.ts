declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    KV: KVNamespace;
    ANALYTICS: AnalyticsEngineDataset;
    ASSETS: Fetcher;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    CF_ACCOUNT_ID: string;
    CF_API_TOKEN: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    MICROSOFT_CLIENT_ID?: string;
    MICROSOFT_CLIENT_SECRET?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
    PASSKEY_ENABLED?: string;
  }
}
