/**
 * Fills a running system with realistic demo data — useful for showing the
 * software to a customer before their real rooms and menu are entered.
 *
 *   1. Start the system          npm start
 *   2. Finish the setup wizard in the browser (tick "add example rooms")
 *   3. node scripts/demo-data.mjs --user ahsan --password yourpassword
 *
 * Everything it creates is ordinary data — delete it, or just restore a backup
 * taken before running this, to get back to an empty system.
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const BASE = args.get('base') ?? 'http://127.0.0.1:8080';
const USER = args.get('user');
const PASSWORD = args.get('password');

if (!USER || !PASSWORD) {
  console.error('Usage: node scripts/demo-data.mjs --user <username> --password <password> [--base http://127.0.0.1:8080]');
  process.exit(1);
}

const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(method, url, body) {
  const headers = { Cookie: cookieHeader() };
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

const GET = (url) => request('GET', url);
async function POST(url, body, tokenFrom) {
  const page = await GET(tokenFrom ?? url);
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  return request('POST', url, { ...body, _csrf: token });
}

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const pick = (arr, i) => arr[i % arr.length];
const idOf = (loc, prefix) => Number(new RegExp(`${prefix}/(\\d+)`).exec(loc ?? '')?.[1] ?? 0);

const GUESTS = [
  ['Ali Raza', '35202-1234567-1', '0300-1112233', 'Lahore'],
  ['Fatima Khan', '42101-7654321-8', '0321-4445566', 'Karachi'],
  ['Bilal Ahmed', '61101-2223334-5', '0333-7778899', 'Islamabad'],
  ['Sana Malik', '33100-9998887-2', '0345-1231234', 'Faisalabad'],
  ['Usman Sheikh', '17301-5556667-9', '0301-9876543', 'Peshawar'],
  ['Ayesha Siddiqui', '35201-1112223-4', '0312-5556677', 'Multan'],
  ['James Carter', 'P4471829', '+44 7700 900123', 'London, UK'],
  ['Hina Tariq', '35202-4445556-6', '0304-2223344', 'Sialkot'],
];

const login = await request('POST', '/login', { username: USER, password: PASSWORD });
if (login.location === '/account/password') {
  console.error('That account still has to set its own password. Sign in through the browser first.');
  process.exit(1);
}
if (!jar.has('hms_sid')) {
  console.error('Could not sign in — check the username and password.');
  process.exit(1);
}
console.log(`Signed in to ${BASE} as ${USER}`);

const avail = await GET(`/rooms/availability?from=${day(-6)}&to=${day(10)}`);
const roomCount = [...avail.text.matchAll(/\/bookings\/new\?room_id=(\d+)/g)].length;
if (roomCount < 4) {
  console.error('Not enough free rooms. Add rooms first (or re-run the setup wizard with the example data ticked).');
  process.exit(1);
}

const menuPage = await GET('/orders/new?order_type=dine_in');
const menu = [...menuPage.text.matchAll(/"id":(\d+),"name"/g)].map((m) => Number(m[1]));

/* --- completed stays, so invoices and reports have history ---------------- */
/*
 * These arrive in the past and depart tomorrow, so the guest is "in house"
 * long enough for food to be charged to the room, and are then checked out
 * with today's date. That produces exactly what a real completed stay looks
 * like: several nights of room charges plus meals on one invoice.
 */
let stays = 0;
for (let i = 0; i < 4; i++) {
  const [name, cnic, phone, city] = GUESTS[i];
  const free = [...(await GET(`/rooms/availability?from=${day(-3 - i)}&to=${day(1)}`)).text
    .matchAll(/\/bookings\/new\?room_id=(\d+)/g)].map((m) => Number(m[1]));
  if (!free.length) break;

  const created = await POST('/bookings', {
    full_name: name, id_number: cnic, phone, address: city,
    room_id: String(free[0]),
    arrival_date: day(-3 - i), departure_date: day(1),
    rate_minor: String(6500 + i * 1500),
    package: i % 2 ? 'room_meals' : 'room_only',
    adults: '2', children: String(i % 2), discount_minor: '0',
    notes: '', check_in_now: '1',
  }, '/bookings/new');
  const id = idOf(created.location, '/bookings');
  if (!id) continue;

  const orderPage = await GET(`/orders/new?order_type=room_service&booking_id=${id}`);
  const choice = new RegExp(`value="(${id}:\\d+)"`).exec(orderPage.text)?.[1];
  if (choice && menu.length) {
    for (const [meal, offset, qty] of [['breakfast', i, '2'], ['dinner', i + 3, '1']]) {
      await POST('/orders', {
        order_type: 'room_service', meal_type: meal,
        billing_mode: 'add_to_room', room_choice: choice,
        'lines[0][menu_item_id]': String(pick(menu, offset)), 'lines[0][qty]': qty,
        'lines[1][menu_item_id]': String(pick(menu, offset + 4)), 'lines[1][qty]': '1',
        discount: '0', notes: '',
      }, `/orders/new?order_type=room_service&booking_id=${id}`);
    }
  }

  const out = await POST(`/bookings/${id}/check-out`, {
    departure_date: day(0), discount_minor: i === 1 ? '500' : '0',
    // One bill is deliberately left part paid so the Outstanding report has content.
    payment_amount: i === 3 ? '2000' : '',
    payment_mode: pick(['cash', 'card', 'bank_transfer'], i), notes: '',
  }, `/bookings/${id}/check-out`);
  if (idOf(out.location, '/invoices')) stays++;
}
console.log(`Created ${stays} completed stays with room + food invoices`);

/* --- guests in house right now ------------------------------------------ */
const freshRooms = [...(await GET(`/rooms/availability?from=${day(0)}&to=${day(4)}`)).text
  .matchAll(/\/bookings\/new\?room_id=(\d+)/g)].map((m) => Number(m[1]));

let inHouse = 0;
for (let i = 0; i < 3 && i < freshRooms.length; i++) {
  const [name, cnic, phone, city] = GUESTS[i + 4];
  const created = await POST('/bookings', {
    full_name: name, id_number: cnic, phone, address: city,
    room_id: String(freshRooms[i]),
    arrival_date: day(-1), departure_date: day(2 + i),
    rate_minor: String(7000 + i * 2000),
    package: i === 1 ? 'room_meals' : 'room_only',
    adults: '2', children: '0', discount_minor: '0',
    notes: '', check_in_now: '1',
  }, '/bookings/new');
  const id = idOf(created.location, '/bookings');
  if (!id) continue;
  inHouse++;

  const orderPage = await GET(`/orders/new?order_type=room_service&booking_id=${id}`);
  const choice = new RegExp(`value="(${id}:\\d+)"`).exec(orderPage.text)?.[1];
  if (choice && menu.length) {
    await POST('/orders', {
      order_type: 'room_service', meal_type: 'dinner', billing_mode: 'add_to_room',
      room_choice: choice,
      'lines[0][menu_item_id]': String(pick(menu, i + 2)), 'lines[0][qty]': '2',
      discount: '0', notes: 'Extra napkins',
    }, `/orders/new?order_type=room_service&booking_id=${id}`);
  }
}
console.log(`${inHouse} guests checked in right now`);

/* --- future reservations ------------------------------------------------- */
let reserved = 0;
for (let i = 0; i < 3; i++) {
  // One arrives today so the dashboard has an arrival to check in; the rest are
  // genuine advance reservations. Ask for rooms free over each exact window so
  // the demo never collides with the guests already in house.
  const arrival = i === 0 ? day(0) : day(3);
  const free = [...(await GET(`/rooms/availability?from=${arrival}&to=${day(6)}`)).text
    .matchAll(/\/bookings\/new\?room_id=(\d+)/g)].map((m) => Number(m[1]));
  if (!free.length) break;
  const [name, cnic, phone, city] = GUESTS[(i + 2) % GUESTS.length];
  const created = await POST('/bookings', {
    full_name: name, id_number: cnic, phone, address: city,
    room_id: String(free[0]),
    arrival_date: arrival, departure_date: day(6),
    rate_minor: '8000', package: 'room_only', adults: '1', children: '0',
    discount_minor: '0', notes: 'Advance reservation', check_in_now: '',
  }, '/bookings/new');
  if (idOf(created.location, '/bookings')) reserved++;
}
console.log(`${reserved} advance reservations`);

/* --- restaurant walk-ins -------------------------------------------------- */
let walkIns = 0;
for (let i = 0; i < 5; i++) {
  const created = await POST('/orders', {
    order_type: 'dine_in', meal_type: pick(['breakfast', 'lunch', 'dinner'], i),
    billing_mode: 'cash_now', table_no: String((i % 6) + 1), guest_name: '',
    'lines[0][menu_item_id]': String(pick(menu, i)), 'lines[0][qty]': String((i % 3) + 1),
    'lines[1][menu_item_id]': String(pick(menu, i + 5)), 'lines[1][qty]': '2',
    discount: i === 2 ? '150' : '0', notes: '',
  }, '/orders/new?order_type=dine_in');
  const id = idOf(created.location, '/orders');
  if (!id) continue;
  walkIns++;
  if (i < 3) await POST(`/orders/${id}/settle`, { payment_mode: pick(['cash', 'card'], i) }, `/orders/${id}`);
}
console.log(`${walkIns} restaurant orders (3 already settled, the rest still open in the kitchen)`);

console.log(`\nDone. Open ${BASE} to see the system with data in it.`);
