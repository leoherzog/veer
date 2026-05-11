const DEFAULT_INSTANCE_NAME = "Veer";

let instanceName = DEFAULT_INSTANCE_NAME;
let demoMode = false;

export function getInstanceName() {
  return instanceName;
}

export function isDemoMode() {
  return demoMode;
}

export async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (data?.instanceName) instanceName = data.instanceName;
      if (typeof data?.demoMode === "boolean") demoMode = data.demoMode;
    } else {
      console.error(`Failed to load /api/config: HTTP ${res.status}. Falling back to defaults.`);
    }
  } catch (err) {
    console.error("Failed to load /api/config; falling back to defaults.", err);
  }
  document.title = instanceName;
  return { instanceName, demoMode };
}
