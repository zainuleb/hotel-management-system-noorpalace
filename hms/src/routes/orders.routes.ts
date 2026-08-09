import { Router } from 'express';
import { requirePermission } from '../lib/session.js';
import { currentMealType, isValidDate, today } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { collectRows, int, oneOf, optionalId, positiveInt, str, ValidationError } from '../lib/validate.js';
import {
  cancelOrder,
  createOrder,
  getOrder,
  getOrderView,
  kitchenQueue,
  listOrders,
  markKotPrinted,
  markServed,
  menuByCategory,
  orderItems,
  setBillingMode,
  updateOrder,
  type OrderLineInput,
} from '../services/orders.service.js';
import { occupiedRoomsNow } from '../services/rooms.service.js';
import { settleFoodOrder } from '../services/billing.service.js';
import { getSettings } from '../services/settings.service.js';
import type { BillingMode, MealType, OrderType, PaymentMode } from '../types/domain.js';

const router = Router();

const MEALS: MealType[] = ['breakfast', 'lunch', 'dinner'];
const ORDER_TYPES: OrderType[] = ['room_service', 'dine_in'];
const BILLING_MODES: BillingMode[] = ['add_to_room', 'cash_now', 'complimentary'];
const PAYMENT_MODES: PaymentMode[] = ['cash', 'card', 'bank_transfer', 'online'];

/** Turns `lines[0][menu_item_id]` / `lines[0][qty]` form fields into order lines. */
function readLines(body: Record<string, unknown>): OrderLineInput[] {
  return collectRows(body, 'lines', ['menu_item_id', 'qty', 'note'])
    .map((row) => ({
      menu_item_id: int(row.menu_item_id, 0),
      qty: int(row.qty, 0),
      note: row.note ?? '',
    }))
    .filter((line) => line.menu_item_id > 0 && line.qty > 0);
}

/* --------------------------------------------------------------- listing */

router.get('/orders', requirePermission('orders.view'), (req, res) => {
  const filters = {
    status: str(req.query.status) || 'active',
    billing_mode: str(req.query.billing_mode) || 'all',
    meal_type: str(req.query.meal_type) || 'all',
    date: isValidDate(str(req.query.date)) ? str(req.query.date) : '',
    q: str(req.query.q),
  };
  res.render('pages/orders', {
    title: 'Food Orders',
    filters,
    orders: listOrders(filters),
  });
});

router.get('/orders/kitchen', requirePermission('orders.view'), (_req, res) => {
  res.render('pages/kitchen', { title: 'Kitchen Queue', orders: kitchenQueue() });
});

/* ------------------------------------------------------------- new order */

router.get('/orders/new', requirePermission('orders.create'), (req, res) => {
  const orderType = str(req.query.order_type) === 'dine_in' ? 'dine_in' : 'room_service';
  res.render('pages/order-form', {
    title: 'New Order',
    mode: 'create',
    order: null,
    lines: [],
    menu: menuByCategory(true),
    occupied: occupiedRoomsNow(today()),
    defaults: {
      order_type: orderType,
      meal_type: currentMealType(),
      billing_mode: orderType === 'room_service' ? 'add_to_room' : 'cash_now',
      booking_id: int(req.query.booking_id, 0),
      room_id: int(req.query.room_id, 0),
      table_no: str(req.query.table_no),
    },
  });
});

router.post('/orders', requirePermission('orders.create'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const lines = readLines(body);
  if (!lines.length) throw new ValidationError('Add at least one item before saving the order.');

  const orderType = oneOf(body.order_type, ORDER_TYPES, 'Order type');
  const roomChoice = str(body.room_choice); // "bookingId:roomId" from the room picker
  const [bookingPart, roomPart] = roomChoice.split(':');

  const order = createOrder(
    {
      order_type: orderType,
      meal_type: oneOf(body.meal_type, MEALS, 'Meal'),
      billing_mode: oneOf(body.billing_mode, BILLING_MODES, 'Billing'),
      booking_id: optionalId(bookingPart),
      room_id: optionalId(roomPart),
      table_no: str(body.table_no),
      guest_name: str(body.guest_name),
      discount_minor: toMinor(body.discount),
      notes: str(body.notes),
      lines,
    },
    req,
  );

  req.flash('success', `Order ${order.code} saved.`);
  res.redirect(`/orders/${order.id}`);
});

/* ---------------------------------------------------------------- detail */

router.get('/orders/:id', requirePermission('orders.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  const order = getOrderView(id);
  if (!order) throw new ValidationError('Order not found.');
  res.render('pages/order-detail', {
    title: `Order ${order.code}`,
    order,
    items: orderItems(id),
    occupied: occupiedRoomsNow(today()),
  });
});

router.get('/orders/:id/edit', requirePermission('orders.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  const order = getOrderView(id);
  if (!order) throw new ValidationError('Order not found.');
  if (order.status === 'settled' || order.status === 'cancelled') {
    throw new ValidationError(`Order ${order.code} is ${order.status} and can no longer be edited.`);
  }
  res.render('pages/order-form', {
    title: `Edit ${order.code}`,
    mode: 'edit',
    order,
    lines: orderItems(id),
    menu: menuByCategory(true),
    occupied: occupiedRoomsNow(today()),
    defaults: {
      order_type: order.order_type,
      meal_type: order.meal_type,
      billing_mode: order.billing_mode,
      booking_id: order.booking_id ?? 0,
      room_id: order.room_id ?? 0,
      table_no: order.table_no,
    },
  });
});

router.post('/orders/:id/edit', requirePermission('orders.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  const body = req.body as Record<string, unknown>;
  const lines = readLines(body);
  if (!lines.length) throw new ValidationError('An order must keep at least one item.');

  updateOrder(
    id,
    {
      meal_type: oneOf(body.meal_type, MEALS, 'Meal'),
      table_no: str(body.table_no),
      guest_name: str(body.guest_name),
      discount_minor: toMinor(body.discount),
      notes: str(body.notes),
      lines,
    },
    req,
  );
  req.flash('success', 'Order updated.');
  res.redirect(`/orders/${id}`);
});

/* -------------------------------------------------------------- billing */

/**
 * Switching between "Add to Room" and "Cash Now" after the order was taken.
 * The proposal explicitly asks for staff to be able to do this themselves.
 */
router.post('/orders/:id/billing', requirePermission('orders.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  const body = req.body as Record<string, unknown>;
  const mode = oneOf(body.billing_mode, BILLING_MODES, 'Billing');
  const [bookingPart, roomPart] = str(body.room_choice).split(':');

  setBillingMode(id, mode, optionalId(bookingPart), optionalId(roomPart), req);
  req.flash('success', `Order now set to "${mode.replace(/_/g, ' ')}".`);
  res.redirect(`/orders/${id}`);
});

router.post('/orders/:id/serve', requirePermission('orders.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  markServed(id, req);
  req.flash('success', 'Order marked as served.');
  res.redirect(req.get('referer') ?? `/orders/${id}`);
});

router.post('/orders/:id/cancel', requirePermission('orders.cancel'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  cancelOrder(id, str((req.body as Record<string, unknown>).reason), req);
  req.flash('success', 'Order cancelled.');
  res.redirect(`/orders/${id}`);
});

router.post('/orders/:id/settle', requirePermission('billing.create'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  const body = req.body as Record<string, unknown>;
  const invoice = settleFoodOrder(
    id,
    {
      payment_mode: oneOf(body.payment_mode, PAYMENT_MODES, 'Payment mode'),
      payment_reference: str(body.payment_reference),
      amount_minor: str(body.amount) ? toMinor(body.amount) : undefined,
    },
    req,
  );
  req.flash('success', `Paid. Receipt ${invoice.number} created.`);
  res.redirect(`/invoices/${invoice.id}?print=thermal`);
});

/* ------------------------------------------------------------------ KOT */

router.get('/orders/:id/kot', requirePermission('orders.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Order');
  const order = getOrderView(id);
  if (!order) throw new ValidationError('Order not found.');
  markKotPrinted(id);
  res.render('print/kot', {
    title: `KOT ${order.code}`,
    order,
    items: orderItems(id),
    settings: getSettings(),
    autoPrint: str(req.query.auto) !== '0',
  });
});

export default router;
