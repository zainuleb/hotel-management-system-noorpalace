/**
 * All money in this system is an integer number of minor units (paisa/cents).
 * Nothing is ever stored or added as a float, so totals cannot drift.
 */

export const MINOR_PER_UNIT = 100;

/** "1,250.50" | "1250.5" | 1250.5  ->  125050 */
export function toMinor(input: unknown): number {
  if (input === null || input === undefined || input === '') return 0;
  const raw = String(input).replace(/[,\s]/g, '');
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * MINOR_PER_UNIT);
}

/** 125050 -> 1250.5 */
export function toMajor(minor: number): number {
  return (minor ?? 0) / MINOR_PER_UNIT;
}

/** 125050 -> "1,250.50" (no currency symbol) */
export function formatMinor(minor: number): string {
  const value = toMajor(minor ?? 0);
  const negative = value < 0;
  const abs = Math.abs(value).toFixed(2);
  const [whole = '0', decimals = '00'] = abs.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${decimals}`;
}

/** 125050 -> "1250.50", for pre-filling number inputs. */
export function toInputValue(minor: number): string {
  return toMajor(minor ?? 0).toFixed(2);
}

/**
 * Percentage of an amount, rounded half-up to the nearest minor unit.
 * `percentOf(10000, 16)` -> 1600
 */
export function percentOf(minor: number, percent: number): number {
  if (!percent) return 0;
  return Math.round((minor * percent) / 100);
}

export function sumMinor(values: readonly number[]): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

/** Clamps a payment so a user cannot overpay an invoice by fat-fingering. */
export function clampToRange(minor: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, minor));
}
