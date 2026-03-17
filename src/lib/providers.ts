import type { Env } from "../bindings";

const PROVIDER_KEYS = ["google", "github", "microsoft", "discord"] as const;
export type ProviderId = (typeof PROVIDER_KEYS)[number];

interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

function envKey(provider: string, suffix: string): string {
  return `${provider.toUpperCase()}_CLIENT_${suffix}`;
}

export function getConfiguredProviders(env: Env): Map<ProviderId, ProviderCredentials> {
  const result = new Map<ProviderId, ProviderCredentials>();
  for (const provider of PROVIDER_KEYS) {
    const clientId = env[envKey(provider, "ID") as keyof Env] as string | undefined;
    const clientSecret = env[envKey(provider, "SECRET") as keyof Env] as string | undefined;
    if (clientId && clientSecret) {
      result.set(provider, { clientId, clientSecret });
    }
  }
  return result;
}
