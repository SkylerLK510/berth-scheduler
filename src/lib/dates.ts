// Small date helpers. Dates are handled as ISO strings ("YYYY-MM-DD") everywhere:
// they sort correctly as plain strings, store cleanly in SQLite, and avoid
// timezone surprises. Ranges are inclusive on both ends.

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return d >= 1 && d <= daysInMonth(y, m);
}

export function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function addDays(iso: string, days: number): string {
  const { year, month, day } = parseIsoDate(iso);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Number of days in an inclusive range, e.g. Jun 1 - Jun 3 is 3 days. */
export function rangeLength(start: string, end: string): number {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000) + 1;
}

export function todayIso(): string {
  const d = new Date();
  return toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatDate(iso: string): string {
  const { year, month, day } = parseIsoDate(iso);
  return `${MONTH_NAMES[month - 1].slice(0, 3)} ${day}, ${year}`;
}

export function formatRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (a.year === b.year && a.month === b.month) {
    return `${MONTH_NAMES[a.month - 1].slice(0, 3)} ${a.day}–${b.day}, ${a.year}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}
