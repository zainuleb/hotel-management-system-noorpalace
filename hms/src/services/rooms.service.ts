import { all, get } from '../db/index.js';
import { formatDate } from '../lib/dates.js';
import type { RoomStatus, RoomType, RoomWithType } from '../types/domain.js';

/** Booking states that actually hold a room. */
const HOLDING_STATUSES = `('reserved','checked_in')`;

export function listRoomTypes(includeInactive = false): RoomType[] {
  return all<RoomType>(
    `SELECT * FROM room_types ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY name`,
  );
}

export function getRoomType(id: number): RoomType | undefined {
  return get<RoomType>('SELECT * FROM room_types WHERE id = ?', id);
}

const ROOM_SELECT = `
  SELECT r.*, t.name AS type_name, t.base_rate AS base_rate, t.capacity AS type_capacity
    FROM rooms r JOIN room_types t ON t.id = r.room_type_id`;

export function listRooms(includeInactive = false): RoomWithType[] {
  return all<RoomWithType>(
    `${ROOM_SELECT} ${includeInactive ? '' : 'WHERE r.is_active = 1'}
     ORDER BY r.sort_order, r.number`,
  );
}

export function getRoom(id: number): RoomWithType | undefined {
  return get<RoomWithType>(`${ROOM_SELECT} WHERE r.id = ?`, id);
}

export function getRoomByNumber(number: string): RoomWithType | undefined {
  return get<RoomWithType>(`${ROOM_SELECT} WHERE r.number = ?`, number);
}

export interface OccupancyEntry {
  room_id: number;
  booking_id: number;
  code: string;
  status: 'reserved' | 'checked_in';
  guest_name: string;
  arrival_date: string;
  departure_date: string;
}

/**
 * Which booking (if any) holds each room on `date`. One query for the whole
 * property, so the room grid does not fan out into N queries.
 */
export function occupancyOn(date: string): Map<number, OccupancyEntry> {
  const rows = all<OccupancyEntry>(
    `SELECT br.room_id, b.id AS booking_id, b.code, b.status,
            g.full_name AS guest_name, b.arrival_date, b.departure_date
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id
       JOIN guests   g ON g.id = b.guest_id
      WHERE b.status IN ${HOLDING_STATUSES}
        AND br.from_date <= ? AND br.to_date > ?`,
    date,
    date,
  );
  const map = new Map<number, OccupancyEntry>();
  for (const row of rows) {
    // A checked-in stay always wins over a same-day reservation for the grid.
    const existing = map.get(row.room_id);
    if (!existing || (existing.status === 'reserved' && row.status === 'checked_in')) {
      map.set(row.room_id, row);
    }
  }
  return map;
}

export interface RoomStatusView extends RoomWithType {
  status: RoomStatus;
  occupancy: OccupancyEntry | null;
}

/**
 * Room status is derived from bookings rather than stored, so it can never
 * disagree with the booking list. Only "Under Maintenance" is a stored flag.
 */
export function roomStatusBoard(date: string, includeInactive = false): RoomStatusView[] {
  const rooms = listRooms(includeInactive);
  const occupied = occupancyOn(date);
  return rooms.map((room) => {
    const entry = occupied.get(room.id) ?? null;
    let status: RoomStatus = 'available';
    if (room.is_out_of_service) status = 'maintenance';
    else if (entry?.status === 'checked_in') status = 'occupied';
    else if (entry?.status === 'reserved') status = 'reserved';
    return { ...room, status, occupancy: entry };
  });
}

export function statusCounts(board: RoomStatusView[]): Record<RoomStatus, number> {
  const counts: Record<RoomStatus, number> = { available: 0, occupied: 0, reserved: 0, maintenance: 0 };
  for (const room of board) counts[room.status]++;
  return counts;
}

/**
 * Rooms free for the whole half-open range [from, to).
 * `excludeBookingId` lets an edit ignore the booking's own hold on the room.
 */
export function availableRooms(from: string, to: string, excludeBookingId?: number | null): RoomWithType[] {
  return all<RoomWithType>(
    `${ROOM_SELECT}
      WHERE r.is_active = 1
        AND r.is_out_of_service = 0
        AND NOT EXISTS (
          SELECT 1 FROM booking_rooms br
            JOIN bookings b ON b.id = br.booking_id
           WHERE br.room_id = r.id
             AND b.status IN ${HOLDING_STATUSES}
             AND br.from_date < ?
             AND br.to_date   > ?
             AND (? IS NULL OR b.id <> ?)
        )
      ORDER BY r.sort_order, r.number`,
    to,
    from,
    excludeBookingId ?? null,
    excludeBookingId ?? 0,
  );
}

/** Conflict check for a single room. Returns the clashing booking, if any. */
export function roomConflict(
  roomId: number,
  from: string,
  to: string,
  excludeBookingId?: number | null,
): { code: string; guest_name: string; from_date: string; to_date: string } | undefined {
  return get(
    `SELECT b.code, g.full_name AS guest_name, br.from_date, br.to_date
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id
       JOIN guests   g ON g.id = b.guest_id
      WHERE br.room_id = ?
        AND b.status IN ${HOLDING_STATUSES}
        AND br.from_date < ?
        AND br.to_date   > ?
        AND (? IS NULL OR b.id <> ?)
      LIMIT 1`,
    roomId,
    to,
    from,
    excludeBookingId ?? null,
    excludeBookingId ?? 0,
  );
}

export function isRoomAvailable(
  roomId: number,
  from: string,
  to: string,
  excludeBookingId?: number | null,
): boolean {
  return roomConflict(roomId, from, to, excludeBookingId) === undefined;
}

/** Rooms currently checked in, the valid targets for an "Add to Room" charge. */
export function occupiedRoomsNow(date: string): (RoomWithType & { booking_id: number; guest_name: string; code: string })[] {
  return all(
    `SELECT r.*, t.name AS type_name, t.base_rate AS base_rate, t.capacity AS type_capacity,
            b.id AS booking_id, b.code, g.full_name AS guest_name
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id
       JOIN rooms    r ON r.id = br.room_id
       JOIN room_types t ON t.id = r.room_type_id
       JOIN guests   g ON g.id = b.guest_id
      WHERE b.status = 'checked_in'
        AND br.from_date <= ? AND br.to_date > ?
      ORDER BY r.sort_order, r.number`,
    date,
    date,
  );
}

export interface RoomAvailability extends RoomWithType {
  available: boolean;
  /** Plain-English reason a room cannot be taken, for the booking form. */
  blocked_reason: string;
  held_by_code: string | null;
  held_until: string | null;
}

/**
 * Every room, each marked free or blocked with the reason.
 *
 * The booking form used to simply omit rooms that were taken, which left the
 * receptionist guessing why a room they can see on the board is not in the
 * list. Showing them greyed out with "held by BK-00005 until 10 Aug" answers
 * the question without them having to go and look.
 */
export function roomAvailability(
  from: string,
  to: string,
  excludeBookingId?: number | null,
): RoomAvailability[] {
  const rooms = listRooms();
  const free = new Set(availableRooms(from, to, excludeBookingId).map((r) => r.id));

  return rooms.map((room) => {
    if (free.has(room.id)) {
      return { ...room, available: true, blocked_reason: '', held_by_code: null, held_until: null };
    }
    if (room.is_out_of_service) {
      return {
        ...room,
        available: false,
        blocked_reason: room.maintenance_note ? `under maintenance, ${room.maintenance_note}` : 'under maintenance',
        held_by_code: null,
        held_until: null,
      };
    }
    const clash = roomConflict(room.id, from, to, excludeBookingId);
    return {
      ...room,
      available: false,
      blocked_reason: clash
        ? `taken by ${clash.guest_name} (${clash.code}) until ${formatDate(clash.to_date)}`
        : 'not available for these dates',
      held_by_code: clash?.code ?? null,
      held_until: clash?.to_date ?? null,
    };
  });
}
