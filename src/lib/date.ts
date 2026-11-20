const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatHour(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)} ${hh}:${mm}`;
}

export function formatWeek(iso: string): string {
  return `Week of ${formatDate(iso)}`;
}

/** The UTC date (YYYY-MM-DD) `days` days ago: the lower bound of a stats window. */
export function statsCutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}
