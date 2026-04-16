const DEFAULT_INSTANCE_NAME = "Veer";

let instanceName = DEFAULT_INSTANCE_NAME;

export function getInstanceName() {
  return instanceName;
}

export async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (data?.instanceName) instanceName = data.instanceName;
    }
  } catch { /* fall back to default */ }
  document.title = instanceName;
  return { instanceName };
}
