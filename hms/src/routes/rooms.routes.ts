import { Router } from 'express';
import { run } from '../db/index.js';
import { requirePermission } from '../lib/session.js';
import { addDays, isValidDate, today } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { logActivity } from '../lib/activity.js';
import { bool, int, positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import {
  availableRooms,
  getRoom,
  getRoomType,
  listRoomTypes,
  listRooms,
  roomStatusBoard,
  statusCounts,
} from '../services/rooms.service.js';
import { scalar } from '../db/index.js';
import { unbilledFoodByRoom } from '../services/orders.service.js';

const router = Router();

/* --------------------------------------------------------- status board */

router.get('/rooms', requirePermission('rooms.view'), (req, res) => {
  const date = isValidDate(str(req.query.date)) ? str(req.query.date) : today();
  const board = roomStatusBoard(date, true);
  const tabs = unbilledFoodByRoom();
  res.render('pages/rooms-board', {
    title: 'Room Status',
    date,
    board: board.map((room) => ({ ...room, food_tab: tabs.get(room.id) ?? null })),
    counts: statusCounts(board),
    prevDate: addDays(date, -1),
    nextDate: addDays(date, 1),
  });
});

/* --------------------------------------------------------- availability */

router.get('/rooms/availability', requirePermission('rooms.view'), (req, res) => {
  const from = isValidDate(str(req.query.from)) ? str(req.query.from) : today();
  const rawTo = str(req.query.to);
  const to = isValidDate(rawTo) && rawTo > from ? rawTo : addDays(from, 1);
  const typeId = int(req.query.room_type_id, 0);

  let rooms = availableRooms(from, to);
  if (typeId) rooms = rooms.filter((r) => r.room_type_id === typeId);

  res.render('pages/rooms-availability', {
    title: 'Room Availability',
    from,
    to,
    typeId,
    rooms,
    roomTypes: listRoomTypes(),
  });
});

/* ------------------------------------------------------------- manage */

router.get('/rooms/manage', requirePermission('rooms.manage'), (_req, res) => {
  res.render('pages/rooms-manage', {
    title: 'Rooms & Room Types',
    rooms: listRooms(true),
    roomTypes: listRoomTypes(true),
  });
});

router.post('/rooms/types', requirePermission('rooms.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const id = int(body.id, 0);
  const name = requiredStr(body.name, 'Room type name', 60);
  const rate = toMinor(body.base_rate);
  const capacity = Math.max(1, int(body.capacity, 2));
  const description = str(body.description);
  const active = bool(body.is_active);

  if (id) {
    run(
      'UPDATE room_types SET name = ?, base_rate = ?, capacity = ?, description = ?, is_active = ? WHERE id = ?',
      name,
      rate,
      capacity,
      description,
      active,
      id,
    );
    logActivity(req, 'updated room type', 'room_type', id, name);
    req.flash('success', `Room type "${name}" updated.`);
  } else {
    const created = run(
      'INSERT INTO room_types (name, base_rate, capacity, description, is_active) VALUES (?,?,?,?,?)',
      name,
      rate,
      capacity,
      description,
      1,
    );
    logActivity(req, 'created room type', 'room_type', created.lastInsertRowid, name);
    req.flash('success', `Room type "${name}" added.`);
  }
  res.redirect('/rooms/manage');
});

router.post('/rooms/types/:id/delete', requirePermission('rooms.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'Room type');
  const type = getRoomType(id);
  if (!type) throw new ValidationError('Room type not found.');
  const inUse = scalar('SELECT COUNT(*) FROM rooms WHERE room_type_id = ?', id);
  if (inUse) {
    throw new ValidationError(
      `${type.name} is used by ${inUse} room(s). Move those rooms to another type first, or just mark this type inactive.`,
    );
  }
  run('DELETE FROM room_types WHERE id = ?', id);
  logActivity(req, 'deleted room type', 'room_type', id, type.name);
  req.flash('success', `Room type "${type.name}" deleted.`);
  res.redirect('/rooms/manage');
});

router.post('/rooms', requirePermission('rooms.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const id = int(body.id, 0);
  const number = requiredStr(body.number, 'Room number', 20);
  const roomTypeId = positiveInt(body.room_type_id, 'Room type');
  const floor = str(body.floor);
  const capacity = int(body.capacity, 0);
  const amenities = str(body.amenities);
  const active = bool(body.is_active);

  const duplicate = scalar('SELECT COUNT(*) FROM rooms WHERE number = ? AND id <> ?', number, id);
  if (duplicate) throw new ValidationError(`Room ${number} already exists.`);

  if (id) {
    run(
      `UPDATE rooms SET number = ?, room_type_id = ?, floor = ?, capacity = ?, amenities = ?, is_active = ?
        WHERE id = ?`,
      number,
      roomTypeId,
      floor,
      capacity,
      amenities,
      active,
      id,
    );
    logActivity(req, 'updated room', 'room', id, `Room ${number}`);
    req.flash('success', `Room ${number} updated.`);
  } else {
    const created = run(
      `INSERT INTO rooms (number, room_type_id, floor, capacity, amenities, is_active, sort_order)
       VALUES (?,?,?,?,?,1,?)`,
      number,
      roomTypeId,
      floor,
      capacity,
      amenities,
      scalar('SELECT COALESCE(MAX(sort_order),0) + 1 FROM rooms'),
    );
    logActivity(req, 'created room', 'room', created.lastInsertRowid, `Room ${number}`);
    req.flash('success', `Room ${number} added.`);
  }
  res.redirect('/rooms/manage');
});

/**
 * Adds a whole floor at once. Accepts `101-108`, `101,102,105`, or a mix.
 * which is how a room list actually gets written down.
 */
router.post('/rooms/bulk', requirePermission('rooms.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const spec = requiredStr(body.numbers, 'Room numbers', 500);
  const roomTypeId = positiveInt(body.room_type_id, 'Room type');
  const floor = str(body.floor);
  const amenities = str(body.amenities);

  const numbers: string[] = [];
  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from > 500) {
        throw new ValidationError(`"${piece}" is not a usable range.`);
      }
      for (let n = from; n <= to; n++) numbers.push(String(n));
    } else {
      numbers.push(piece);
    }
  }
  if (!numbers.length) throw new ValidationError('Give at least one room number.');

  const added: string[] = [];
  const skipped: string[] = [];
  let order = scalar('SELECT COALESCE(MAX(sort_order),0) FROM rooms');

  for (const number of numbers) {
    if (scalar('SELECT COUNT(*) FROM rooms WHERE number = ?', number)) {
      skipped.push(number);
      continue;
    }
    run(
      `INSERT INTO rooms (number, room_type_id, floor, amenities, is_active, sort_order)
       VALUES (?,?,?,?,1,?)`,
      number,
      roomTypeId,
      floor,
      amenities,
      ++order,
    );
    added.push(number);
  }

  logActivity(req, 'added rooms in bulk', 'room', 0, `${added.length} room(s): ${added.join(', ')}`);
  req.flash(
    'success',
    `${added.length} room(s) added.` +
      (skipped.length ? ` Skipped ${skipped.length} that already existed: ${skipped.join(', ')}.` : ''),
  );
  res.redirect('/rooms/manage');
});

router.post('/rooms/:id/maintenance', requirePermission('rooms.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'Room');
  const room = getRoom(id);
  if (!room) throw new ValidationError('Room not found.');
  const body = req.body as Record<string, unknown>;
  const outOfService = bool(body.is_out_of_service);
  const note = str(body.maintenance_note);

  if (outOfService) {
    const held = scalar(
      `SELECT COUNT(*) FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
        WHERE br.room_id = ? AND b.status = 'checked_in' AND br.from_date <= ? AND br.to_date > ?`,
      id,
      today(),
      today(),
    );
    if (held) {
      throw new ValidationError(`Room ${room.number} has a guest in it right now. Check them out or move them first.`);
    }
  }

  run('UPDATE rooms SET is_out_of_service = ?, maintenance_note = ? WHERE id = ?', outOfService, note, id);
  logActivity(
    req,
    outOfService ? 'marked room under maintenance' : 'returned room to service',
    'room',
    id,
    `Room ${room.number}${note ? ` · ${note}` : ''}`,
  );
  req.flash('success', `Room ${room.number} ${outOfService ? 'marked under maintenance' : 'returned to service'}.`);
  res.redirect(req.get('referer') ?? '/rooms/manage');
});

export default router;
