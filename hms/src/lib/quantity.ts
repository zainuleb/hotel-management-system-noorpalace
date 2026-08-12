/**
 * Stock quantities, stored as integers in thousandths of the item's unit.
 *
 * The same reasoning as money in lib/money.ts: 0.1 kg cannot be represented
 * exactly as a float, so a year of small kitchen issues would slowly drift the
 * stock figure away from the shelf. Three decimal places is enough for grams
 * against a kilo and millilitres against a litre, which is as fine as a hotel
 * kitchen ever counts.
 */

export const THOUSANDTHS = 1000;

/** "1.25" | 1.25 -> 1250 */
export function toQty(input: unknown): number {
  if (input === null || input === undefined || input === '') return 0;
  const raw = String(input).replace(/[,\s]/g, '');
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * THOUSANDTHS);
}

/** 1250 -> 1.25 */
export function fromQty(qty: number): number {
  return (qty ?? 0) / THOUSANDTHS;
}

/**
 * 1250 -> "1.25", 2000 -> "2". Trailing zeros are dropped because "2 pcs"
 * reads better on a stock list than "2.000 pcs".
 */
export function formatQty(qty: number): string {
  const value = fromQty(qty ?? 0);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** For pre-filling a number input. */
export function qtyInputValue(qty: number): string {
  return String(fromQty(qty ?? 0));
}

/** Units a small hotel actually buys in. */
export const STOCK_UNITS: readonly string[] = [
  'pcs', 'kg', 'g', 'litre', 'ml', 'packet', 'box', 'bottle', 'can',
  'dozen', 'bag', 'roll', 'set', 'pair', 'metre',
];
