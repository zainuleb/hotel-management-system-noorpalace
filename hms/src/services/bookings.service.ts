import type { Request } from 'express';
import { all, get, nextCounter, run, scalar, tx } from '../db/index.js';
import { addDays, nightsBetween, nowTs, today } from '../lib/dates.js';
import { ValidationError } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { getSettings } from './settings.service.js';
import { getRoom, isRoomAvailable, roomConflict } from './rooms.service.js';
import type { Booking, BookingRoom, BookingStatus, Guest, PackageType } from '../types/domain.js';

export interface BookingListRow extends Booking {
  guest_name: string;
  guest_phone: string;
  room_numbers: string;
  nights: number;
}

const LIST_SELECT = `
  SELECT b.*, g.full_name AS guest_name, g.phone AS guest_phone,
         (SELECT GROUP_CONCAT(r.number, ', ')
            FROM booking_rooms br JOIN rooms r ON r.id = br.room_id
           WHERE br.booking_id = b.id) AS room_numbers
    FROM bookings b JOIN guests g ON g.id = b.guest_id`;

export function nextBookingCode(): string {
  const prefix = getSettings().booking_prefix || 'BK';
  const n = nextCounter('booking');
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

/* ------------------------------------------------------------------ guests */

export interface GuestInput {
  guest_id?: number | null;
  full_name: string;
  id_number?: string;
  phone?: string;
  email?: string;
  address?: string;
  nationality?: string;
}

export function findOrCreateGuest(input: GuestInput): number {
  if (input.guest_id) {
    const existing = get<Guest>('SELECT * FROM guests WHERE id = ?', input.guest_id);
    if (existing) {
      // Fill in details the front desk collected at check-in time.
      run(
        `UPDATE guests SET full_name = ?, id_number = ?, phone = ?, email = ?, address = ?, nationality = ?
          WHERE id = ?`,
        input.full_name || existing.full_name,
        input.id_number ?? existing.id_number,
        input.phone ?? existing.phone,
        input.email ?? existing.email,
        input.address ?? existing.address,
        input.nationality ?? existing.nationality,
        existing.id,
      );
      return existing.id;
    }
  }
  const res = run(
    `INSERT INTO guests (full_name, id_number, phone, email, address, nationality, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    input.full_name,
    input.id_number ?? '',
    input.phone ?? '',
    input.email ?? '',
    input.address ?? '',
    input.nationality ?? '',
    nowTs(),
  );
  return res.lastInsertRowid;
}

export function searchGuests(term: string, limit = 20): Guest[] {
  const like = `%${term}%`;
  return all<Guest>(
    `SELECT * FROM guests
      WHERE full_name LIKE ? OR phone LIKE ? OR id_number LIKE ?
      ORDER BY full_name LIMIT ?`,
    like,
    like,
    like,
    limit,
  );
}

/* ---------------------------------------------------------------- bookings */

export interface CreateBookingInput {
  guest: GuestInput;
  room_id: number;
  arrival_date: string;
  departure_date: string;
  rate_minor: number;
  package: PackageType;
  adults: number;
  children: number;
  discount_minor: number;
  notes: string;
  /** Walk-in guests are checked in immediately. */
  check_in_now: boolean;
}

export function createBooking(input: CreateBookingInput, req: Request): Booking {
  if (input.departure_date < input.arrival_date) {
    throw new ValidationError('Departure date cannot be before the arrival date.');
  }
  const room = getRoom(input.room_id);
  if (!room) throw new ValidationError('Please choose a room.');
  if (room.is_out_of_service) throw new ValidationError(`Room ${room.number} is under maintenance.`);

  // A same-day booking still holds the room for that night.
  const holdTo = input.departure_date > input.arrival_date ? input.departure_date : addDays(input.arrival_date, 1);

  return tx(() => {
    const clash = roomConflict(input.room_id, input.arrival_date, holdTo);
    if (clash) {
      throw new ValidationError(
        `Room ${room.number} is already held by ${clash.code} (${clash.guest_name}) from ${clash.from_date} to ${clash.to_date}.`,
      );
    }
    if (input.check_in_now && input.arrival_date > today()) {
      throw new ValidationError('A booking that starts in the future cannot be checked in yet.');
    }

    const guestId = findOrCreateGuest(input.guest);
    const code = nextBookingCode();
    const status: BookingStatus = input.check_in_now ? 'checked_in' : 'reserved';
    const ts = nowTs();

    const res = run(
      `INSERT INTO bookings
        (code, guest_id, status, package, arrival_date, departure_date, adults, children,
         discount_minor, notes, checked_in_at, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      code,
      guestId,
      status,
      input.package,
      input.arrival_date,
      input.departure_date,
      input.adults,
      input.children,
      input.discount_minor,
      input.notes,
      input.check_in_now ? ts : null,
      req.user?.id ?? null,
      ts,
      ts,
    );
    const bookingId = res.lastInsertRowid;

    run(
      `INSERT INTO booking_rooms (booking_id, room_id, from_date, to_date, rate_minor, created_at)
       VALUES (?,?,?,?,?,?)`,
      bookingId,
      input.room_id,
      input.arrival_date,
      holdTo,
      input.rate_minor,
      ts,
    );

    logActivity(
      req,
      input.check_in_now ? 'walk-in check-in' : 'created booking',
      'booking',
      bookingId,
      `${code} · Room ${room.number} · ${input.arrival_date} → ${input.departure_date}`,
    );

    return getBooking(bookingId)!;
  });
}

export function getBooking(id: number): Booking | undefined {
  return get<Booking>('SELECT * FROM bookings WHERE id = ?', id);
}

export function getBookingByCode(code: string): Booking | undefined {
  return get<Booking>('SELECT * FROM bookings WHERE code = ?', code);
}

export interface BookingFilters {
  status?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function listBookings(filters: BookingFilters = {}): BookingListRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'active') {
      where.push(`b.status IN ('reserved','checked_in')`);
    } else {
      where.push('b.status = ?');
      params.push(filters.status);
    }
  }
  if (filters.q) {
    where.push('(b.code LIKE ? OR g.full_name LIKE ? OR g.phone LIKE ? OR g.id_number LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  if (filters.from) {
    where.push('b.departure_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('b.arrival_date <= ?');
    params.push(filters.to);
  }

  const sql = `${LIST_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY b.arrival_date DESC, b.id DESC
    LIMIT ?`;
  params.push(filters.limit ?? 200);

  return all<BookingListRow>(sql, ...params).map((row) => ({
    ...row,
    nights: Math.max(1, nightsBetween(row.arrival_date, row.departure_date)),
  }));
}

export function bookingSegments(bookingId: number): (BookingRoom & { room_number: string; type_name: string })[] {
  return all(
    `SELECT br.*, r.number AS room_number, t.name AS type_name
       FROM booking_rooms br
       JOIN rooms r ON r.id = br.room_id
       JOIN room_types t ON t.id = r.room_type_id
      WHERE br.booking_id = ?
      ORDER BY br.from_date, br.id`,
    bookingId,
  );
}

/** The room the guest is in right now (the latest segment). */
export function currentSegment(bookingId: number): (BookingRoom & { room_number: string }) | undefined {
  return get(
    `SELECT br.*, r.number AS room_number
       FROM booking_rooms br JOIN rooms r ON r.id = br.room_id
      WHERE br.booking_id = ?
      ORDER BY br.from_date DESC, br.id DESC LIMIT 1`,
    bookingId,
  );
}

export interface UpdateBookingInput {
  guest: GuestInput;
  room_id: number;
  arrival_date: string;
  departure_date: string;
  rate_minor: number;
  package: PackageType;
  adults: number;
  children: number;
  discount_minor: number;
  notes: string;
}

/** Editing dates/room is only offered while the booking is still a reservation. */
export function updateBooking(id: number, input: UpdateBookingInput, req: Request): void {
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  if (booking.status !== 'reserved') {
    throw new ValidationError(
      'Only a reservation can be edited. For a checked-in guest use Change Room or Extend Stay.',
    );
  }
  if (input.departure_date < input.arrival_date) {
    throw new ValidationError('Departure date cannot be before the arrival date.');
  }
  const room = getRoom(input.room_id);
  if (!room) throw new ValidationError('Please choose a room.');

  const holdTo = input.departure_date > input.arrival_date ? input.departure_date : addDays(input.arrival_date, 1);

  tx(() => {
    const clash = roomConflict(input.room_id, input.arrival_date, holdTo, id);
    if (clash) {
      throw new ValidationError(
        `Room ${room.number} is already held by ${clash.code} (${clash.guest_name}) from ${clash.from_date} to ${clash.to_date}.`,
      );
    }
    findOrCreateGuest({ ...input.guest, guest_id: booking.guest_id });
    run(
      `UPDATE bookings SET package = ?, arrival_date = ?, departure_date = ?, adults = ?, children = ?,
              discount_minor = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      input.package,
      input.arrival_date,
      input.departure_date,
      input.adults,
      input.children,
      input.discount_minor,
      input.notes,
      nowTs(),
      id,
    );
    run('DELETE FROM booking_rooms WHERE booking_id = ?', id);
    run(
      `INSERT INTO booking_rooms (booking_id, room_id, from_date, to_date, rate_minor, created_at)
       VALUES (?,?,?,?,?,?)`,
      id,
      input.room_id,
      input.arrival_date,
      holdTo,
      input.rate_minor,
      nowTs(),
    );
    logActivity(req, 'edited booking', 'booking', id, `${booking.code} · Room ${room.number}`);
  });
}

export function cancelBooking(id: number, reason: string, req: Request): void {
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  if (booking.status === 'checked_out') throw new ValidationError('A completed stay cannot be cancelled.');
  if (booking.status === 'cancelled') return;
  if (booking.status === 'checked_in') {
    throw new ValidationError('This guest is already checked in. Check them out instead of cancelling.');
  }
  run(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?`,
    nowTs(),
    reason,
    nowTs(),
    id,
  );
  logActivity(req, 'cancelled booking', 'booking', id, `${booking.code}${reason ? ` · ${reason}` : ''}`);
}

export function checkIn(id: number, req: Request): void {
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  if (booking.status === 'checked_in') return;
  if (booking.status !== 'reserved') throw new ValidationError('Only a reservation can be checked in.');
  if (booking.arrival_date > today()) {
    throw new ValidationError(`This booking starts on ${booking.arrival_date}. It cannot be checked in early.`);
  }
  const segment = currentSegment(id);
  run(
    `UPDATE bookings SET status = 'checked_in', checked_in_at = ?, updated_at = ? WHERE id = ?`,
    nowTs(),
    nowTs(),
    id,
  );
  logActivity(req, 'checked in', 'booking', id, `${booking.code} · Room ${segment?.room_number ?? '—'}`);
}

/** Moves a checked-in guest to a different room from `fromDate` onwards. */
export function changeRoom(id: number, newRoomId: number, fromDate: string, rateMinor: number, req: Request): void {
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  if (booking.status !== 'checked_in') throw new ValidationError('Only a checked-in guest can be moved.');

  const room = getRoom(newRoomId);
  if (!room) throw new ValidationError('Please choose a room to move to.');
  if (room.is_out_of_service) throw new ValidationError(`Room ${room.number} is under maintenance.`);

  const segment = currentSegment(id);
  if (!segment) throw new ValidationError('This booking has no room assigned.');
  if (segment.room_id === newRoomId) throw new ValidationError('The guest is already in that room.');
  if (fromDate < segment.from_date) {
    throw new ValidationError(`The move date cannot be before ${segment.from_date}.`);
  }
  if (fromDate >= booking.departure_date) {
    throw new ValidationError('The move date must fall before the departure date.');
  }

  tx(() => {
    const clash = roomConflict(newRoomId, fromDate, booking.departure_date, id);
    if (clash) {
      throw new ValidationError(
        `Room ${room.number} is not free — held by ${clash.code} (${clash.guest_name}) until ${clash.to_date}.`,
      );
    }
    if (fromDate === segment.from_date) {
      // Moved on the same day they took the room: replace the segment outright.
      run('DELETE FROM booking_rooms WHERE id = ?', segment.id);
    } else {
      run('UPDATE booking_rooms SET to_date = ? WHERE id = ?', fromDate, segment.id);
    }
    run(
      `INSERT INTO booking_rooms (booking_id, room_id, from_date, to_date, rate_minor, created_at)
       VALUES (?,?,?,?,?,?)`,
      id,
      newRoomId,
      fromDate,
      booking.departure_date,
      rateMinor,
      nowTs(),
    );
    run('UPDATE bookings SET updated_at = ? WHERE id = ?', nowTs(), id);
    logActivity(
      req,
      'changed room',
      'booking',
      id,
      `${booking.code} · ${segment.room_number} → ${room.number} from ${fromDate}`,
    );
  });
}

export function extendStay(id: number, newDeparture: string, req: Request): void {
  const booking = getBooking(id);
  if (!booking) throw new ValidationError('Booking not found.');
  if (booking.status !== 'checked_in' && booking.status !== 'reserved') {
    throw new ValidationError('Only an active booking can be extended.');
  }
  if (newDeparture <= booking.departure_date) {
    throw new ValidationError(`The new departure date must be after ${booking.departure_date}.`);
  }
  const segment = currentSegment(id);
  if (!segment) throw new ValidationError('This booking has no room assigned.');

  tx(() => {
    const clash = roomConflict(segment.room_id, segment.to_date, newDeparture, id);
    if (clash) {
      throw new ValidationError(
        `Room ${segment.room_number} is booked by ${clash.code} (${clash.guest_name}) from ${clash.from_date}. ` +
          `Move the guest to another room, or extend only to ${clash.from_date}.`,
      );
    }
    run('UPDATE booking_rooms SET to_date = ? WHERE id = ?', newDeparture, segment.id);
    run('UPDATE bookings SET departure_date = ?, updated_at = ? WHERE id = ?', newDeparture, nowTs(), id);
    logActivity(
      req,
      'extended stay',
      'booking',
      id,
      `${booking.code} · ${booking.departure_date} → ${newDeparture}`,
    );
  });
}

/* ----------------------------------------------------------------- charges */

export interface RoomChargeLine {
  room_number: string;
  from_date: string;
  to_date: string;
  nights: number;
  rate_minor: number;
  amount_minor: number;
}

/**
 * Nightly room charges up to `departureDate`, one line per room the guest
 * occupied. Truncating at `departureDate` is what makes early check-out
 * charge the right number of nights.
 */
export function roomChargeLines(bookingId: number, departureDate: string): RoomChargeLine[] {
  const segments = bookingSegments(bookingId);
  const lines: RoomChargeLine[] = [];
  for (const seg of segments) {
    const to = seg.to_date < departureDate ? seg.to_date : departureDate;
    const nights = nightsBetween(seg.from_date, to);
    if (nights <= 0) continue;
    lines.push({
      room_number: seg.room_number,
      from_date: seg.from_date,
      to_date: to,
      nights,
      rate_minor: seg.rate_minor,
      amount_minor: nights * seg.rate_minor,
    });
  }
  // Day-use / same-day departure still costs one night.
  if (lines.length === 0 && segments.length > 0) {
    const first = segments[0]!;
    lines.push({
      room_number: first.room_number,
      from_date: first.from_date,
      to_date: departureDate,
      nights: 1,
      rate_minor: first.rate_minor,
      amount_minor: first.rate_minor,
    });
  }
  return lines;
}

export function roomChargeTotal(bookingId: number, departureDate: string): number {
  return roomChargeLines(bookingId, departureDate).reduce((sum, l) => sum + l.amount_minor, 0);
}

/** Food already charged to the room and not yet settled on an invoice. */
export function pendingRoomFoodTotal(bookingId: number): number {
  return scalar(
    `SELECT COALESCE(SUM(total_minor), 0) FROM orders
      WHERE booking_id = ? AND billing_mode = 'add_to_room'
        AND status IN ('open','served') `,
    bookingId,
  );
}

export function bookingHasOpenOrders(bookingId: number): number {
  return scalar(
    `SELECT COUNT(*) FROM orders WHERE booking_id = ? AND status = 'open'`,
    bookingId,
  );
}

export function guestOf(bookingId: number): Guest | undefined {
  return get<Guest>('SELECT g.* FROM guests g JOIN bookings b ON b.guest_id = g.id WHERE b.id = ?', bookingId);
}

export function markCheckedOut(bookingId: number, departureDate: string): void {
  run(
    `UPDATE bookings SET status = 'checked_out', checked_out_at = ?, departure_date = ?, updated_at = ?
      WHERE id = ?`,
    nowTs(),
    departureDate,
    nowTs(),
    bookingId,
  );
  // Release the room from the moment the guest actually leaves. Segments are
  // truncated rather than deleted so the guest's room history survives, and a
  // zero-length segment holds no nights, so the room frees up immediately.
  run(
    `UPDATE booking_rooms
        SET to_date = CASE WHEN from_date > ? THEN from_date ELSE ? END
      WHERE booking_id = ? AND to_date > ?`,
    departureDate,
    departureDate,
    bookingId,
    departureDate,
  );
}
