export const DEFAULT_INSTANCE_NAME = "Veer";

export function getInstanceName(env: Env): string {
  return env.INSTANCE_NAME?.trim() || DEFAULT_INSTANCE_NAME;
}

export function isDemoMode(env: Env): boolean {
  return env.DEMO_MODE?.trim() === "true";
}
