/** Service dates are printed as dd/mm/yyyy. The domain speaks ISO only. */
const DDMMYYYY = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export function parseServiceDate(raw: string): string | null {
  const match = DDMMYYYY.exec(raw.trim());
  if (!match) return null;
  const [, day, month, year] = match as unknown as [string, string, string, string];
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject calendar-impossible dates (31/02) instead of silently rolling them over.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${year}-${month}-${day}`;
}
