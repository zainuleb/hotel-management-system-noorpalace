import { Router } from 'express';
import { requirePermission } from '../lib/session.js';
import { today, isValidDate } from '../lib/dates.js';
import { str } from '../lib/validate.js';
import { arrivalsOn, dashboard, departuresOn, inHouseGuests, profitAndLoss } from '../services/reports.service.js';
import { roomStatusBoard, statusCounts } from '../services/rooms.service.js';
import { kitchenQueue } from '../services/orders.service.js';
import { can } from '../lib/permissions.js';

const router = Router();

router.get('/', requirePermission('dashboard.view'), (req, res) => {
  const date = isValidDate(str(req.query.date)) ? str(req.query.date) : today();
  const board = roomStatusBoard(date);

  res.render('pages/dashboard', {
    title: 'Dashboard',
    date,
    data: dashboard(date),
    board,
    counts: statusCounts(board),
    arrivals: arrivalsOn(date),
    departures: departuresOn(date),
    inHouse: inHouseGuests().slice(0, 12),
    kitchen: can(req.user?.role, 'orders.view') ? kitchenQueue().slice(0, 10) : [],
    // Owners and accountants also see today's bottom line; front desk does not.
    pnl: can(req.user?.role, 'reports.pnl') ? profitAndLoss(date, date) : null,
  });
});

export default router;
