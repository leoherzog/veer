const DEFAULT_INSTANCE_NAME = "Veer";

let instanceName = DEFAULT_INSTANCE_NAME;
let demoMode = false;
let loginOptions = null;

export function getInstanceName() {
  return instanceName;
}

export function isDemoMode() {
  return demoMode;
}

/** `{ providers, passkey }` for the login view, or null when /api/config failed to load. */
export function getLoginOptions() {
  return loginOptions;
}

export async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (data?.instanceName) instanceName = data.instanceName;
      if (typeof data?.demoMode === "boolean") demoMode = data.demoMode;
      if (Array.isArray(data?.providers)) loginOptions = { providers: data.providers, passkey: data.passkey === true };
    } else {
      console.error(`Failed to load /api/config: HTTP ${res.status}. Falling back to defaults.`);
    }
  } catch (err) {
    console.error("Failed to load /api/config; falling back to defaults.", err);
  }
  document.title = instanceName;
}
