import type { Request } from 'express';
import { all, get, nextCounter, run, scalar, tx } from '../db/index.js';
import { nowTs, today } from '../lib/dates.js';
import { ValidationError } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { getSettings, packageIncludesBreakfast } from './settings.service.js';
import { getBooking } from './bookings.service.js';
import { getRoom } from './rooms.service.js';
import type { BillingMode, MealType, MenuCategory, MenuItem, Order, OrderItem, OrderType } from '../types/domain.js';

/* -------------------------------------------------------------------- menu */

export function listMenuItems(opts: { category?: MenuCategory | 'all'; availableOnly?: boolean } = {}): MenuItem[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.category && opts.category !== 'all') {
    where.push('category = ?');
    params.push(opts.category);
  }
  if (opts.availableOnly) where.push('is_available = 1');
  return all<MenuItem>(
    `SELECT * FROM menu_items
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY category, sort_order, name`,
    ...params,
  );
}

export function getMenuItem(id: number): MenuItem | undefined {
  return get<MenuItem>('SELECT * FROM menu_items WHERE id = ?', id);
}

/**
 * Menu grouped by category for the order-taking screen. Insertion order is
 * meal order, not alphabetical, because that is the order the tabs appear in
 * and the order the kitchen thinks in.
 */
const CATEGORY_ORDER: MenuCategory[] = ['breakfast', 'lunch', 'dinner', 'beverages', 'extras'];

export function menuByCategory(availableOnly = true): Record<string, MenuItem[]> {
  const items = listMenuItems({ availableOnly });
  const grouped: Record<string, MenuItem[]> = {};
  for (const category of CATEGORY_ORDER) {
    const matching = items.filter((i) => i.category === category);
    if (matching.length) grouped[category] = matching;
  }
  return grouped;
}

/* ------------------------------------------------------------------ orders */

export function nextOrderCode(): string {
  const prefix = getSettings().order_prefix || 'ORD';
  const n = nextCounter('order');
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

export interface OrderLineInput {
  menu_item_id: number;
  qty: number;
  note?: string;
}

export interface CreateOrderInput {
  order_type: OrderType;
  meal_type: MealType;
  billing_mode: BillingMode;
  booking_id?: number | null;
  room_id?: number | null;
  table_no?: string;
  guest_name?: string;
  discount_minor?: number;
  notes?: string;
  lines: OrderLineInput[];
}

/**
 * "Add to Room" is only legal against a guest who is actually in the hotel.
 * Returns the validated booking id.
 */
function validateRoomCharge(bookingId: number | null | undefined, roomId: number | null | undefined): number {
  if (!bookingId) {
    throw new ValidationError('Choose the checked-in room this order should be charged to.');
  }
  const booking = getBooking(bookingId);
  if (!booking) throw new ValidationError('That booking no longer exists.');
  if (booking.status !== 'checked_in') {
    throw new ValidationError(
      `Booking ${booking.code} is "${booking.status.replace('_', ' ')}", not checked in, so nothing can be charged to the room.`,
    );
  }
  if (roomId) {
    const stillThere = scalar(
      `SELECT COUNT(*) FROM booking_rooms
        WHERE booking_id = ? AND room_id = ? AND from_date <= ? AND to_date > ?`,
      bookingId,
      roomId,
      today(),
      today(),
    );
    if (!stillThere) {
      const room = getRoom(roomId);
      throw new ValidationError(`Room ${room?.number ?? roomId} does not belong to booking ${booking.code} today.`);
    }
  }
  return bookingId;
}

export function createOrder(input: CreateOrderInput, req: Request): Order {
  if (!input.lines.length) throw new ValidationError('Add at least one item to the order.');

  return tx(() => {
    let bookingId: number | null = null;
    let roomId: number | null = null;

    if (input.order_type === 'room_service' || input.billing_mode === 'add_to_room') {
      bookingId = validateRoomCharge(input.booking_id, input.room_id);
      roomId = input.room_id ?? null;
    }
    if (input.order_type === 'dine_in' && input.billing_mode === 'add_to_room' && !bookingId) {
      throw new ValidationError('A dine-in order charged to a room still needs the room selected.');
    }

    let billingMode = input.billing_mode;
    // Room + Meals packages get breakfast for free unless staff override it.
    if (billingMode === 'add_to_room' && bookingId && input.meal_type === 'breakfast' && packageIncludesBreakfast()) {
      const booking = getBooking(bookingId);
      if (booking?.package === 'room_meals') billingMode = 'complimentary';
    }

    const ts = nowTs();
    const code = nextOrderCode();
    const res = run(
      `INSERT INTO orders
         (code, order_type, booking_id, room_id, table_no, guest_name, meal_type, billing_mode,
          status, discount_minor, notes, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?)`,
      code,
      input.order_type,
      bookingId,
      roomId,
      input.table_no ?? '',
      input.guest_name ?? '',
      input.meal_type,
      billingMode,
      input.discount_minor ?? 0,
      input.notes ?? '',
      req.user?.id ?? null,
      ts,
      ts,
    );
    const orderId = res.lastInsertRowid;
    replaceOrderLines(orderId, input.lines);
    recalcOrder(orderId);

    const where =
      input.order_type === 'room_service'
        ? `Room ${getRoom(roomId ?? 0)?.number ?? '-'}`
        : `Table ${input.table_no || '-'}`;
    logActivity(req, 'created order', 'order', orderId, `${code} · ${where} · ${input.meal_type}`);
    return getOrder(orderId)!;
  });
}

function replaceOrderLines(orderId: number, lines: OrderLineInput[]): void {
  run('DELETE FROM order_items WHERE order_id = ?', orderId);
  for (const line of lines) {
    const qty = Math.max(1, Math.floor(line.qty));
    const item = getMenuItem(line.menu_item_id);
    if (!item) throw new ValidationError('One of the selected menu items no longer exists.');
    run(
      `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_minor, qty, line_minor, note)
       VALUES (?,?,?,?,?,?,?)`,
      orderId,
      item.id,
      item.name,
      item.price_minor,
      qty,
      item.price_minor * qty,
      line.note ?? '',
    );
  }
}

/**
 * Recomputes the order total from its lines.
 *
 * Orders are stored **pre-tax**: tax is applied once, on the invoice, whether
 * that is the walk-in food receipt or the guest's final bill. Applying it here
 * as well would tax "Add to Room" items twice.
 */
export function recalcOrder(orderId: number): void {
  const order = getOrder(orderId);
  if (!order) return;
  const subtotal = scalar('SELECT COALESCE(SUM(line_minor),0) FROM order_items WHERE order_id = ?', orderId);
  const discount = Math.min(Math.max(0, order.discount_minor), subtotal);
  const total = order.billing_mode === 'complimentary' ? 0 : subtotal - discount;
  run(
    'UPDATE orders SET subtotal_minor = ?, discount_minor = ?, tax_minor = 0, total_minor = ?, updated_at = ? WHERE id = ?',
    subtotal,
    discount,
    total,
    nowTs(),
    orderId,
  );
}

export function getOrder(id: number): Order | undefined {
  return get<Order>('SELECT * FROM orders WHERE id = ?', id);
}

export interface OrderView extends Order {
  room_number: string | null;
  booking_code: string | null;
  guest_full_name: string | null;
  created_by_name: string | null;
  item_count: number;
}

const ORDER_SELECT = `
  SELECT o.*, r.number AS room_number, b.code AS booking_code,
         g.full_name AS guest_full_name, u.full_name AS created_by_name,
         (SELECT COALESCE(SUM(qty),0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
    FROM orders o
    LEFT JOIN rooms    r ON r.id = o.room_id
    LEFT JOIN bookings b ON b.id = o.booking_id
    LEFT JOIN guests   g ON g.id = b.guest_id
    LEFT JOIN users    u ON u.id = o.created_by`;

export function getOrderView(id: number): OrderView | undefined {
  return get<OrderView>(`${ORDER_SELECT} WHERE o.id = ?`, id);
}

export function orderItems(orderId: number): OrderItem[] {
  return all<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', orderId);
}

export interface OrderFilters {
  status?: string;
  billing_mode?: string;
  meal_type?: string;
  date?: string;
  q?: string;
  booking_id?: number;
  limit?: number;
}

export function listOrders(filters: OrderFilters = {}): OrderView[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'active') where.push(`o.status IN ('open','served')`);
    else {
      where.push('o.status = ?');
      params.push(filters.status);
    }
  }
  if (filters.billing_mode && filters.billing_mode !== 'all') {
    where.push('o.billing_mode = ?');
    params.push(filters.billing_mode);
  }
  if (filters.meal_type && filters.meal_type !== 'all') {
    where.push('o.meal_type = ?');
    params.push(filters.meal_type);
  }
  if (filters.date) {
    where.push('DATE(o.created_at) = ?');
    params.push(filters.date);
  }
  if (filters.booking_id) {
    where.push('o.booking_id = ?');
    params.push(filters.booking_id);
  }
  if (filters.q) {
    where.push('(o.code LIKE ? OR r.number LIKE ? OR o.table_no LIKE ? OR g.full_name LIKE ? OR o.guest_name LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like, like);
  }

  params.push(filters.limit ?? 200);
  return all<OrderView>(
    `${ORDER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT ?`,
    ...params,
  );
}

export function ordersForBooking(bookingId: number): OrderView[] {
  return all<OrderView>(`${ORDER_SELECT} WHERE o.booking_id = ? ORDER BY o.id`, bookingId);
}

function assertEditable(order: Order): void {
  if (order.status === 'settled') {
    throw new ValidationError(
      `Order ${order.code} has already been billed. Void invoice first if it needs to change.`,
    );
  }
  if (order.status === 'cancelled') throw new ValidationError(`Order ${order.code} is cancelled.`);
}

export interface UpdateOrderInput {
  meal_type: MealType;
  table_no?: string;
  guest_name?: string;
  discount_minor?: number;
  notes?: string;
  lines: OrderLineInput[];
}

export function updateOrder(id: number, input: UpdateOrderInput, req: Request): void {
  const order = getOrder(id);
  if (!order) throw new ValidationError('Order not found.');
  assertEditable(order);
  if (!input.lines.length) throw new ValidationError('An order must have at least one item.');

  tx(() => {
    run(
      `UPDATE orders SET meal_type = ?, table_no = ?, guest_name = ?, discount_minor = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      input.meal_type,
      input.table_no ?? order.table_no,
      input.guest_name ?? order.guest_name,
      input.discount_minor ?? 0,
      input.notes ?? '',
      nowTs(),
      id,
    );
    replaceOrderLines(id, input.lines);
    recalcOrder(id);
    logActivity(req, 'edited order', 'order', id, order.code);
  });
}

/**
 * Switching between "Add to Room" and "Cash Now" after the order was placed.
 * The proposal asks for this to be free of manager approval, so it is, the
 * only bar is that a settled order has to have its invoice voided first.
 */
export function setBillingMode(
  id: number,
  mode: BillingMode,
  bookingId: number | null,
  roomId: number | null,
  req: Request,
): void {
  const order = getOrder(id);
  if (!order) throw new ValidationError('Order not found.');
  assertEditable(order);
  if (order.billing_mode === mode && order.booking_id === bookingId) return;

  tx(() => {
    let newBookingId = order.booking_id;
    let newRoomId = order.room_id;

    if (mode === 'add_to_room') {
      newBookingId = validateRoomCharge(bookingId ?? order.booking_id, roomId ?? order.room_id);
      newRoomId = roomId ?? order.room_id;
    } else if (order.order_type === 'dine_in') {
      // A dine-in order paid at the counter no longer belongs to a room.
      newBookingId = null;
      newRoomId = null;
    }

    run(
      'UPDATE orders SET billing_mode = ?, booking_id = ?, room_id = ?, updated_at = ? WHERE id = ?',
      mode,
      newBookingId,
      newRoomId,
      nowTs(),
      id,
    );
    recalcOrder(id);
    logActivity(req, 'changed billing', 'order', id, `${order.code} · ${order.billing_mode} → ${mode}`);
  });
}

export function markServed(id: number, req: Request): void {
  const order = getOrder(id);
  if (!order) throw new ValidationError('Order not found.');
  assertEditable(order);
  run(`UPDATE orders SET status = 'served', updated_at = ? WHERE id = ?`, nowTs(), id);
  logActivity(req, 'marked served', 'order', id, order.code);
}

export function cancelOrder(id: number, reason: string, req: Request): void {
  const order = getOrder(id);
  if (!order) throw new ValidationError('Order not found.');
  assertEditable(order);
  run(
    `UPDATE orders SET status = 'cancelled', notes = TRIM(notes || ' | cancelled: ' || ?), updated_at = ? WHERE id = ?`,
    reason || 'no reason given',
    nowTs(),
    id,
  );
  logActivity(req, 'cancelled order', 'order', id, `${order.code}${reason ? ` · ${reason}` : ''}`);
}

export function markKotPrinted(id: number): void {
  run('UPDATE orders SET kot_printed_at = ? WHERE id = ?', nowTs(), id);
}

/** Orders that still need to reach the kitchen, the KOT queue. */
export function kitchenQueue(): OrderView[] {
  return all<OrderView>(`${ORDER_SELECT} WHERE o.status = 'open' ORDER BY o.id`);
}

/* ------------------------------------------------------------- room tabs */

export interface RoomFoodTab {
  room_id: number;
  orders: number;
  unbilled_minor: number;
  complimentary_minor: number;
}

/**
 * The running food tab on each room, meals charged to the room and not yet
 * settled on an invoice.
 *
 * Orders keep the room they were delivered to, so a guest who moves rooms
 * mid-stay leaves the earlier meals on the earlier room. Both still land on
 * the one bill at check-out; this is about knowing what is sitting on each
 * door right now.
 */
export function unbilledFoodByRoom(): Map<number, RoomFoodTab> {
  const rows = all<RoomFoodTab>(
    `SELECT room_id,
            COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN billing_mode = 'add_to_room'   THEN total_minor    ELSE 0 END), 0) AS unbilled_minor,
            COALESCE(SUM(CASE WHEN billing_mode = 'complimentary' THEN subtotal_minor ELSE 0 END), 0) AS complimentary_minor
       FROM orders
      WHERE room_id IS NOT NULL
        AND status IN ('open','served')
        AND billing_mode IN ('add_to_room','complimentary')
      GROUP BY room_id`,
  );
  return new Map(rows.map((r) => [r.room_id, r]));
}

export interface RoomOrderGroup {
  room_id: number | null;
  room_number: string;
  orders: OrderView[];
  charged_minor: number;
  complimentary_minor: number;
}

/**
 * A booking's food orders grouped by the room they went to. For a guest who
 * never moved this is one group; for a guest who changed rooms it separates
 * the meals cleanly, which is what makes the bill explainable at the desk.
 */
export function ordersGroupedByRoom(bookingId: number): RoomOrderGroup[] {
  const groups = new Map<string, RoomOrderGroup>();

  for (const order of ordersForBooking(bookingId)) {
    const key = order.room_number ?? 'other';
    const group = groups.get(key) ?? {
      room_id: order.room_id,
      room_number: order.room_number ?? 'Restaurant / no room',
      orders: [],
      charged_minor: 0,
      complimentary_minor: 0,
    };
    group.orders.push(order);
    if (order.status !== 'cancelled') {
      if (order.billing_mode === 'complimentary') group.complimentary_minor += order.subtotal_minor;
      else group.charged_minor += order.total_minor;
    }
    groups.set(key, group);
  }

  return [...groups.values()];
}
