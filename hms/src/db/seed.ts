import { run, scalar } from './index.js';
import { toMinor } from '../lib/money.js';

/**
 * Optional starter data offered by the setup wizard.
 *
 * The rooms match Hotel Noor Palace's actual layout — 101-108 on the ground
 * floor and 201-210 on the first — so the front desk can start taking bookings
 * straight away. **The rates are placeholders**: set the real ones under
 * Rooms & Room Types before going live.
 *
 * Never inserted automatically; only when the wizard checkbox is ticked.
 */
export function seedStarterData(): void {
  if (scalar('SELECT COUNT(*) FROM room_types') > 0) return;

  const types: [string, number, number, string][] = [
    ['Standard', 5000, 2, 'Placeholder rate — change this to your real tariff'],
    ['Deluxe', 8000, 3, 'Placeholder rate — for your better rooms'],
  ];
  const typeIds: Record<string, number> = {};
  for (const [name, rate, capacity, description] of types) {
    const res = run(
      'INSERT INTO room_types (name, base_rate, capacity, description) VALUES (?,?,?,?)',
      name,
      toMinor(rate),
      capacity,
      description,
    );
    typeIds[name] = res.lastInsertRowid;
  }

  const standard = typeIds['Standard']!;
  let order = 0;
  const addFloor = (floorName: string, first: number, last: number) => {
    for (let n = first; n <= last; n++) {
      run(
        'INSERT INTO rooms (number, room_type_id, floor, amenities, sort_order) VALUES (?,?,?,?,?)',
        String(n),
        standard,
        floorName,
        'AC, TV, Wifi, Hot water',
        order++,
      );
    }
  };
  addFloor('Ground', 101, 108);
  addFloor('1st', 201, 210);

  const menu: [string, string, number][] = [
    ['Paratha', 'breakfast', 120],
    ['Omelette', 'breakfast', 250],
    ['Halwa Puri', 'breakfast', 380],
    ['Continental Breakfast', 'breakfast', 750],
    ['Chicken Karahi (Half)', 'lunch', 1250],
    ['Mutton Biryani', 'lunch', 850],
    ['Daal Chawal', 'lunch', 450],
    ['Chicken Handi', 'dinner', 1450],
    ['Seekh Kebab (4 pcs)', 'dinner', 900],
    ['Grilled Fish', 'dinner', 1650],
    ['Naan', 'extras', 60],
    ['Raita', 'extras', 150],
    ['Green Salad', 'extras', 200],
    ['Tea', 'beverages', 180],
    ['Soft Drink', 'beverages', 150],
    ['Mineral Water', 'beverages', 100],
    ['Fresh Lime', 'beverages', 250],
  ];
  let menuOrder = 0;
  for (const [name, category, price] of menu) {
    run(
      'INSERT INTO menu_items (name, category, price_minor, sort_order) VALUES (?,?,?,?)',
      name,
      category,
      toMinor(price),
      menuOrder++,
    );
  }
}
