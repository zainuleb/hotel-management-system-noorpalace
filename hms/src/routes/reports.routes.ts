import { Router } from 'express';
import { requirePermission } from '../lib/session.js';
import { addDays, isValidDate, today } from '../lib/dates.js';
import { str } from '../lib/validate.js';
import {
  cashBook,
  cashBookSummary,
  dailyReport,
  monthlyReport,
  occupancyBetween,
  roomPerformance,
  taxReport,
  yearlySummary,
  paymentsByMode,
  revenueBetween,
  revenueByDay,
  salesByBillingMode,
  salesByMeal,
  topSellingItems,
} from '../services/reports.service.js';
import { listInvoices } from '../services/billing.service.js';
import { monthRange, toDateString, parseDate } from '../lib/dates.js';
import { can } from '../lib/permissions.js';

const router = Router();

/** Every report shares one date-range control. */
function range(req: { query: Record<string, unknown> }): { from: string; to: string; preset: string } {
  const preset = str(req.query.preset) || (str(req.query.from) ? 'custom' : 'today');
  const now = today();
  if (preset === 'custom' || (str(req.query.from) && str(req.query.to))) {
    const from = isValidDate(str(req.query.from)) ? str(req.query.from) : now;
    const to = isValidDate(str(req.query.to)) ? str(req.query.to) : now;
    return { from: from <= to ? from : to, to: from <= to ? to : from, preset: 'custom' };
  }
  switch (preset) {
    case 'yesterday': {
      const d = addDays(now, -1);
      return { from: d, to: d, preset };
    }
    case 'week':
      return { from: addDays(now, -6), to: now, preset };
    case 'month': {
      const m = monthRange(now);
      return { from: m.start, to: now, preset };
    }
    case 'last30':
      return { from: addDays(now, -29), to: now, preset };
    default:
      return { from: now, to: now, preset: 'today' };
  }
}

/** Index of every report, so nothing is buried three clicks deep. */
router.get('/reports', requirePermission('reports.view'), (req, res) => {
  res.render('pages/reports-hub', { title: 'Reports' });
});

router.get('/reports/sales', requirePermission('reports.view'), (req, res) => {
  const { from, to, preset } = range(req as never);
  res.render('pages/reports', {
    title: 'Reports',
    from,
    to,
    preset,
    summary: revenueBetween(from, to),
    daily: revenueByDay(from, to),
    meals: salesByMeal(from, to),
    billingSplit: salesByBillingMode(from, to),
    modes: paymentsByMode(from, to),
    topItems: topSellingItems(from, to),
    occupancy: occupancyBetween(from, to),
    outstanding: listInvoices({ status: 'outstanding', limit: 500 }),
  });
});

/** Any report table can be pulled into Excel from here. */
router.get('/reports/export.csv', requirePermission('reports.view'), (req, res) => {
  const { from, to } = range(req as never);
  const which = str(req.query.report) || 'daily';

  let header: string[] = [];
  let rows: (string | number)[][] = [];

  switch (which) {
    case 'meals':
      header = ['Meal', 'Orders', 'Items', 'Gross', 'Net'];
      rows = salesByMeal(from, to).map((r) => [r.meal_type, r.orders, r.items, r.gross_minor / 100, r.net_minor / 100]);
      break;
    case 'billing':
      header = ['Billing type', 'Orders', 'Gross', 'Net'];
      rows = salesByBillingMode(from, to).map((r) => [r.billing_mode, r.orders, r.gross_minor / 100, r.net_minor / 100]);
      break;
    case 'occupancy':
      header = ['Date', 'Rooms', 'Occupied', 'Reserved', 'Free', 'Percent'];
      rows = occupancyBetween(from, to).map((r) => [r.day, r.total, r.occupied, r.reserved, r.free, r.percent]);
      break;
    case 'outstanding':
      header = ['Invoice', 'Guest', 'Date', 'Total', 'Paid', 'Balance', 'Status'];
      rows = listInvoices({ status: 'outstanding', limit: 1000 }).map((r) => [
        r.number,
        r.guest_name,
        r.created_at,
        r.total_minor / 100,
        r.paid_minor / 100,
        r.balance_minor / 100,
        r.status,
      ]);
      break;
    case 'rooms':
      header = ['Room', 'Floor', 'Type', 'Nights sold', 'Occupancy %', 'Room revenue', 'Food revenue', 'Total'];
      rows = roomPerformance(from, to).map((r) => [
        r.room_number, r.floor, r.type_name, r.nights_sold, r.occupancy_percent,
        r.room_revenue_minor / 100, r.food_revenue_minor / 100, r.total_revenue_minor / 100,
      ]);
      break;
    case 'cashbook':
      header = ['Date', 'In/Out', 'Reference', 'Description', 'Mode', 'Amount', 'Running balance'];
      rows = cashBook(from, to, str(req.query.mode) || 'all').map((r) => [
        r.entry_date, r.direction, r.reference, r.description, r.mode,
        r.amount_minor / 100, r.running_minor / 100,
      ]);
      break;
    case 'tax':
      header = ['Month', 'Invoices', 'Taxable amount', 'Tax', 'Invoice total'];
      rows = taxReport(from, to).map((r) => [
        r.month, r.invoices, r.taxable_minor / 100, r.tax_minor / 100, r.total_minor / 100,
      ]);
      break;
    case 'yearly': {
      const year = Number(from.slice(0, 4));
      header = ['Month', 'Rooms sold', 'Occupancy %', 'Room revenue', 'Food revenue', 'Total sale', 'Expenses', 'Profit'];
      rows = yearlySummary(year).months.map((r) => [
        r.label, r.rooms_sold, r.occupancy_percent, r.room_minor / 100, r.food_minor / 100,
        r.total_sale_minor / 100, r.expense_minor / 100, r.profit_minor / 100,
      ]);
      break;
    }
    default:
      header = ['Date', 'Room revenue', 'Food revenue', 'Total billed', 'Invoices'];
      rows = revenueByDay(from, to).map((r) => [
        r.day,
        r.room_minor / 100,
        r.food_minor / 100,
        r.total_minor / 100,
        r.invoice_count,
      ]);
  }

  const escape = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${which}-${from}-to-${to}.csv"`);
  // BOM so Excel on Windows opens UTF-8 correctly.
  res.send(`﻿${csv}`);
});

/* =============================== daily sheet ============================== */

/**
 * The paper "Daily Report" the hotel already fills in each evening: which rooms
 * were occupied, what they earned, what the restaurant took, what was spent,
 * and the profit for the day.
 */
router.get('/reports/daily', requirePermission('reports.view'), (req, res) => {
  const date = isValidDate(str(req.query.date)) ? str(req.query.date) : today();
  res.render('pages/report-daily', {
    title: 'Daily Report',
    report: dailyReport(date),
    date,
    prevDate: addDays(date, -1),
    nextDate: addDays(date, 1),
    showMoney: can(req.user?.role, 'reports.pnl'),
  });
});

/* ============================== monthly sheet ============================= */

/** Month picker value ("2026-08") to a first/last day pair. */
function monthBounds(value: string): { from: string; to: string; label: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const anchor = match ? `${value}-01` : today();
  const { start, end } = monthRange(anchor);
  const lastDay = addDays(end, -1);
  const d = parseDate(start);
  const label = d
    ? d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : start.slice(0, 7);
  // Never report past today, so a mid-month view is not diluted by empty days.
  const cappedTo = lastDay > today() && start <= today() ? today() : lastDay;
  return { from: start, to: cappedTo, label };
}

router.get('/reports/monthly', requirePermission('reports.pnl'), (req, res) => {
  const requested = str(req.query.month) || toDateString(new Date()).slice(0, 7);
  const { from, to, label } = monthBounds(requested);
  res.render('pages/report-monthly', {
    title: 'Monthly Report',
    report: monthlyReport(from, to),
    month: requested,
    monthLabel: label,
    from,
    to,
  });
});

/* ============================= room-wise sales ============================ */

router.get('/reports/rooms', requirePermission('reports.view'), (req, res) => {
  const { from, to, preset } = range(req as never);
  const rows = roomPerformance(from, to);
  res.render('pages/report-rooms', {
    title: 'Room-wise Performance',
    from,
    to,
    preset,
    rows,
    totals: {
      nights: rows.reduce((s, r) => s + r.nights_sold, 0),
      room: rows.reduce((s, r) => s + r.room_revenue_minor, 0),
      food: rows.reduce((s, r) => s + r.food_revenue_minor, 0),
      total: rows.reduce((s, r) => s + r.total_revenue_minor, 0),
    },
  });
});

/* ================================ cash book =============================== */

router.get('/reports/cashbook', requirePermission('reports.pnl'), (req, res) => {
  const { from, to, preset } = range(req as never);
  const mode = str(req.query.mode) || 'all';
  const rows = cashBook(from, to, mode);
  res.render('pages/report-cashbook', {
    title: 'Cash Book',
    from,
    to,
    preset,
    mode,
    rows,
    summary: cashBookSummary(rows),
  });
});

/* ================================== tax ================================== */

router.get('/reports/tax', requirePermission('reports.pnl'), (req, res) => {
  const { from, to, preset } = range(req as never);
  const rows = taxReport(from, to);
  res.render('pages/report-tax', {
    title: 'Tax Collected',
    from,
    to,
    preset,
    rows,
    totals: {
      invoices: rows.reduce((s, r) => s + r.invoices, 0),
      taxable: rows.reduce((s, r) => s + r.taxable_minor, 0),
      tax: rows.reduce((s, r) => s + r.tax_minor, 0),
      total: rows.reduce((s, r) => s + r.total_minor, 0),
    },
  });
});

/* ================================= yearly ================================ */

router.get('/reports/yearly', requirePermission('reports.pnl'), (req, res) => {
  const requested = Number.parseInt(str(req.query.year), 10);
  const year = Number.isFinite(requested) && requested > 2000 && requested < 2200
    ? requested
    : Number(today().slice(0, 4));
  const summary = yearlySummary(year);
  res.render('pages/report-yearly', {
    title: `${year} Summary`,
    year,
    months: summary.months,
    totals: summary.totals,
  });
});

export default router;
