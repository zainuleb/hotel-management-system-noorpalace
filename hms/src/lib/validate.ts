/**
 * Small input helpers. Every route reads request fields through these so a
 * missing or malformed field can never reach a SQL statement.
 */

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(message: string) {
    super(message);
  }
}

export function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return str(value[0], fallback);
  return String(value).trim();
}

export function requiredStr(value: unknown, field: string, max = 500): string {
  const s = str(value);
  if (!s) throw new ValidationError(`${field} is required.`);
  if (s.length > max) throw new ValidationError(`${field} is too long (max ${max} characters).`);
  return s;
}

export function int(value: unknown, fallback = 0): number {
  const n = Number.parseInt(str(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function positiveInt(value: unknown, field: string): number {
  const n = int(value, 0);
  if (n <= 0) throw new ValidationError(`${field} must be a whole number greater than zero.`);
  return n;
}

export function optionalId(value: unknown): number | null {
  const n = int(value, 0);
  return n > 0 ? n : null;
}

export function num(value: unknown, fallback = 0): number {
  const n = Number.parseFloat(str(value));
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown): number {
  const s = str(value).toLowerCase();
  return s === 'on' || s === 'true' || s === '1' || s === 'yes' ? 1 : 0;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const s = str(value) as T;
  if (!allowed.includes(s)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return s;
}

export function oneOfOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(value) as T;
  return allowed.includes(s) ? s : fallback;
}

/** Collects `items[3][qty]`-style form arrays into a usable list. */
export function collectRows(
  body: Record<string, unknown>,
  prefix: string,
  fields: string[],
): Record<string, string>[] {
  const byIndex = new Map<string, Record<string, string>>();
  const pattern = new RegExp(`^${prefix}\\[(\\w+)\\]\\[(\\w+)\\]$`);
  for (const [key, value] of Object.entries(body)) {
    const m = pattern.exec(key);
    if (!m) continue;
    const [, index, field] = m as unknown as [string, string, string];
    if (!fields.includes(field)) continue;
    const row = byIndex.get(index) ?? {};
    row[field] = str(value);
    byIndex.set(index, row);
  }
  return [...byIndex.values()];
}
