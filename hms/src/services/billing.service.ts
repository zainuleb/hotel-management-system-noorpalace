import type { Request } from 'express';
import { all, get, nextCounter, run, scalar, tx } from '../db/index.js';
import { formatDate, nowTs, today } from '../lib/dates.js';
import { percentOf } from '../lib/money.js';
import { ValidationError } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { getSettings, taxPercent } from './settings.service.js';
import {
  getBooking,
  guestOf,
  markCheckedOut,
  roomChargeLines,
  type RoomChargeLine,
} from './bookings.service.js';
import { getOrder, orderItems } from './orders.service.js';
import type { Invoice, InvoiceLine, InvoiceStatus, MealType, Payment, PaymentMode } from '../types/domain.js';

export function nextInvoiceNumber(): string {
  const prefix = getSettings().invoice_prefix || 'INV';
  const year = today().slice(0, 4);
  const n = nextCounter(`invoice-${year}`);
  return `${prefix}-${year}-${String(n).padStart(5, '0')}`;
}

/* ------------------------------------------------------------ bill preview */

export interface DraftLine {
  section: 'room' | MealType | 'other';
  description: string;
  qty: number;
  unit_minor: number;
  amount_minor: number;
}

export interface BillDraft {
  room_lines: RoomChargeLine[];
  food_lines: DraftLine[];
  room_charges_minor: number;
  food_charges_minor: number;
  discount_minor: number;
  net_minor: number;
  tax_percent: number;
  tax_minor: number;
  total_minor: number;
  /** Orders that will be settled by this bill. */
  order_ids: number[];
  complimentary_minor: number;
}

/** Food charged to the room and still waiting to be billed. */
function pendingRoomOrders(bookingId: number) {
  return all<{ id: number; code: string; meal_type: MealType; billing_mode: string; total_minor: number; discount_minor: number; subtotal_minor: number }>(
    `SELECT id, code, meal_type, billing_mode, total_minor, discount_minor, subtotal_minor
       FROM orders
      WHERE booking_id = ?
        AND billing_mode IN ('add_to_room','complimentary')
        AND status IN ('open','served')
      ORDER BY id`,
    bookingId,
  );
}

/**
 * Builds the guest's bill without writing anything, so the check-out screen and
 * the saved invoice are guaranteed to agree.
 */
export function buildBillDraft(bookingId: number, departureDate: string, discountMinor: number): BillDraft {
  const booking = getBooking(bookingId);
  if (!booking) throw new ValidationError('Booking not found.');

  const roomLines = roomChargeLines(bookingId, departureDate);
  const roomCharges = roomLines.reduce((s, l) => s + l.amount_minor, 0);

  const foodLines: DraftLine[] = [];
  const orderIds: number[] = [];
  let foodCharges = 0;
  let complimentary = 0;

  for (const order of pendingRoomOrders(bookingId)) {
    orderIds.push(order.id);
    const isComp = order.billing_mode === 'complimentary';
    for (const item of orderItems(order.id)) {
      foodLines.push({
        section: order.meal_type,
        description: isComp ? `${item.name_snapshot} (complimentary)` : item.name_snapshot,
        qty: item.qty,
        unit_minor: isComp ? 0 : item.unit_minor,
        amount_minor: isComp ? 0 : item.line_minor,
      });
    }
    if (isComp) {
      complimentary += order.subtotal_minor;
    } else {
      if (order.discount_minor > 0) {
        foodLines.push({
          section: order.meal_type,
          description: `Discount on ${order.code}`,
          qty: 1,
          unit_minor: -order.discount_minor,
          amount_minor: -order.discount_minor,
        });
      }
      foodCharges += order.total_minor;
    }
  }

  const gross = roomCharges + foodCharges;
  const discount = Math.min(Math.max(0, discountMinor), gross);
  const net = gross - discount;
  const percent = taxPercent();
  const tax = percentOf(net, percent);

  return {
    room_lines: roomLines,
    food_lines: foodLines,
    room_charges_minor: roomCharges,
    food_charges_minor: foodCharges,
    discount_minor: discount,
    net_minor: net,
    tax_percent: percent,
    tax_minor: tax,
    total_minor: net + tax,
    order_ids: orderIds,
    complimentary_minor: complimentary,
  };
}

/* ------------------------------------------------------------- check-out */

export interface CheckoutInput {
  departure_date: string;
  discount_minor: number;
  notes: string;
  /** Optional payment taken at the desk while checking out. */
  payment_amount_minor?: number;
  payment_mode?: PaymentMode;
  payment_reference?: string;
}

export function checkoutAndInvoice(bookingId: number, input: CheckoutInput, req: Request): Invoice {
  return tx(() => {
    const booking = getBooking(bookingId);
    if (!booking) throw new ValidationError('Booking not found.');
    if (booking.status === 'cancelled') throw new ValidationError('This booking was cancelled.');
    if (booking.status === 'reserved') {
      throw new ValidationError('The guest has not checked in yet, so there is nothing to check out.');
    }
    if (booking.status === 'checked_out' && activeInvoiceForBooking(bookingId)) {
      throw new ValidationError('This stay has already been billed.');
    }
    if (input.departure_date < booking.arrival_date) {
      throw new ValidationError('The check-out date cannot be before the arrival date.');
    }

    const draft = buildBillDraft(bookingId, input.departure_date, input.discount_minor);
    const guest = guestOf(bookingId);
    const ts = nowTs();
    const number = nextInvoiceNumber();

    const res = run(
      `INSERT INTO invoices
         (number, kind, booking_id, guest_name, guest_phone, room_charges_minor, food_charges_minor,
          discount_minor, tax_percent, tax_minor, total_minor, status, notes, created_by, created_at)
       VALUES (?, 'stay', ?,?,?,?,?,?,?,?,?, 'unpaid', ?,?,?)`,
      number,
      bookingId,
      guest?.full_name ?? '',
      guest?.phone ?? '',
      draft.room_charges_minor,
      draft.food_charges_minor,
      draft.discount_minor,
      draft.tax_percent,
      draft.tax_minor,
      draft.total_minor,
      input.notes,
      req.user?.id ?? null,
      ts,
    );
    const invoiceId = res.lastInsertRowid;

    let sort = 0;
    for (const line of draft.room_lines) {
      insertLine(invoiceId, {
        section: 'room',
        description: `Room ${line.room_number} · ${formatDate(line.from_date)} → ${formatDate(line.to_date)}`,
        qty: line.nights,
        unit_minor: line.rate_minor,
        amount_minor: line.amount_minor,
      }, sort++);
    }
    for (const line of draft.food_lines) {
      insertLine(invoiceId, line, sort++);
    }

    if (draft.order_ids.length) {
      const placeholders = draft.order_ids.map(() => '?').join(',');
      run(
        `UPDATE orders SET status = 'settled', invoice_id = ?, updated_at = ? WHERE id IN (${placeholders})`,
        invoiceId,
        ts,
        ...draft.order_ids,
      );
    }

    markCheckedOut(bookingId, input.departure_date);

    if (input.payment_amount_minor && input.payment_amount_minor > 0) {
      addPayment(
        invoiceId,
        input.payment_amount_minor,
        input.payment_mode ?? 'cash',
        input.payment_reference ?? '',
        '',
        req,
      );
    } else {
      recalcInvoiceStatus(invoiceId);
    }

    logActivity(
      req,
      'checked out',
      'booking',
      bookingId,
      `${booking.code} · invoice ${number} · departure ${input.departure_date}`,
    );
    logActivity(req, 'created invoice', 'invoice', invoiceId, `${number} for ${booking.code}`);

    return getInvoice(invoiceId)!;
  });
}

function insertLine(invoiceId: number, line: DraftLine, sort: number): void {
  run(
    `INSERT INTO invoice_lines (invoice_id, section, description, qty, unit_minor, amount_minor, sort_order)
     VALUES (?,?,?,?,?,?,?)`,
    invoiceId,
    line.section,
    line.description,
    line.qty,
    line.unit_minor,
    line.amount_minor,
    sort,
  );
}

/* ------------------------------------------------- walk-in / cash-now sale */

export interface SettleOrderInput {
  payment_mode: PaymentMode;
  payment_reference?: string;
  amount_minor?: number;
  notes?: string;
}

/** Closes a "Cash Now" order as its own walk-in sale with its own receipt. */
export function settleFoodOrder(orderId: number, input: SettleOrderInput, req: Request): Invoice {
  return tx(() => {
    const order = getOrder(orderId);
    if (!order) throw new ValidationError('Order not found.');
    if (order.status === 'settled') throw new ValidationError(`Order ${order.code} is already settled.`);
    if (order.status === 'cancelled') throw new ValidationError(`Order ${order.code} was cancelled.`);
    if (order.billing_mode === 'add_to_room') {
      throw new ValidationError(
        `Order ${order.code} is charged to a room. It will be billed when the guest checks out.`,
      );
    }

    const net = order.total_minor;
    const percent = order.billing_mode === 'complimentary' ? 0 : taxPercent();
    const tax = percentOf(net, percent);
    const total = net + tax;
    const ts = nowTs();
    const number = nextInvoiceNumber();

    const res = run(
      `INSERT INTO invoices
         (number, kind, booking_id, guest_name, guest_phone, room_charges_minor, food_charges_minor,
          discount_minor, tax_percent, tax_minor, total_minor, status, notes, created_by, created_at)
       VALUES (?, 'food_sale', NULL, ?, '', 0, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)`,
      number,
      order.guest_name || (order.table_no ? `Table ${order.table_no}` : 'Walk-in'),
      order.subtotal_minor,
      order.discount_minor,
      percent,
      tax,
      total,
      input.notes ?? '',
      req.user?.id ?? null,
      ts,
    );
    const invoiceId = res.lastInsertRowid;

    let sort = 0;
    for (const item of orderItems(orderId)) {
      insertLine(invoiceId, {
        section: order.meal_type,
        description: item.name_snapshot,
        qty: item.qty,
        unit_minor: item.unit_minor,
        amount_minor: item.line_minor,
      }, sort++);
    }
    if (order.discount_minor > 0) {
      insertLine(invoiceId, {
        section: order.meal_type,
        description: 'Discount',
        qty: 1,
        unit_minor: -order.discount_minor,
        amount_minor: -order.discount_minor,
      }, sort++);
    }

    run(`UPDATE orders SET status = 'settled', invoice_id = ?, updated_at = ? WHERE id = ?`, invoiceId, ts, orderId);

    const paid = input.amount_minor && input.amount_minor > 0 ? input.amount_minor : total;
    if (paid > 0) {
      addPayment(invoiceId, paid, input.payment_mode, input.payment_reference ?? '', '', req);
    } else {
      recalcInvoiceStatus(invoiceId);
    }

    logActivity(req, 'settled order', 'order', orderId, `${order.code} · invoice ${number}`);
    return getInvoice(invoiceId)!;
  });
}

/* ---------------------------------------------------------------- invoices */

export function getInvoice(id: number): Invoice | undefined {
  return get<Invoice>('SELECT * FROM invoices WHERE id = ?', id);
}

export function getInvoiceByNumber(number: string): Invoice | undefined {
  return get<Invoice>('SELECT * FROM invoices WHERE number = ?', number);
}

export function invoiceLines(invoiceId: number): InvoiceLine[] {
  return all<InvoiceLine>('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, id', invoiceId);
}

/** Lines grouped into the sections the proposal asks for on the final bill. */
export function groupedInvoiceLines(invoiceId: number): { section: string; label: string; lines: InvoiceLine[]; total_minor: number }[] {
  const labels: Record<string, string> = {
    room: 'Room Charges',
    breakfast: 'Breakfast',
    lunch: 'Lunch',
    dinner: 'Dinner',
    other: 'Other',
  };
  const order = ['room', 'breakfast', 'lunch', 'dinner', 'other'];
  const groups = new Map<string, InvoiceLine[]>();
  for (const line of invoiceLines(invoiceId)) {
    const bucket = groups.get(line.section) ?? [];
    bucket.push(line);
    groups.set(line.section, bucket);
  }
  return order
    .filter((section) => groups.has(section))
    .map((section) => {
      const lines = groups.get(section)!;
      return {
        section,
        label: labels[section] ?? section,
        lines,
        total_minor: lines.reduce((s, l) => s + l.amount_minor, 0),
      };
    });
}

export function invoicePayments(invoiceId: number): (Payment & { received_by_name: string | null })[] {
  return all(
    `SELECT p.*, u.full_name AS received_by_name
       FROM payments p LEFT JOIN users u ON u.id = p.received_by
      WHERE p.invoice_id = ? ORDER BY p.id`,
    invoiceId,
  );
}

export function paidTotal(invoiceId: number): number {
  return scalar('SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE invoice_id = ?', invoiceId);
}

export function balanceOf(invoice: Invoice): number {
  return invoice.status === 'void' ? 0 : invoice.total_minor - paidTotal(invoice.id);
}

export function recalcInvoiceStatus(invoiceId: number): InvoiceStatus {
  const invoice = getInvoice(invoiceId);
  if (!invoice) return 'unpaid';
  if (invoice.status === 'void') return 'void';
  const paid = paidTotal(invoiceId);
  let status: InvoiceStatus = 'unpaid';
  if (invoice.total_minor <= 0 || paid >= invoice.total_minor) status = 'paid';
  else if (paid > 0) status = 'partial';
  run('UPDATE invoices SET status = ? WHERE id = ?', status, invoiceId);
  return status;
}

export function addPayment(
  invoiceId: number,
  amountMinor: number,
  mode: PaymentMode,
  reference: string,
  note: string,
  req: Request,
): void {
  const invoice = getInvoice(invoiceId);
  if (!invoice) throw new ValidationError('Invoice not found.');
  if (invoice.status === 'void') throw new ValidationError('This invoice has been voided.');
  if (amountMinor <= 0) throw new ValidationError('Enter an amount greater than zero.');

  const outstanding = invoice.total_minor - paidTotal(invoiceId);
  if (amountMinor > outstanding) {
    throw new ValidationError(
      `That is more than the outstanding balance. The guest owes ${(outstanding / 100).toFixed(2)}.`,
    );
  }

  run(
    `INSERT INTO payments (invoice_id, amount_minor, mode, reference, note, received_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    invoiceId,
    amountMinor,
    mode,
    reference,
    note,
    req.user?.id ?? null,
    nowTs(),
  );
  recalcInvoiceStatus(invoiceId);
  logActivity(req, 'recorded payment', 'invoice', invoiceId, `${invoice.number} · ${(amountMinor / 100).toFixed(2)} by ${mode}`);
}

export function voidInvoice(id: number, reason: string, req: Request): void {
  const invoice = getInvoice(id);
  if (!invoice) throw new ValidationError('Invoice not found.');
  if (invoice.status === 'void') return;
  if (paidTotal(id) > 0) {
    throw new ValidationError('This invoice has payments against it. Refund and remove them before voiding.');
  }
  tx(() => {
    run(
      `UPDATE invoices SET status = 'void', voided_at = ?, notes = TRIM(notes || ' | voided: ' || ?) WHERE id = ?`,
      nowTs(),
      reason || 'no reason given',
      id,
    );
    // Release the orders so they can be billed again on a corrected invoice.
    run(`UPDATE orders SET status = 'served', invoice_id = NULL, updated_at = ? WHERE invoice_id = ?`, nowTs(), id);
    logActivity(req, 'voided invoice', 'invoice', id, `${invoice.number}${reason ? ` · ${reason}` : ''}`);
  });
}

export function activeInvoiceForBooking(bookingId: number): Invoice | undefined {
  return get<Invoice>(
    `SELECT * FROM invoices WHERE booking_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 1`,
    bookingId,
  );
}

export function invoicesForBooking(bookingId: number): Invoice[] {
  return all<Invoice>('SELECT * FROM invoices WHERE booking_id = ? ORDER BY id DESC', bookingId);
}

export interface InvoiceFilters {
  status?: string;
  kind?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface InvoiceRow extends Invoice {
  paid_minor: number;
  balance_minor: number;
  booking_code: string | null;
}

export function listInvoices(filters: InvoiceFilters = {}): InvoiceRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'outstanding') where.push(`i.status IN ('unpaid','partial')`);
    else {
      where.push('i.status = ?');
      params.push(filters.status);
    }
  }
  if (filters.kind && filters.kind !== 'all') {
    where.push('i.kind = ?');
    params.push(filters.kind);
  }
  if (filters.q) {
    where.push('(i.number LIKE ? OR i.guest_name LIKE ? OR b.code LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }
  if (filters.from) {
    where.push('DATE(i.created_at) >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('DATE(i.created_at) <= ?');
    params.push(filters.to);
  }
  params.push(filters.limit ?? 200);

  return all<InvoiceRow>(
    `SELECT i.*, b.code AS booking_code,
            COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_minor,
            i.total_minor - COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.invoice_id = i.id), 0) AS balance_minor
       FROM invoices i LEFT JOIN bookings b ON b.id = i.booking_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.id DESC LIMIT ?`,
    ...params,
  );
}
