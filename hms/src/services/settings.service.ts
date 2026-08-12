import { all, run } from '../db/index.js';

export interface HotelSettings {
  hotel_name: string;
  hotel_address: string;
  hotel_phone: string;
  hotel_email: string;
  currency_symbol: string;
  currency_code: string;
  /** Applied to (room + food - discount) on every invoice. */
  tax_percent: string;
  tax_label: string;
  invoice_prefix: string;
  booking_prefix: string;
  order_prefix: string;
  receipt_footer: string;
  /** 58 or 80, controls the width of the thermal receipt stylesheet. */
  thermal_width_mm: string;
  checkin_time: string;
  checkout_time: string;
  /** When a booking is "Room + Meals", breakfast orders default to complimentary. */
  package_includes_breakfast: string;
}

export const DEFAULT_SETTINGS: HotelSettings = {
  hotel_name: 'Your Hotel Name',
  hotel_address: '',
  hotel_phone: '',
  hotel_email: '',
  currency_symbol: 'Rs.',
  currency_code: 'PKR',
  tax_percent: '0',
  tax_label: 'Tax',
  invoice_prefix: 'INV',
  booking_prefix: 'BK',
  order_prefix: 'ORD',
  receipt_footer: 'Thank you for staying with us!',
  thermal_width_mm: '80',
  checkin_time: '14:00',
  checkout_time: '12:00',
  package_includes_breakfast: '1',
};

let cache: HotelSettings | null = null;

export function getSettings(): HotelSettings {
  if (cache) return cache;
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const merged = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in merged) {
      (merged as Record<string, string>)[row.key] = row.value;
    }
  }
  cache = merged;
  return merged;
}

export function saveSettings(patch: Partial<HotelSettings>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    run(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value ?? ''),
    );
  }
  cache = null;
}

export function taxPercent(): number {
  const n = Number.parseFloat(getSettings().tax_percent);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function currency(): string {
  return getSettings().currency_symbol;
}

export function packageIncludesBreakfast(): boolean {
  return getSettings().package_includes_breakfast === '1';
}

export function clearSettingsCache(): void {
  cache = null;
}
