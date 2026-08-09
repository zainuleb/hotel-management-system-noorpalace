/**
 * Date helpers.
 *
 * The hotel runs in one timezone (the PC's own), so everything here works in
 * local time. Dates are plain 'YYYY-MM-DD' strings and are compared as strings,
 * which sorts correctly and avoids every Date-parsing pitfall.
 *
 * Stay ranges are half-open: [arrival_date, departure_date). A guest arriving
 * on the 10th and departing on the 12th occupies nights of the 10th and 11th
 * (2 nights) and the room is free again for a new arrival on the 12th.
 */

const MS_PER_DAY = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Today at the hotel, as 'YYYY-MM-DD'. */
export function today(): string {
  return toDateString(new Date());
}

/** Current local timestamp as 'YYYY-MM-DD HH:MM:SS'. */
export function nowTs(): string {
  const d = new Date();
  return `${toDateString(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses 'YYYY-MM-DD' into a local midnight Date. Returns null if invalid. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, da] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(da);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

export function isValidDate(value: unknown): value is string {
  return parseDate(value) !== null;
}

export function addDays(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

/** Whole nights between two dates. `nightsBetween('2026-08-10','2026-08-12')` -> 2 */
export function nightsBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / MS_PER_DAY));
}

/** Every date in [from, to) as an array of 'YYYY-MM-DD'. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor < to && guard++ < 400) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Do half-open ranges [aFrom,aTo) and [bFrom,bTo) share at least one night? */
export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** '2026-08-10' -> '10 Aug 2026' */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseDate(value.slice(0, 10));
  if (!d) return String(value);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** '2026-08-10 14:05:00' -> '10 Aug 2026, 02:05 PM' */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const datePart = formatDate(value.slice(0, 10));
  const time = value.slice(11, 16);
  if (!time) return datePart;
  const [hStr = '0', min = '00'] = time.split(':');
  const h = Number(hStr);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${datePart}, ${pad(h12)}:${min} ${suffix}`;
}

/** First and last day of the month containing `dateStr`. */
export function monthRange(dateStr: string): { start: string; end: string } {
  const d = parseDate(dateStr) ?? new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start: toDateString(start), end: toDateString(end) };
}

/** Meal that a given time of day most likely belongs to — used to pre-select. */
export function currentMealType(): 'breakfast' | 'lunch' | 'dinner' {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 17) return 'lunch';
  return 'dinner';
}
