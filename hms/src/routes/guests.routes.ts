import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { requirePermission } from '../lib/session.js';
import { logActivity } from '../lib/activity.js';
import { positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import { searchGuests } from '../services/bookings.service.js';
import type { Guest } from '../types/domain.js';

const router = Router();

router.get('/guests', requirePermission('guests.view'), (req, res) => {
  const q = str(req.query.q);
  const guests = q
    ? searchGuests(q, 200)
    : all<Guest>('SELECT * FROM guests ORDER BY id DESC LIMIT 200');
  res.render('pages/guests', { title: 'Guests', guests, q });
});

/** Type-ahead used by the booking form to reuse an existing guest record. */
router.get('/guests/search.json', requirePermission('guests.view'), (req, res) => {
  const q = str(req.query.q);
  res.json(q.length < 2 ? [] : searchGuests(q, 10));
});

router.get('/guests/:id', requirePermission('guests.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Guest');
  const guest = get<Guest>('SELECT * FROM guests WHERE id = ?', id);
  if (!guest) throw new ValidationError('Guest not found.');

  const stays = all(
    `SELECT b.*, (SELECT GROUP_CONCAT(r.number, ', ') FROM booking_rooms br
                    JOIN rooms r ON r.id = br.room_id WHERE br.booking_id = b.id) AS room_numbers
       FROM bookings b WHERE b.guest_id = ? ORDER BY b.arrival_date DESC`,
    id,
  );
  const invoices = all(
    `SELECT i.*, COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.invoice_id = i.id),0) AS paid_minor
       FROM invoices i JOIN bookings b ON b.id = i.booking_id
      WHERE b.guest_id = ? ORDER BY i.id DESC`,
    id,
  );

  res.render('pages/guest-detail', { title: guest.full_name, guest, stays, invoices });
});

router.post('/guests/:id', requirePermission('guests.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'Guest');
  const body = req.body as Record<string, unknown>;
  const fullName = requiredStr(body.full_name, 'Guest name', 120);
  run(
    `UPDATE guests SET full_name = ?, id_number = ?, phone = ?, email = ?, address = ?, nationality = ?, notes = ?
      WHERE id = ?`,
    fullName,
    str(body.id_number),
    str(body.phone),
    str(body.email),
    str(body.address),
    str(body.nationality),
    str(body.notes),
    id,
  );
  logActivity(req, 'updated guest', 'guest', id, fullName);
  req.flash('success', 'Guest details saved.');
  res.redirect(`/guests/${id}`);
});

export default router;
