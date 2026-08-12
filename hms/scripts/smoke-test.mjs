/**
 * End-to-end check of the whole guest journey against a real server and a
 * throwaway database:
 *
 *   setup → rooms → walk-in check-in → room-service order (Add to Room)
 *         → dine-in order (Cash Now) → billing switch → extend stay
 *         → change room → check-out → invoice maths → part payment
 *         → double-booking rejection → backup
 *
 * Run it after any change:   npm run build && node scripts/smoke-test.mjs
 * It never touches the live data folder.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 8137);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-smoke-'));

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? `, ${detail}` : ''}`);
    console.log(`  [31m✗[0m ${name}${detail ? `, ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------- tiny http client */

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function request(method, url, body) {
  const headers = { Cookie: cookieHeader() };
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

const GET = (url) => request('GET', url);

/** POST with the CSRF token lifted from the page the form lives on. */
async function POST(url, body, tokenFrom) {
  const page = await GET(tokenFrom ?? url);
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  return request('POST', url, { ...body, _csrf: token });
}

/** Follows a redirect chain and returns the final page. */
async function follow(res) {
  let current = res;
  let hops = 0;
  while (current.location && hops++ < 5) {
    current = await GET(current.location.replace(BASE, ''));
  }
  return current;
}

const idFrom = (location, prefix) => Number(new RegExp(`${prefix}/(\\d+)`).exec(location ?? '')?.[1] ?? 0);
const flash = (html) => /class="flash flash--\w+">([^<]*)</.exec(html)?.[1]?.trim() ?? '';

function dayOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ boot */

const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], {
  env: { ...process.env, HMS_PORT: String(PORT), HMS_DATA_DIR: DATA_DIR, HMS_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => { serverLog += b; });
server.stderr.on('data', (b) => { serverLog += b; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server never became healthy.\n${serverLog}`);
}

function cleanup() {
  server.kill('SIGTERM');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ run */

try {
  await waitForServer();
  console.log('\nHotel Management System, end to end check\n');

  /* --- setup ------------------------------------------------------------ */
  console.log('Setup');
  const setup = await request('POST', '/setup', {
    hotel_name: 'Smoke Test Hotel',
    hotel_address: '1 Test Road',
    hotel_phone: '000',
    currency_symbol: 'Rs.',
    tax_percent: '10',
    full_name: 'Test Admin',
    username: 'tester',
    password: 'testpass2026',
    confirm_password: 'testpass2026',
    seed: '1',
  });
  check('setup wizard creates the hotel and signs the admin in', setup.status === 302);

  const dash = await GET('/');
  check('dashboard loads after setup', dash.status === 200 && dash.text.includes('Smoke Test Hotel'));

  /* --- rooms ------------------------------------------------------------ */
  console.log('\nRooms');
  const rooms = await GET('/rooms/availability?from=' + dayOffset(0) + '&to=' + dayOffset(2));
  const roomIds = [...rooms.text.matchAll(/\/bookings\/new\?room_id=(\d+)/g)].map((m) => Number(m[1]));
  check('seeded rooms show as available', roomIds.length >= 5, `${roomIds.length} free`);
  const [roomA, roomB] = roomIds;

  /* --- walk-in ---------------------------------------------------------- */
  console.log('\nBooking');
  const created = await POST('/bookings', {
    full_name: 'Ali Raza',
    id_number: '35202-1234567-1',
    phone: '0300-1112222',
    address: 'Karachi',
    room_id: String(roomA),
    arrival_date: dayOffset(0),
    departure_date: dayOffset(2),
    rate_minor: '5000',
    package: 'room_only',
    adults: '2',
    children: '0',
    discount_minor: '0',
    notes: 'Late arrival',
    check_in_now: '1',
  }, '/bookings/new');
  const bookingId = idFrom(created.location, '/bookings');
  check('walk-in booking created and checked in', bookingId > 0, created.location ?? flash(created.text));

  const bookingPage = await GET(`/bookings/${bookingId}`);
  check('booking shows as Checked In', bookingPage.text.includes('Checked In'));

  /* Double booking must be refused. */
  const clash = await POST('/bookings', {
    full_name: 'Clash Guest',
    room_id: String(roomA),
    arrival_date: dayOffset(1),
    departure_date: dayOffset(3),
    package: 'room_only',
    adults: '1',
  }, '/bookings/new');
  const clashPage = await follow(clash);
  check('the same room cannot be double booked', /already held by/i.test(clashPage.text), flash(clashPage.text));

  /* --- room service order (Add to Room) --------------------------------- */
  console.log('\nFood service');
  const menuPage = await GET('/orders/new?order_type=room_service');
  const menuIds = [...menuPage.text.matchAll(/"id":(\d+),"name"/g)].map((m) => Number(m[1]));
  check('menu items are available to order', menuIds.length > 3, `${menuIds.length} items`);

  const roomChoice = /value="(\d+:\d+)"/.exec(menuPage.text)?.[1] ?? '';
  check('the checked-in room can be picked for "Add to Room"', roomChoice.startsWith(String(bookingId)));

  const order1 = await POST('/orders', {
    order_type: 'room_service',
    meal_type: 'dinner',
    billing_mode: 'add_to_room',
    room_choice: roomChoice,
    'lines[0][menu_item_id]': String(menuIds[0]),
    'lines[0][qty]': '2',
    'lines[1][menu_item_id]': String(menuIds[1]),
    'lines[1][qty]': '1',
    discount: '0',
    notes: 'No chilli',
  }, '/orders/new?order_type=room_service');
  const orderId = idFrom(order1.location, '/orders');
  check('room-service order charged to the room', orderId > 0, order1.location ?? flash(order1.text));

  const kot = await GET(`/orders/${orderId}/kot`);
  check('KOT prints without prices', kot.status === 200 && kot.text.includes('KITCHEN ORDER') && !kot.text.includes('TOTAL'));

  /* An order cannot be charged to a room with nobody in it. */
  const badCharge = await POST('/orders', {
    order_type: 'room_service',
    meal_type: 'lunch',
    billing_mode: 'add_to_room',
    room_choice: `999999:${roomB}`,
    'lines[0][menu_item_id]': String(menuIds[0]),
    'lines[0][qty]': '1',
  }, '/orders/new?order_type=room_service');
  const badPage = await follow(badCharge);
  check('cannot charge food to a room that is not checked in',
    /no longer exists|not checked in|does not belong/i.test(badPage.text), flash(badPage.text));

  /* --- dine-in cash sale ------------------------------------------------- */
  const order2 = await POST('/orders', {
    order_type: 'dine_in',
    meal_type: 'lunch',
    billing_mode: 'cash_now',
    table_no: '5',
    guest_name: 'Walk-in customer',
    'lines[0][menu_item_id]': String(menuIds[2]),
    'lines[0][qty]': '3',
    discount: '50',
  }, '/orders/new?order_type=dine_in');
  const order2Id = idFrom(order2.location, '/orders');
  check('dine-in cash order created', order2Id > 0, order2.location ?? flash(order2.text));

  const settle = await POST(`/orders/${order2Id}/settle`, { payment_mode: 'cash' }, `/orders/${order2Id}`);
  const invoice2Id = idFrom(settle.location, '/invoices');
  check('cash order settles into its own walk-in receipt', invoice2Id > 0, settle.location ?? '');

  const receipt = await GET(`/invoices/${invoice2Id}/receipt`);
  check('thermal receipt renders', receipt.status === 200 && receipt.text.includes('SALE RECEIPT'));

  /* Switching an order's billing after it was placed. No approval needed. */
  const order3 = await POST('/orders', {
    order_type: 'dine_in',
    meal_type: 'breakfast',
    billing_mode: 'cash_now',
    table_no: '2',
    'lines[0][menu_item_id]': String(menuIds[0]),
    'lines[0][qty]': '1',
  }, '/orders/new?order_type=dine_in');
  const order3Id = idFrom(order3.location, '/orders');
  const switched = await POST(`/orders/${order3Id}/billing`, {
    billing_mode: 'add_to_room',
    room_choice: roomChoice,
  }, `/orders/${order3Id}`);
  const order3Page = await follow(switched);
  check('an order can be switched from Cash Now to Add to Room',
    order3Page.text.includes('Add to Room'), flash(order3Page.text));

  /* --- stay changes ------------------------------------------------------ */
  console.log('\nStay changes');
  const extended = await follow(await POST(`/bookings/${bookingId}/extend`,
    { departure_date: dayOffset(3) }, `/bookings/${bookingId}`));
  check('stay can be extended', /extended/i.test(extended.text) || extended.text.includes(dayOffset(3)),
    flash(extended.text));

  const moved = await follow(await POST(`/bookings/${bookingId}/change-room`,
    { room_id: String(roomB), from_date: dayOffset(1), rate_minor: '6000' }, `/bookings/${bookingId}`));
  check('guest can be moved to another room mid-stay', /moved to room/i.test(flash(moved.text)), flash(moved.text));

  /* --- check-out --------------------------------------------------------- */
  console.log('\nCheck-out and billing');
  const checkoutPage = await GET(`/bookings/${bookingId}/check-out?departure_date=${dayOffset(3)}`);
  check('check-out screen shows the combined bill',
    checkoutPage.status === 200 && checkoutPage.text.includes('Room Charges') && checkoutPage.text.includes('Dinner'));

  const totalOnScreen = /class="grand"><span>Total<\/span><span>Rs\. ([\d,\.]+)</.exec(checkoutPage.text)?.[1];
  check('bill shows a total', Boolean(totalOnScreen), totalOnScreen);

  const checkout = await POST(`/bookings/${bookingId}/check-out`, {
    departure_date: dayOffset(3),
    discount_minor: '0',
    payment_amount: '1000',
    payment_mode: 'cash',
    notes: 'Part payment at desk',
  }, `/bookings/${bookingId}/check-out`);
  const invoiceId = idFrom(checkout.location, '/invoices');
  check('check-out creates the invoice', invoiceId > 0, checkout.location ?? flash(checkout.text));

  const invoicePage = await GET(`/invoices/${invoiceId}`);
  check('invoice is marked part paid', invoicePage.text.includes('PARTIAL'));
  check('invoice groups room and meal charges',
    invoicePage.text.includes('Room Charges') && invoicePage.text.includes('Dinner'));

  /*
   * The stay was: arrival→+1 in room A at 5,000/night, then moved to room B at
   * 6,000/night until +3. So 1 night at 5,000 plus 2 nights at 6,000 = 17,000,
   * plus 10% tax on (17,000 + food).
   */
  check('room charge splits correctly across the mid-stay room change',
    invoicePage.text.includes('5,000.00') && invoicePage.text.includes('12,000.00'),
    '1 night at 5,000 and 2 nights at 6,000');
  check('room charges total 17,000.00', invoicePage.text.includes('17,000.00'));

  const invoiceTax = /<span>Tax \(10%\)<\/span><span>([\d,\.]+)</.exec(invoicePage.text)?.[1];
  const invoiceTotal = /class="grand"><span>Total<\/span><span>Rs\. ([\d,\.]+)</.exec(invoicePage.text)?.[1];
  const num = (s) => Number(String(s ?? '0').replace(/,/g, ''));
  check('tax is 10% of room plus food, and the total adds up',
    Math.abs(num(invoiceTax) * 10 - (num(invoiceTotal) - num(invoiceTax))) < 0.02,
    `tax ${invoiceTax}, total ${invoiceTotal}`);

  /* Overpaying is refused. */
  const overpay = await follow(await POST(`/invoices/${invoiceId}/payments`,
    { amount: '999999', mode: 'cash' }, `/invoices/${invoiceId}`));
  check('cannot pay more than the outstanding balance',
    /more than the outstanding/i.test(overpay.text), flash(overpay.text));

  /* Settle the rest. */
  const balanceStr = /max="([\d\.]+)"/.exec((await GET(`/invoices/${invoiceId}`)).text)?.[1] ?? '0';
  const paid = await follow(await POST(`/invoices/${invoiceId}/payments`,
    { amount: balanceStr, mode: 'card', reference: 'SLIP-1' }, `/invoices/${invoiceId}`));
  check('paying the balance marks the invoice paid', paid.text.includes('PAID'), flash(paid.text));

  const a4 = await GET(`/invoices/${invoiceId}/print`);
  check('A4 invoice renders', a4.status === 200 && a4.text.includes('INVOICE'));

  /* The room must be free again after check-out. */
  const afterOut = await GET(`/rooms/availability?from=${dayOffset(3)}&to=${dayOffset(4)}`);
  check('the room is released once the guest checks out',
    afterOut.text.includes(`room_id=${roomB}`), 'room B should be bookable again');

  /* --- reports ----------------------------------------------------------- */
  console.log('\nReports and admin');
  const hub = await GET('/reports');
  check('reports hub lists every report',
    hub.status === 200 && ['Daily Report', 'Monthly Report', 'Cash Book', 'Room-wise Performance', 'Tax Collected']
      .every((t) => hub.text.includes(t)));

  const reports = await GET(`/reports/sales?preset=custom&from=${dayOffset(0)}&to=${dayOffset(1)}`);
  check('sales & occupancy report loads with data', reports.status === 200 && reports.text.includes('Meal-wise sales'));
  check('billing split separates Add to Room from Cash Now',
    reports.text.includes('Add to Room') && reports.text.includes('Cash Now'));

  const csv = await GET(`/reports/export.csv?report=meals&preset=custom&from=${dayOffset(0)}&to=${dayOffset(1)}`);
  check('CSV export works', csv.status === 200 && csv.text.includes('Meal,Orders'));

  const activity = await GET('/admin/activity');
  check('activity log records who did what',
    activity.text.includes('checked out') && activity.text.includes('tester'));

  const backup = await follow(await POST('/admin/backup', {}, '/admin/backup'));
  check('a backup can be taken while the system is running', /Backup created/i.test(backup.text), flash(backup.text));

  /* --- expenses and profit & loss ----------------------------------------- */
  console.log('\nExpenses and profit & loss');
  const expensesPage = await GET('/expenses');
  check('expense ledger opens with the hotel\'s own headings',
    expensesPage.status === 200 &&
    ['Salaries', 'Utility Bills', 'Kitchen Expense', 'Laundry Expense', 'Maintenance']
      .every((c) => expensesPage.text.includes(c)));

  const categoryIds = [...expensesPage.text.matchAll(/<option value="(\d+)"[^>]*>\s*([^<(]+)/g)]
    .map((m) => ({ id: Number(m[1]), name: m[2].trim() }));
  const salaries = categoryIds.find((c) => c.name === 'Salaries');
  const utilities = categoryIds.find((c) => c.name === 'Utility Bills');
  const kitchenCategoryId = (categoryIds.find((c) => c.name === 'Kitchen Expense') ?? salaries).id;
  check('categories are selectable on the entry form', Boolean(salaries && utilities));

  const addExpense = async (categoryId, description, amount, when) =>
    follow(await POST('/expenses', {
      entry_date: when, category_id: String(categoryId), description,
      amount, payment_mode: 'cash', paid_to: 'Demo', reference: '', notes: '',
    }, '/expenses'));

  const e1 = await addExpense(salaries.id, 'Staff salary', '30000', dayOffset(0));
  check('an expense can be recorded', /Entry recorded/i.test(e1.text), flash(e1.text));
  await addExpense(utilities.id, 'Electricity bill', '12000', dayOffset(0));

  const badExpense = await follow(await POST('/expenses', {
    entry_date: dayOffset(0), category_id: String(salaries.id),
    description: 'Bad', amount: '0', payment_mode: 'cash',
  }, '/expenses'));
  check('a zero-amount expense is refused',
    /greater than zero/i.test(badExpense.text), flash(badExpense.text));

  const daily = await GET(`/reports/daily?date=${dayOffset(0)}`);
  check('daily report lists the rooms occupied', daily.status === 200 && daily.text.includes('Rooms occupied on'));
  check('daily report shows the expenses just entered',
    daily.text.includes('Staff salary') && daily.text.includes('Electricity bill'));
  check('daily report totals the expenses', daily.text.includes('42,000.00'), '30,000 + 12,000');
  check('daily report shows a profit or loss line', /Profit &amp; loss for|>Profit<|>Loss</.test(daily.text));

  const monthly = await GET('/reports/monthly');
  check('monthly report opens', monthly.status === 200 && monthly.text.includes('Profit &amp; loss'));
  check('monthly report breaks expenses down by category',
    monthly.text.includes('Salaries') && monthly.text.includes('Utility Bills'));
  check('monthly report carries the expense total', monthly.text.includes('42,000.00'));

  /* Room rent is accrued on the night, so it must be counted even though the
     guest was billed on a different day. */
  check('monthly report counts room-nights sold', /room-nights sold/.test(monthly.text));

  /* --- admin dashboard and the wider report suite -------------------------- */
  const admin = await GET('/admin?preset=month');
  check('admin dashboard opens', admin.status === 200 && admin.text.includes('Where the money came from'));
  check('admin dashboard shows the profit position',
    /Net profit|Net loss/.test(admin.text) && admin.text.includes('42,000.00'), 'expense total should carry through');
  check('admin dashboard compares against the previous period',
    admin.text.includes('compared with'));
  check('admin dashboard offers quick expense entry', admin.text.includes('Quick expense'));

  const roomsReport = await GET(`/reports/rooms?preset=custom&from=${dayOffset(-1)}&to=${dayOffset(0)}`);
  check('room-wise report loads', roomsReport.status === 200 && roomsReport.text.includes('Every room'));
  check('room-wise report counts nights against a room',
    /Rooms that earned nothing/.test(roomsReport.text));

  const cashbook = await GET(`/reports/cashbook?preset=custom&from=${dayOffset(0)}&to=${dayOffset(0)}`);
  check('cash book loads', cashbook.status === 200 && cashbook.text.includes('Every movement'));
  check('cash book shows expenses as money out', cashbook.text.includes('Staff salary'));
  check('cash book shows guest payments as money in', /Payment,/.test(cashbook.text));

  const tax = await GET(`/reports/tax?preset=custom&from=${dayOffset(0)}&to=${dayOffset(0)}`);
  check('tax report loads', tax.status === 200 && tax.text.includes('Taxable amount'));

  const yearly = await GET('/reports/yearly');
  check('year summary loads', yearly.status === 200 && yearly.text.includes('Month by month'));

  const roomsCsv = await GET(`/reports/export.csv?report=rooms&preset=custom&from=${dayOffset(0)}&to=${dayOffset(0)}`);
  check('room-wise CSV exports', roomsCsv.status === 200 && roomsCsv.text.includes('Room,Floor,Type'));
  const cashCsv = await GET(`/reports/export.csv?report=cashbook&preset=custom&from=${dayOffset(0)}&to=${dayOffset(0)}`);
  check('cash book CSV exports', cashCsv.status === 200 && cashCsv.text.includes('Running balance'));

  const usedCategory = await follow(await POST(`/expenses/categories/${salaries.id}/delete`, {},
    '/expenses/categories'));
  check('a category with entries against it cannot be deleted',
    /cannot be deleted|entr/i.test(usedCategory.text), flash(usedCategory.text));

  /* --- rooms in bulk ------------------------------------------------------- */
  const typeId = /name="room_type_id"[\s\S]*?<option value="(\d+)"/.exec(
    (await GET('/rooms/manage')).text)?.[1];
  const bulk = await follow(await POST('/rooms/bulk', {
    numbers: '901-904, 950', floor: 'Test', room_type_id: typeId, amenities: 'AC',
  }, '/rooms/manage'));
  check('rooms can be added in bulk from a range', /5 room\(s\) added/.test(flash(bulk.text)), flash(bulk.text));

  const bulkAgain = await follow(await POST('/rooms/bulk', {
    numbers: '903-905', floor: 'Test', room_type_id: typeId, amenities: 'AC',
  }, '/rooms/manage'));
  check('bulk add skips rooms that already exist',
    /1 room\(s\) added.*Skipped 2/.test(flash(bulkAgain.text)), flash(bulkAgain.text));

  /* --- booking guard, countries, room tabs --------------------------------- */
  console.log('\nGuards and guest details');

  /* The first booking was checked out, so put a live guest in a room, these
     checks are about what the screens show while someone is in the hotel. */
  const liveRooms = [...(await GET(`/rooms/availability?from=${dayOffset(0)}&to=${dayOffset(2)}`)).text
    .matchAll(/\/bookings\/new\?room_id=(\d+)/g)].map((m) => Number(m[1]));
  const liveBooking = await POST('/bookings', {
    full_name: 'Hina Tariq', id_number: 'P-9981-XZ', phone: '0304-2223344',
    nationality: 'United Kingdom', address: 'London',
    room_id: String(liveRooms[0]), arrival_date: dayOffset(0), departure_date: dayOffset(2),
    rate_minor: '7000', package: 'room_only', adults: '1', check_in_now: '1',
  }, '/bookings/new');
  const liveId = idFrom(liveBooking.location, '/bookings');
  check('a second guest is checked in for the room-tab checks', liveId > 0, liveBooking.location ?? '');

  const liveChoice = new RegExp(`value="(${liveId}:\\d+)"`).exec(
    (await GET('/orders/new?order_type=room_service')).text)?.[1] ?? '';
  await POST('/orders', {
    order_type: 'room_service', meal_type: 'dinner', billing_mode: 'add_to_room',
    room_choice: liveChoice,
    'lines[0][menu_item_id]': String(menuIds[0]), 'lines[0][qty]': '2',
    discount: '0', notes: '',
  }, '/orders/new?order_type=room_service');

  check('a non-Pakistani ID format is stored exactly as typed',
    (await GET(`/bookings/${liveId}`)).text.includes('P-9981-XZ'));
  check('the chosen nationality is saved',
    (await GET(`/bookings/${liveId}`)).text.includes('United Kingdom'));

  const formPage = await GET(`/bookings/new?arrival_date=${dayOffset(0)}&departure_date=${dayOffset(1)}`);
  check('the booking form lists taken rooms as blocked rather than hiding them',
    /disabled[\s\S]{0,120}taken by .+ \(BK-\d+\) until /.test(formPage.text),
    'expected a disabled option naming who holds the room and until when');
  check('nationality is a country dropdown', formPage.text.includes('<optgroup label="All countries"'));
  check('the country list is complete', (formPage.text.match(/<option value="[A-Z]/g) || []).length > 150);
  check('the ID field accepts any format', /ID number[\s\S]{0,400}CNIC, passport, or any other ID/.test(formPage.text));

  const roomsJson = JSON.parse((await GET(
    `/bookings/rooms.json?from=${dayOffset(0)}&to=${dayOffset(1)}`)).text);
  check('rooms.json reports availability for every room', roomsJson.length > 0 &&
    roomsJson.every((r) => typeof r.available === 'boolean'));

  const boardPage = await GET('/rooms');
  check('the room board shows the running food tab on occupied rooms',
    boardPage.text.includes('room__tab'), 'a checked-in room with food should show its tab');

  const bookingWithFood = await GET(`/bookings/${bookingId}`);
  check('booking shows meals grouped by the room they went to',
    bookingWithFood.text.includes('Food orders'));

  /* --- inventory ----------------------------------------------------------- */
  console.log('\nInventory');
  const supplierPage = await follow(await POST('/inventory/suppliers', {
    name: 'Akbari Mandi', contact: 'Kamran', phone: '0300-1234567', address: 'Lahore',
    notes: '', is_active: '1',
  }, '/inventory/suppliers'));
  check('a supplier can be added', /Supplier saved/i.test(flash(supplierPage.text)), flash(supplierPage.text));
  const supplierId = /name="supplier_id"[\s\S]*?<option value="(\d+)"/.exec(
    (await GET('/inventory/items')).text)?.[1];

  const itemPage = await follow(await POST('/inventory/items', {
    name: 'Basmati rice', category: 'kitchen', unit: 'kg', cost: '450',
    reorder_level: '10', opening_qty: '25', supplier_id: supplierId ?? '',
    location: 'Dry store', notes: '', is_active: '1',
  }, '/inventory/items'));
  check('a stock item can be added with opening stock', /saved/i.test(flash(itemPage.text)), flash(itemPage.text));

  const stockList = await GET('/inventory');
  check('opening stock shows on the stock list', stockList.text.includes('Basmati rice') && stockList.text.includes('25'));
  check('stock value is calculated', stockList.text.includes('11,250.00'), '25 kg at 450 = 11,250');

  const itemId = /\/inventory\/items\/(\d+)/.exec(stockList.text)?.[1];

  /* Buying stock should also land in the expense ledger. */
  const purchase = await follow(await POST('/inventory/movements', {
    item_id: itemId, entry_date: dayOffset(0), kind: 'purchase', qty: '20',
    unit_cost: '460', supplier_id: supplierId ?? '', reference: 'BILL-9',
    note: '', post_to_expenses: '1', expense_category_id: String(kitchenCategoryId),
    payment_mode: 'cash',
  }, '/inventory/movements'));
  check('a purchase can be recorded', /Purchase in recorded/i.test(flash(purchase.text)), flash(purchase.text));

  const ledgerAfter = await GET(`/expenses?from=${dayOffset(0)}&to=${dayOffset(0)}`);
  check('the purchase also posted to the expense ledger',
    ledgerAfter.text.includes('Basmati rice') && ledgerAfter.text.includes('9,200.00'),
    '20 kg at 460 = 9,200 should appear as a kitchen expense');

  const issued = await follow(await POST('/inventory/movements', {
    item_id: itemId, entry_date: dayOffset(0), kind: 'issue', qty: '5',
    unit_cost: '', supplier_id: '', reference: '', note: 'For dinner service',
    payment_mode: 'cash',
  }, '/inventory/movements'));
  check('stock can be issued out', /Issued out recorded/i.test(flash(issued.text)), flash(issued.text));

  const afterIssue = await GET(`/inventory/items/${itemId}`);
  check('the running balance is 40 kg after 25 in, 20 in, 5 out',
    afterIssue.text.includes('>40<') || afterIssue.text.includes('40 '), 'expected 40 kg on hand');

  /* Taking out more than exists must be refused, not allowed to go negative. */
  const overIssue = await follow(await POST('/inventory/movements', {
    item_id: itemId, entry_date: dayOffset(0), kind: 'issue', qty: '999',
    unit_cost: '', supplier_id: '', reference: '', note: '', payment_mode: 'cash',
  }, '/inventory/movements'));
  check('stock cannot be taken below zero',
    /cannot be taken out|in stock/i.test(overIssue.text), flash(overIssue.text));

  /* Low stock should surface on the owner's console. */
  await POST('/inventory/movements', {
    item_id: itemId, entry_date: dayOffset(0), kind: 'issue', qty: '32',
    unit_cost: '', supplier_id: '', reference: '', note: 'Bulk use',
    payment_mode: 'cash',
  }, '/inventory/movements');
  const lowList = await GET('/inventory?low=1');
  check('an item below its reorder level is flagged low', lowList.text.includes('Basmati rice'));
  const adminWithStock = await GET('/admin?preset=month');
  check('low stock appears on the admin dashboard',
    adminWithStock.text.includes('Needs reordering') && adminWithStock.text.includes('Basmati rice'));

  const stockCsv = await GET('/inventory/export.csv?report=stock');
  check('stock exports to CSV', stockCsv.status === 200 && stockCsv.text.includes('Item,Category,Unit'));

  const itemDelete = await follow(await POST(`/inventory/items/${itemId}/delete`, {}, '/inventory/items'));
  check('an item with movement history cannot be deleted',
    /stock movement|switch it off/i.test(itemDelete.text), flash(itemDelete.text));

  /* --- permissions -------------------------------------------------------- */
  const waiter = await follow(await POST('/admin/users', {
    full_name: 'Waiter Wasim', username: 'wasim', role: 'waiter', password: 'waiterpass1',
  }, '/admin/users'));
  check('a waiter login can be created', /Login created/i.test(flash(waiter.text)), flash(waiter.text));

  jar.clear();
  const asWaiter = await request('POST', '/login', { username: 'wasim', password: 'waiterpass1' });
  check('new staff are forced to set their own password', asWaiter.location === '/account/password');

  /* Set it, so what follows tests real permission boundaries rather than the
     password-change redirect that catches every request until this is done. */
  const changed = await POST('/account/password', {
    current_password: 'waiterpass1', new_password: 'wasimown2026', confirm_password: 'wasimown2026',
  }, '/account/password');
  check('a waiter can set their own password', changed.location === '/orders', changed.location ?? '');

  /* 403 specifically. A redirect would mean something else stopped the request. */
  for (const [path, label] of [
    ['/reports', 'the reports'],
    ['/expenses', 'the expense ledger'],
    ['/reports/monthly', 'the monthly profit report'],
    ['/admin', 'the admin dashboard'],
    ['/reports/cashbook', 'the cash book'],
    ['/inventory/items', 'stock item management'],
    ['/inventory/suppliers', 'the supplier list'],
  ]) {
    const res = await GET(path);
    check(`a waiter cannot open ${label}`, res.status === 403, `${path} gave ${res.status}`);
  }

  const waiterOrders = await GET('/orders');
  check('a waiter can still take orders', waiterOrders.status === 200, `got ${waiterOrders.status}`);
  const waiterStock = await GET('/inventory');
  check('a waiter can see what is in stock', waiterStock.status === 200, `got ${waiterStock.status}`);
} catch (err) {
  failures.push(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exit(1);
}
process.exit(0);
