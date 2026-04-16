export const DEFAULT_INSTANCE_NAME = "Veer";

export function getInstanceName(env: Env): string {
  return env.INSTANCE_NAME?.trim() || DEFAULT_INSTANCE_NAME;
}
