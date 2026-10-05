const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatHour(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm}`;
}

export function formatWeek(iso: string): string {
  const d = new Date(iso);
  return `Week of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The UTC date (YYYY-MM-DD) `days` days ago: the lower bound of a stats window. */
export function statsCutoff(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}
