import { Router } from 'express';
import { get } from '../db/index.js';
import { requirePermission } from '../lib/session.js';
import { addDays, isValidDate, nightsBetween, today } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { bool, int, oneOf, optionalId, positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import { recentActivity } from '../lib/activity.js';
import { availableRooms, getRoom, listRoomTypes, listRooms } from '../services/rooms.service.js';
import {
  bookingSegments,
  cancelBooking,
  changeRoom,
  checkIn,
  createBooking,
  currentSegment,
  extendStay,
  getBooking,
  listBookings,
  updateBooking,
} from '../services/bookings.service.js';
import { activeInvoiceForBooking, buildBillDraft, checkoutAndInvoice, invoicesForBooking } from '../services/billing.service.js';
import { ordersForBooking } from '../services/orders.service.js';
import type { Guest, PackageType, PaymentMode } from '../types/domain.js';

const router = Router();

const PACKAGES: PackageType[] = ['room_only', 'room_meals', 'dine_in_stay'];
const PAYMENT_MODES: PaymentMode[] = ['cash', 'card', 'bank_transfer', 'online'];

/* --------------------------------------------------------------- listing */

router.get('/bookings', requirePermission('bookings.view'), (req, res) => {
  const status = str(req.query.status) || 'active';
  const q = str(req.query.q);
  res.render('pages/bookings', {
    title: 'Bookings',
    status,
    q,
    bookings: listBookings({ status, q }),
  });
});

/** Availability refresh for the booking form, without losing typed details. */
router.get('/bookings/rooms.json', requirePermission('bookings.view'), (req, res) => {
  const from = str(req.query.from);
  const to = str(req.query.to);
  const exclude = optionalId(req.query.exclude);
  if (!isValidDate(from) || !isValidDate(to) || to <= from) {
    res.json([]);
    return;
  }
  res.json(
    availableRooms(from, to, exclude).map((room) => ({
      id: room.id,
      number: room.number,
      type_name: room.type_name,
      base_rate: room.base_rate,
      floor: room.floor,
    })),
  );
});

/* ------------------------------------------------------------ new booking */

router.get('/bookings/new', requirePermission('bookings.create'), (req, res) => {
  const arrival = isValidDate(str(req.query.arrival_date)) ? str(req.query.arrival_date) : today();
  const rawDeparture = str(req.query.departure_date);
  const departure = isValidDate(rawDeparture) && rawDeparture > arrival ? rawDeparture : addDays(arrival, 1);
  const preselectedRoom = int(req.query.room_id, 0);

  res.render('pages/booking-form', {
    title: 'New Booking',
    mode: 'create',
    booking: null,
    guest: null,
    segment: null,
    form: {
      arrival_date: arrival,
      departure_date: departure,
      room_id: preselectedRoom,
      package: 'room_only',
      adults: 1,
      children: 0,
    },
    rooms: availableRooms(arrival, departure),
    allRooms: listRooms(),
    roomTypes: listRoomTypes(),
  });
});

router.post('/bookings', requirePermission('bookings.create'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const arrival = str(body.arrival_date);
  const departure = str(body.departure_date);
  if (!isValidDate(arrival) || !isValidDate(departure)) {
    throw new ValidationError('Please give a valid arrival and departure date.');
  }

  const roomId = positiveInt(body.room_id, 'Room');
  const room = getRoom(roomId);
  if (!room) throw new ValidationError('That room does not exist.');

  const rateInput = str(body.rate_minor);
  const rate = rateInput ? toMinor(rateInput) : room.base_rate;
  if (rate < 0) throw new ValidationError('The nightly rate cannot be negative.');

  const booking = createBooking(
    {
      guest: {
        guest_id: optionalId(body.guest_id),
        full_name: requiredStr(body.full_name, 'Guest name', 120),
        id_number: str(body.id_number),
        phone: str(body.phone),
        email: str(body.email),
        address: str(body.address),
        nationality: str(body.nationality),
      },
      room_id: roomId,
      arrival_date: arrival,
      departure_date: departure,
      rate_minor: rate,
      package: oneOf(body.package, PACKAGES, 'Booking type'),
      adults: Math.max(1, int(body.adults, 1)),
      children: Math.max(0, int(body.children, 0)),
      discount_minor: toMinor(body.discount_minor),
      notes: str(body.notes),
      check_in_now: bool(body.check_in_now) === 1,
    },
    req,
  );

  req.flash('success', `Booking ${booking.code} created for room ${room.number}.`);
  res.redirect(`/bookings/${booking.id}`);
});

/* ---------------------------------------------------------------- detail */

function bookingPageData(id: number) {
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  const guest = get<Guest>('SELECT * FROM guests WHERE id = ?', booking.guest_id);
  const segments = bookingSegments(id);
  const orders = ordersForBooking(id);
  const invoices = invoicesForBooking(id);
  const current = currentSegment(id);
  return { booking, guest, segments, orders, invoices, current };
}

router.get('/bookings/:id', requirePermission('bookings.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const data = bookingPageData(id);
  const departure = data.booking.status === 'checked_in' ? maxDate(today(), data.booking.arrival_date) : data.booking.departure_date;

  res.render('pages/booking-detail', {
    title: `Booking ${data.booking.code}`,
    ...data,
    nights: Math.max(1, nightsBetween(data.booking.arrival_date, data.booking.departure_date)),
    draft: data.booking.status === 'cancelled' ? null : buildBillDraft(id, departure, data.booking.discount_minor),
    previewDeparture: departure,
    activeInvoice: activeInvoiceForBooking(id),
    freeRooms: data.booking.status === 'checked_in' ? availableRooms(today(), data.booking.departure_date, id) : [],
    history: recentActivity(40, 'booking', id),
  });
});

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/* ------------------------------------------------------------------ edit */

router.get('/bookings/:id/edit', requirePermission('bookings.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const { booking, guest, current } = bookingPageData(id);
  if (booking.status !== 'reserved') {
    throw new ValidationError('Only a reservation can be edited. Use Change Room or Extend Stay instead.');
  }
  const free = availableRooms(booking.arrival_date, booking.departure_date, id);
  const assigned = current ? getRoom(current.room_id) : null;
  const rooms = assigned && !free.some((r) => r.id === assigned.id) ? [assigned, ...free] : free;

  res.render('pages/booking-form', {
    title: `Edit ${booking.code}`,
    mode: 'edit',
    booking,
    guest,
    segment: current,
    form: {
      arrival_date: booking.arrival_date,
      departure_date: booking.departure_date,
      room_id: current?.room_id ?? 0,
      package: booking.package,
      adults: booking.adults,
      children: booking.children,
    },
    rooms,
    allRooms: listRooms(),
    roomTypes: listRoomTypes(),
  });
});

router.post('/bookings/:id/edit', requirePermission('bookings.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const body = req.body as Record<string, unknown>;
  const roomId = positiveInt(body.room_id, 'Room');
  const room = getRoom(roomId);
  if (!room) throw new ValidationError('That room does not exist.');
  const rateInput = str(body.rate_minor);

  updateBooking(
    id,
    {
      guest: {
        full_name: requiredStr(body.full_name, 'Guest name', 120),
        id_number: str(body.id_number),
        phone: str(body.phone),
        email: str(body.email),
        address: str(body.address),
        nationality: str(body.nationality),
      },
      room_id: roomId,
      arrival_date: str(body.arrival_date),
      departure_date: str(body.departure_date),
      rate_minor: rateInput ? toMinor(rateInput) : room.base_rate,
      package: oneOf(body.package, PACKAGES, 'Booking type'),
      adults: Math.max(1, int(body.adults, 1)),
      children: Math.max(0, int(body.children, 0)),
      discount_minor: toMinor(body.discount_minor),
      notes: str(body.notes),
    },
    req,
  );

  req.flash('success', 'Booking updated.');
  res.redirect(`/bookings/${id}`);
});

/* -------------------------------------------------------------- lifecycle */

router.post('/bookings/:id/check-in', requirePermission('bookings.checkin'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  checkIn(id, req);
  req.flash('success', 'Guest checked in.');
  res.redirect(`/bookings/${id}`);
});

router.post('/bookings/:id/cancel', requirePermission('bookings.cancel'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  cancelBooking(id, str((req.body as Record<string, unknown>).reason), req);
  req.flash('success', 'Booking cancelled.');
  res.redirect(`/bookings/${id}`);
});

router.post('/bookings/:id/extend', requirePermission('bookings.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const departure = str((req.body as Record<string, unknown>).departure_date);
  if (!isValidDate(departure)) throw new ValidationError('Give a valid new departure date.');
  extendStay(id, departure, req);
  req.flash('success', `Stay extended to ${departure}.`);
  res.redirect(`/bookings/${id}`);
});

router.post('/bookings/:id/change-room', requirePermission('bookings.edit'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const body = req.body as Record<string, unknown>;
  const roomId = positiveInt(body.room_id, 'Room');
  const room = getRoom(roomId);
  if (!room) throw new ValidationError('That room does not exist.');
  const from = isValidDate(str(body.from_date)) ? str(body.from_date) : today();
  const rateInput = str(body.rate_minor);

  changeRoom(id, roomId, from, rateInput ? toMinor(rateInput) : room.base_rate, req);
  req.flash('success', `Guest moved to room ${room.number}.`);
  res.redirect(`/bookings/${id}`);
});

/* -------------------------------------------------------------- check-out */

router.get('/bookings/:id/check-out', requirePermission('bookings.checkout'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const { booking, guest, orders } = bookingPageData(id);
  if (booking.status !== 'checked_in') {
    throw new ValidationError('This booking is not currently checked in.');
  }
  const departure = isValidDate(str(req.query.departure_date))
    ? str(req.query.departure_date)
    : maxDate(today(), booking.arrival_date);
  const discount = str(req.query.discount_minor) ? toMinor(req.query.discount_minor) : booking.discount_minor;

  res.render('pages/check-out', {
    title: `Check out ${booking.code}`,
    booking,
    guest,
    orders,
    departure,
    discountMinor: discount,
    draft: buildBillDraft(id, departure, discount),
    openOrders: orders.filter((o) => o.status === 'open'),
  });
});

router.post('/bookings/:id/check-out', requirePermission('bookings.checkout'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const body = req.body as Record<string, unknown>;
  const departure = str(body.departure_date);
  if (!isValidDate(departure)) throw new ValidationError('Give a valid check-out date.');

  const paymentAmount = toMinor(body.payment_amount);
  const invoice = checkoutAndInvoice(
    id,
    {
      departure_date: departure,
      discount_minor: toMinor(body.discount_minor),
      notes: str(body.notes),
      payment_amount_minor: paymentAmount,
      payment_mode: paymentAmount > 0 ? oneOf(body.payment_mode, PAYMENT_MODES, 'Payment mode') : undefined,
      payment_reference: str(body.payment_reference),
    },
    req,
  );

  req.flash('success', `Checked out. Invoice ${invoice.number} created.`);
  res.redirect(`/invoices/${invoice.id}`);
});

/** Re-issue a bill after the previous one was voided. */
router.post('/bookings/:id/re-invoice', requirePermission('billing.create'), (req, res) => {
  const id = positiveInt(req.params.id, 'Booking');
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  if (activeInvoiceForBooking(id)) throw new ValidationError('This stay already has a live invoice.');

  const invoice = checkoutAndInvoice(
    id,
    {
      departure_date: booking.departure_date,
      discount_minor: toMinor((req.body as Record<string, unknown>).discount_minor) || booking.discount_minor,
      notes: 'Re-issued after void',
    },
    req,
  );
  req.flash('success', `Invoice ${invoice.number} re-issued.`);
  res.redirect(`/invoices/${invoice.id}`);
});

export default router;
