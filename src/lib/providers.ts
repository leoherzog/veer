const PROVIDER_KEYS = ["google", "github", "microsoft", "discord"] as const;

export function getConfiguredProviders(env: Env): Record<string, { clientId: string; clientSecret: string }> {
  const result: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const provider of PROVIDER_KEYS) {
    const clientId = env[`${provider.toUpperCase()}_CLIENT_ID` as keyof Env] as string | undefined;
    const clientSecret = env[`${provider.toUpperCase()}_CLIENT_SECRET` as keyof Env] as string | undefined;
    if (clientId && clientSecret) {
      result[provider] = { clientId, clientSecret };
    }
  }
  return result;
}
