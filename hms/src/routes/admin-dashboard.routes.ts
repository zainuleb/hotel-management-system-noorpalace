import { Router } from 'express';
import { scalar } from '../db/index.js';
import { requirePermission } from '../lib/session.js';
import { addDays, isValidDate, monthRange, today } from '../lib/dates.js';
import { str } from '../lib/validate.js';
import { recentActivity } from '../lib/activity.js';
import {
  periodComparison,
  roomPerformance,
  cashBook,
  cashBookSummary,
} from '../services/reports.service.js';
import { listCategories, listExpenses } from '../services/expenses.service.js';
import { listInvoices } from '../services/billing.service.js';
import { listRooms } from '../services/rooms.service.js';

const router = Router();

export interface DashPeriod {
  from: string;
  to: string;
  preset: string;
  label: string;
}

/** Presets the owner actually asks for, rather than an open-ended date box. */
export function dashboardPeriod(query: Record<string, unknown>): DashPeriod {
  const preset = str(query.preset) || 'month';
  const now = today();

  if (preset === 'custom') {
    const from = isValidDate(str(query.from)) ? str(query.from) : now;
    const to = isValidDate(str(query.to)) ? str(query.to) : now;
    return from <= to
      ? { from, to, preset, label: 'Selected dates' }
      : { from: to, to: from, preset, label: 'Selected dates' };
  }
  switch (preset) {
    case 'today':
      return { from: now, to: now, preset, label: 'Today' };
    case 'yesterday': {
      const d = addDays(now, -1);
      return { from: d, to: d, preset, label: 'Yesterday' };
    }
    case 'week':
      return { from: addDays(now, -6), to: now, preset, label: 'Last 7 days' };
    case 'last_month': {
      const thisMonth = monthRange(now);
      const lastDay = addDays(thisMonth.start, -1);
      return { from: monthRange(lastDay).start, to: lastDay, preset, label: 'Last month' };
    }
    case 'year':
      return { from: `${now.slice(0, 4)}-01-01`, to: now, preset, label: 'This year' };
    default:
      return { from: monthRange(now).start, to: now, preset: 'month', label: 'This month' };
  }
}

/**
 * The owner's console: what the business earned, what it spent, what it kept,
 * how that compares with the period before, and the handful of things that
 * need attention today — all on one screen.
 */
router.get('/admin', requirePermission('reports.pnl'), (req, res) => {
  const period = dashboardPeriod(req.query as Record<string, unknown>);
  const comparison = periodComparison(period.from, period.to);
  const cash = cashBook(period.from, period.to);

  const outstanding = listInvoices({ status: 'outstanding', limit: 500 });
  const rooms = listRooms();

  res.render('pages/admin-dashboard', {
    title: 'Admin Dashboard',
    period,
    cmp: comparison,
    pnl: comparison.current,
    cash: cashBookSummary(cash),
    rooms: roomPerformance(period.from, period.to).slice(0, 8),
    recentExpenses: listExpenses({ from: period.from, to: period.to, limit: 8 }),
    categories: listCategories(),
    outstandingTotal: outstanding.reduce((s, i) => s + i.balance_minor, 0),
    outstandingCount: outstanding.length,
    attention: {
      unbilled_room_food_minor: scalar(
        `SELECT COALESCE(SUM(total_minor),0) FROM orders
          WHERE billing_mode = 'add_to_room' AND status IN ('open','served')`,
      ),
      open_orders: scalar(`SELECT COUNT(*) FROM orders WHERE status = 'open'`),
      in_house: scalar(`SELECT COUNT(*) FROM bookings WHERE status = 'checked_in'`),
      arrivals_today: scalar(
        `SELECT COUNT(*) FROM bookings WHERE arrival_date = ? AND status = 'reserved'`,
        today(),
      ),
      departures_today: scalar(
        `SELECT COUNT(*) FROM bookings WHERE departure_date = ? AND status = 'checked_in'`,
        today(),
      ),
      rooms_maintenance: rooms.filter((r) => r.is_out_of_service).length,
      rooms_without_rate: rooms.filter((r) => !r.base_rate).length,
      staff: scalar(`SELECT COUNT(*) FROM users WHERE is_active = 1`),
    },
    activity: recentActivity(12),
  });
});

export default router;
