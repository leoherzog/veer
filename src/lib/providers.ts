const PROVIDER_KEYS = ["google", "github", "microsoft", "discord"] as const;

export function getConfiguredProviders(env: Env): Record<string, { clientId: string; clientSecret: string }> {
  const result: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const provider of PROVIDER_KEYS) {
    const prefix = provider.toUpperCase() as Uppercase<typeof provider>;
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) {
      result[provider] = { clientId, clientSecret };
    }
  }
  return result;
}
