import { all, scalar } from '../db/index.js';
import { addDays, nightsBetween, today } from '../lib/dates.js';
import { listRooms, occupancyOn } from './rooms.service.js';
import {
  expensesByDay,
  listExpenses,
  totalsByCategory,
  type CategoryTotal,
} from './expenses.service.js';

/**
 * Revenue is measured two ways on purpose:
 *  - "billed"  , what appears on invoices raised in the period (accrual).
 *  - "collected"what money actually came in (cash view).
 * A hotel needs both: the first reconciles against the guest ledger, the second
 * against the cash drawer.
 */

export interface RevenueSummary {
  room_minor: number;
  food_minor: number;
  discount_minor: number;
  tax_minor: number;
  billed_minor: number;
  collected_minor: number;
  invoice_count: number;
}

export function revenueBetween(from: string, to: string): RevenueSummary {
  const row = all<{
    room: number; food: number; discount: number; tax: number; total: number; n: number;
  }>(
    `SELECT COALESCE(SUM(room_charges_minor),0) AS room,
            COALESCE(SUM(food_charges_minor),0) AS food,
            COALESCE(SUM(discount_minor),0)     AS discount,
            COALESCE(SUM(tax_minor),0)          AS tax,
            COALESCE(SUM(total_minor),0)        AS total,
            COUNT(*)                            AS n
       FROM invoices
      WHERE status <> 'void' AND DATE(created_at) BETWEEN ? AND ?`,
    from,
    to,
  )[0]!;

  const collected = scalar(
    `SELECT COALESCE(SUM(p.amount_minor),0)
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.status <> 'void' AND DATE(p.created_at) BETWEEN ? AND ?`,
    from,
    to,
  );

  return {
    room_minor: row.room,
    food_minor: row.food,
    discount_minor: row.discount,
    tax_minor: row.tax,
    billed_minor: row.total,
    collected_minor: collected,
    invoice_count: row.n,
  };
}

export interface DailyRevenueRow {
  day: string;
  room_minor: number;
  food_minor: number;
  total_minor: number;
  invoice_count: number;
}

export function revenueByDay(from: string, to: string): DailyRevenueRow[] {
  return all<DailyRevenueRow>(
    `SELECT DATE(created_at) AS day,
            COALESCE(SUM(room_charges_minor),0) AS room_minor,
            COALESCE(SUM(food_charges_minor),0) AS food_minor,
            COALESCE(SUM(total_minor),0)        AS total_minor,
            COUNT(*)                            AS invoice_count
       FROM invoices
      WHERE status <> 'void' AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY day`,
    from,
    to,
  );
}

export interface PaymentModeRow {
  mode: string;
  amount_minor: number;
  count: number;
}

export function paymentsByMode(from: string, to: string): PaymentModeRow[] {
  return all<PaymentModeRow>(
    `SELECT p.mode AS mode, COALESCE(SUM(p.amount_minor),0) AS amount_minor, COUNT(*) AS count
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.status <> 'void' AND DATE(p.created_at) BETWEEN ? AND ?
      GROUP BY p.mode ORDER BY amount_minor DESC`,
    from,
    to,
  );
}

/* ------------------------------------------------------------ food reports */

export interface MealSalesRow {
  meal_type: string;
  orders: number;
  items: number;
  gross_minor: number;
  net_minor: number;
}

/**
 * Meal-wise sales: Breakfast vs Lunch vs Dinner.
 *
 * Order money and item counts are fetched separately, joining order_items to
 * aggregate both at once would multiply each order total by its line count.
 */
export function salesByMeal(from: string, to: string): MealSalesRow[] {
  const money = all<{ meal_type: string; orders: number; gross_minor: number; net_minor: number }>(
    `SELECT meal_type,
            COUNT(*) AS orders,
            COALESCE(SUM(subtotal_minor),0) AS gross_minor,
            COALESCE(SUM(total_minor),0)    AS net_minor
       FROM orders
      WHERE status <> 'cancelled' AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY meal_type`,
    from,
    to,
  );
  const counts = all<{ meal_type: string; items: number }>(
    `SELECT o.meal_type, COALESCE(SUM(oi.qty),0) AS items
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status <> 'cancelled' AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY o.meal_type`,
    from,
    to,
  );
  const itemsByMeal = new Map(counts.map((c) => [c.meal_type, c.items]));
  const rank: Record<string, number> = { breakfast: 1, lunch: 2, dinner: 3 };
  return money
    .map((row) => ({ ...row, items: itemsByMeal.get(row.meal_type) ?? 0 }))
    .sort((a, b) => (rank[a.meal_type] ?? 9) - (rank[b.meal_type] ?? 9));
}

export interface BillingSplitRow {
  billing_mode: string;
  orders: number;
  gross_minor: number;
  net_minor: number;
}

/**
 * Food split by how it was billed. This is the reconciliation report the
 * proposal calls out: room-linked revenue lands on guest invoices at check-out,
 * cash-now revenue should already be in the drawer.
 */
export function salesByBillingMode(from: string, to: string): BillingSplitRow[] {
  return all<BillingSplitRow>(
    `SELECT billing_mode,
            COUNT(*) AS orders,
            COALESCE(SUM(subtotal_minor),0) AS gross_minor,
            COALESCE(SUM(total_minor),0)    AS net_minor
       FROM orders
      WHERE status <> 'cancelled' AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY billing_mode
      ORDER BY net_minor DESC`,
    from,
    to,
  );
}

export interface TopItemRow {
  name_snapshot: string;
  qty: number;
  amount_minor: number;
}

export function topSellingItems(from: string, to: string, limit = 15): TopItemRow[] {
  return all<TopItemRow>(
    `SELECT oi.name_snapshot, SUM(oi.qty) AS qty, SUM(oi.line_minor) AS amount_minor
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status <> 'cancelled' AND DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY oi.name_snapshot
      ORDER BY qty DESC LIMIT ?`,
    from,
    to,
    limit,
  );
}

/* ------------------------------------------------------------- occupancy */

export interface OccupancyRow {
  day: string;
  total: number;
  occupied: number;
  reserved: number;
  free: number;
  percent: number;
}

export function occupancyBetween(from: string, to: string): OccupancyRow[] {
  const rooms = listRooms();
  const total = rooms.length;
  const rows: OccupancyRow[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 400) {
    const map = occupancyOn(cursor);
    let occupied = 0;
    let reserved = 0;
    for (const entry of map.values()) {
      if (entry.status === 'checked_in') occupied++;
      else reserved++;
    }
    rows.push({
      day: cursor,
      total,
      occupied,
      reserved,
      free: Math.max(0, total - occupied - reserved),
      percent: total ? Math.round(((occupied + reserved) / total) * 100) : 0,
    });
    cursor = addDays(cursor, 1);
  }
  return rows;
}

/* ------------------------------------------------------------- dashboard */

export interface DashboardData {
  date: string;
  arrivals_today: number;
  departures_today: number;
  in_house: number;
  rooms_total: number;
  rooms_occupied: number;
  rooms_reserved: number;
  rooms_free: number;
  rooms_maintenance: number;
  occupancy_percent: number;
  revenue_today: RevenueSummary;
  outstanding_minor: number;
  outstanding_count: number;
  open_orders: number;
  unbilled_room_food_minor: number;
}

export function dashboard(date = today()): DashboardData {
  const rooms = listRooms();
  const map = occupancyOn(date);
  let occupied = 0;
  let reserved = 0;
  for (const entry of map.values()) {
    if (entry.status === 'checked_in') occupied++;
    else reserved++;
  }
  const maintenance = rooms.filter((r) => r.is_out_of_service).length;
  const total = rooms.length;

  return {
    date,
    arrivals_today: scalar(
      `SELECT COUNT(*) FROM bookings WHERE arrival_date = ? AND status IN ('reserved','checked_in')`,
      date,
    ),
    departures_today: scalar(
      `SELECT COUNT(*) FROM bookings WHERE departure_date = ? AND status IN ('checked_in','checked_out')`,
      date,
    ),
    in_house: scalar(`SELECT COUNT(*) FROM bookings WHERE status = 'checked_in'`),
    rooms_total: total,
    rooms_occupied: occupied,
    rooms_reserved: reserved,
    rooms_free: Math.max(0, total - occupied - reserved - maintenance),
    rooms_maintenance: maintenance,
    occupancy_percent: total ? Math.round((occupied / total) * 100) : 0,
    revenue_today: revenueBetween(date, date),
    outstanding_minor: scalar(
      `SELECT COALESCE(SUM(i.total_minor - COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.invoice_id = i.id),0)),0)
         FROM invoices i WHERE i.status IN ('unpaid','partial')`,
    ),
    outstanding_count: scalar(`SELECT COUNT(*) FROM invoices WHERE status IN ('unpaid','partial')`),
    open_orders: scalar(`SELECT COUNT(*) FROM orders WHERE status = 'open'`),
    unbilled_room_food_minor: scalar(
      `SELECT COALESCE(SUM(total_minor),0) FROM orders
        WHERE billing_mode = 'add_to_room' AND status IN ('open','served')`,
    ),
  };
}

export interface ArrivalRow {
  id: number;
  code: string;
  guest_name: string;
  phone: string;
  room_numbers: string | null;
  arrival_date: string;
  departure_date: string;
  status: string;
  nights: number;
}

function arrivalQuery(field: 'arrival_date' | 'departure_date', date: string, statuses: string): ArrivalRow[] {
  return all<ArrivalRow>(
    `SELECT b.id, b.code, g.full_name AS guest_name, g.phone, b.arrival_date, b.departure_date, b.status,
            (SELECT GROUP_CONCAT(r.number, ', ') FROM booking_rooms br JOIN rooms r ON r.id = br.room_id
              WHERE br.booking_id = b.id) AS room_numbers
       FROM bookings b JOIN guests g ON g.id = b.guest_id
      WHERE b.${field} = ? AND b.status IN ${statuses}
      ORDER BY b.id`,
    date,
  ).map((r) => ({ ...r, nights: Math.max(1, nightsBetween(r.arrival_date, r.departure_date)) }));
}

export function arrivalsOn(date: string): ArrivalRow[] {
  return arrivalQuery('arrival_date', date, `('reserved','checked_in')`);
}

export function departuresOn(date: string): ArrivalRow[] {
  return arrivalQuery('departure_date', date, `('checked_in','checked_out')`);
}

export function inHouseGuests(): ArrivalRow[] {
  return all<ArrivalRow>(
    `SELECT b.id, b.code, g.full_name AS guest_name, g.phone, b.arrival_date, b.departure_date, b.status,
            (SELECT GROUP_CONCAT(r.number, ', ') FROM booking_rooms br JOIN rooms r ON r.id = br.room_id
              WHERE br.booking_id = b.id) AS room_numbers
       FROM bookings b JOIN guests g ON g.id = b.guest_id
      WHERE b.status = 'checked_in'
      ORDER BY b.departure_date, b.id`,
  ).map((r) => ({ ...r, nights: Math.max(1, nightsBetween(r.arrival_date, r.departure_date)) }));
}

/* ==========================================================================
   Daily and monthly profit & loss
   --------------------------------------------------------------------------
   These reports use *accrued* revenue, not invoiced revenue: a room occupied
   on the 5th is the 5th's income even though the guest checks out and pays on
   the 8th. That is what the hotel's own daily sheet counts, and it is the only
   way a day's income can be compared against that day's expenses.

   Everything here is excluding tax. Tax collected on behalf of the government
   is not the hotel's income, so including it would overstate profit.
   ========================================================================== */

/** Booking states where the guest actually slept in the room that night. */
const STAYED = `('checked_in','checked_out')`;

export interface RoomNightRow {
  day: string;
  rooms_occupied: number;
  amount_minor: number;
}

/**
 * Room rent earned per night. Uses a date series so days with no occupancy
 * still appear as zero rather than silently vanishing from the report.
 */
export function roomAccrualByDay(from: string, to: string): RoomNightRow[] {
  return all<RoomNightRow>(
    `WITH RECURSIVE days(d) AS (
       SELECT ?
       UNION ALL
       SELECT date(d, '+1 day') FROM days WHERE d < ?
     )
     SELECT days.d AS day,
            COALESCE(SUM(CASE WHEN b.status IN ${STAYED} THEN 1 ELSE 0 END), 0)             AS rooms_occupied,
            COALESCE(SUM(CASE WHEN b.status IN ${STAYED} THEN br.rate_minor ELSE 0 END), 0) AS amount_minor
       FROM days
       LEFT JOIN booking_rooms br ON br.from_date <= days.d AND br.to_date > days.d
       LEFT JOIN bookings b       ON b.id = br.booking_id
      GROUP BY days.d
      ORDER BY days.d`,
    from,
    to,
  );
}

export function roomAccrualBetween(from: string, to: string): { rooms_sold: number; amount_minor: number } {
  const rows = roomAccrualByDay(from, to);
  return {
    rooms_sold: rows.reduce((s, r) => s + r.rooms_occupied, 0),
    amount_minor: rows.reduce((s, r) => s + r.amount_minor, 0),
  };
}

export interface OccupiedRoomRow {
  room_number: string;
  floor: string;
  guest_name: string;
  booking_id: number;
  code: string;
  rate_minor: number;
  arrival_date: string;
  departure_date: string;
}

/** The "rooms occupied" list at the top of the daily sheet. */
export function occupiedRoomsOn(date: string): OccupiedRoomRow[] {
  return all<OccupiedRoomRow>(
    `SELECT r.number AS room_number, r.floor, g.full_name AS guest_name,
            b.id AS booking_id, b.code, br.rate_minor, b.arrival_date, b.departure_date
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id
       JOIN rooms    r ON r.id = br.room_id
       JOIN guests   g ON g.id = b.guest_id
      WHERE b.status IN ${STAYED}
        AND br.from_date <= ? AND br.to_date > ?
      ORDER BY r.sort_order, r.number`,
    date,
    date,
  );
}

export interface FoodSalesRow {
  day: string;
  add_to_room_minor: number;
  cash_now_minor: number;
  complimentary_minor: number;
  amount_minor: number;
  orders: number;
}

export function foodSalesByDay(from: string, to: string): FoodSalesRow[] {
  return all<FoodSalesRow>(
    `WITH RECURSIVE days(d) AS (
       SELECT ?
       UNION ALL
       SELECT date(d, '+1 day') FROM days WHERE d < ?
     )
     SELECT days.d AS day,
            COALESCE(SUM(CASE WHEN o.billing_mode = 'add_to_room'   THEN o.total_minor    ELSE 0 END), 0) AS add_to_room_minor,
            COALESCE(SUM(CASE WHEN o.billing_mode = 'cash_now'      THEN o.total_minor    ELSE 0 END), 0) AS cash_now_minor,
            COALESCE(SUM(CASE WHEN o.billing_mode = 'complimentary' THEN o.subtotal_minor ELSE 0 END), 0) AS complimentary_minor,
            COALESCE(SUM(o.total_minor), 0) AS amount_minor,
            COUNT(o.id) AS orders
       FROM days
       LEFT JOIN orders o ON DATE(o.created_at) = days.d AND o.status <> 'cancelled'
      GROUP BY days.d
      ORDER BY days.d`,
    from,
    to,
  );
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  room_revenue_minor: number;
  rooms_sold: number;
  food_revenue_minor: number;
  food_add_to_room_minor: number;
  food_cash_now_minor: number;
  complimentary_minor: number;
  other_income_minor: number;
  total_sale_minor: number;
  expense_total_minor: number;
  expenses_by_category: CategoryTotal[];
  income_by_category: CategoryTotal[];
  profit_minor: number;
  /** Cash actually received in the period, for reconciling against the drawer. */
  collected_minor: number;
  rooms_available: number;
  room_nights_available: number;
  occupancy_percent: number;
  average_rate_minor: number;
}

/** The engine behind both the daily and the monthly report. */
export function profitAndLoss(from: string, to: string): ProfitAndLoss {
  const rooms = roomAccrualBetween(from, to);
  const food = foodSalesByDay(from, to);
  const foodTotals = food.reduce(
    (acc, row) => ({
      total: acc.total + row.amount_minor,
      addToRoom: acc.addToRoom + row.add_to_room_minor,
      cashNow: acc.cashNow + row.cash_now_minor,
      comp: acc.comp + row.complimentary_minor,
    }),
    { total: 0, addToRoom: 0, cashNow: 0, comp: 0 },
  );

  const categories = totalsByCategory(from, to);
  const expenseCategories = categories.filter((c) => c.kind === 'expense');
  const incomeCategories = categories.filter((c) => c.kind === 'income');
  const expenseTotal = expenseCategories.reduce((s, c) => s + c.amount_minor, 0);
  const otherIncome = incomeCategories.reduce((s, c) => s + c.amount_minor, 0);

  const totalSale = rooms.amount_minor + foodTotals.total + otherIncome;
  const roomsAvailable = listRooms().filter((r) => !r.is_out_of_service).length;
  const nights = Math.max(1, roomAccrualByDay(from, to).length);
  const roomNightsAvailable = roomsAvailable * nights;

  return {
    from,
    to,
    room_revenue_minor: rooms.amount_minor,
    rooms_sold: rooms.rooms_sold,
    food_revenue_minor: foodTotals.total,
    food_add_to_room_minor: foodTotals.addToRoom,
    food_cash_now_minor: foodTotals.cashNow,
    complimentary_minor: foodTotals.comp,
    other_income_minor: otherIncome,
    total_sale_minor: totalSale,
    expense_total_minor: expenseTotal,
    expenses_by_category: expenseCategories,
    income_by_category: incomeCategories,
    profit_minor: totalSale - expenseTotal,
    collected_minor: scalar(
      `SELECT COALESCE(SUM(p.amount_minor),0)
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE i.status <> 'void' AND DATE(p.created_at) BETWEEN ? AND ?`,
      from,
      to,
    ),
    rooms_available: roomsAvailable,
    room_nights_available: roomNightsAvailable,
    occupancy_percent: roomNightsAvailable ? Math.round((rooms.rooms_sold / roomNightsAvailable) * 100) : 0,
    average_rate_minor: rooms.rooms_sold ? Math.round(rooms.amount_minor / rooms.rooms_sold) : 0,
  };
}

export interface DailyReport extends ProfitAndLoss {
  date: string;
  occupied_rooms: OccupiedRoomRow[];
  food: FoodSalesRow;
  expenses: import('./expenses.service.js').ExpenseRow[];
  arrivals: ArrivalRow[];
  departures: ArrivalRow[];
}

export function dailyReport(date: string): DailyReport {
  const pnl = profitAndLoss(date, date);
  const food = foodSalesByDay(date, date)[0] ?? {
    day: date, add_to_room_minor: 0, cash_now_minor: 0, complimentary_minor: 0, amount_minor: 0, orders: 0,
  };
  return {
    ...pnl,
    date,
    occupied_rooms: occupiedRoomsOn(date),
    food,
    expenses: listExpenses({ from: date, to: date, limit: 200 }),
    arrivals: arrivalsOn(date),
    departures: departuresOn(date),
  };
}

export interface MonthlyReport extends ProfitAndLoss {
  month: string;
  days: {
    day: string;
    rooms_occupied: number;
    room_minor: number;
    food_minor: number;
    expense_minor: number;
    profit_minor: number;
  }[];
}

export function monthlyReport(from: string, to: string): MonthlyReport {
  const pnl = profitAndLoss(from, to);
  const roomRows = roomAccrualByDay(from, to);
  const foodRows = new Map(foodSalesByDay(from, to).map((r) => [r.day, r]));
  const expenseRows = new Map(expensesByDay(from, to).map((r) => [r.day, r.amount_minor]));

  return {
    ...pnl,
    month: from.slice(0, 7),
    days: roomRows.map((r) => {
      const foodMinor = foodRows.get(r.day)?.amount_minor ?? 0;
      const expenseMinor = expenseRows.get(r.day) ?? 0;
      return {
        day: r.day,
        rooms_occupied: r.rooms_occupied,
        room_minor: r.amount_minor,
        food_minor: foodMinor,
        expense_minor: expenseMinor,
        profit_minor: r.amount_minor + foodMinor - expenseMinor,
      };
    }),
  };
}

/* ==========================================================================
   Reporting suite
   ========================================================================== */

export interface PeriodComparison {
  current: ProfitAndLoss;
  previous: ProfitAndLoss;
  previous_from: string;
  previous_to: string;
  /** Percentage change, or null when the previous period was zero. */
  change: {
    total_sale: number | null;
    room_revenue: number | null;
    food_revenue: number | null;
    expenses: number | null;
    profit: number | null;
    occupancy: number | null;
  };
}

function percentChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / Math.abs(before)) * 100);
}

/**
 * The same figures against the equivalent run of days immediately before, so
 * the owner sees direction and not just a number.
 */
export function periodComparison(from: string, to: string): PeriodComparison {
  const days = Math.max(1, nightsBetween(from, to) + 1);
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));

  const current = profitAndLoss(from, to);
  const previous = profitAndLoss(previousFrom, previousTo);

  return {
    current,
    previous,
    previous_from: previousFrom,
    previous_to: previousTo,
    change: {
      total_sale: percentChange(current.total_sale_minor, previous.total_sale_minor),
      room_revenue: percentChange(current.room_revenue_minor, previous.room_revenue_minor),
      food_revenue: percentChange(current.food_revenue_minor, previous.food_revenue_minor),
      expenses: percentChange(current.expense_total_minor, previous.expense_total_minor),
      profit: percentChange(current.profit_minor, previous.profit_minor),
      occupancy: percentChange(current.occupancy_percent, previous.occupancy_percent),
    },
  };
}

/* --------------------------------------------------------- room-wise sales */

export interface RoomPerformanceRow {
  room_id: number;
  room_number: string;
  floor: string;
  type_name: string;
  nights_sold: number;
  room_revenue_minor: number;
  food_revenue_minor: number;
  total_revenue_minor: number;
  occupancy_percent: number;
  average_rate_minor: number;
}

/**
 * Which rooms actually earn. Food is attributed to the room it was delivered
 * to, so a room that sells a lot of room service shows its true contribution.
 */
export function roomPerformance(from: string, to: string): RoomPerformanceRow[] {
  const nights = Math.max(1, nightsBetween(from, to) + 1);
  const rows = all<Omit<RoomPerformanceRow, 'total_revenue_minor' | 'occupancy_percent' | 'average_rate_minor'>>(
    `WITH RECURSIVE days(d) AS (
       SELECT ?
       UNION ALL
       SELECT date(d, '+1 day') FROM days WHERE d < ?
     )
     SELECT r.id AS room_id, r.number AS room_number, r.floor, t.name AS type_name,
            COALESCE(SUM(CASE WHEN b.status IN ${STAYED} THEN 1 ELSE 0 END), 0)             AS nights_sold,
            COALESCE(SUM(CASE WHEN b.status IN ${STAYED} THEN br.rate_minor ELSE 0 END), 0) AS room_revenue_minor,
            COALESCE((SELECT SUM(o.total_minor) FROM orders o
                       WHERE o.room_id = r.id AND o.status <> 'cancelled'
                         AND DATE(o.created_at) BETWEEN ? AND ?), 0)                        AS food_revenue_minor
       FROM rooms r
       JOIN room_types t ON t.id = r.room_type_id
       CROSS JOIN days
       LEFT JOIN booking_rooms br ON br.room_id = r.id AND br.from_date <= days.d AND br.to_date > days.d
       LEFT JOIN bookings b       ON b.id = br.booking_id
      WHERE r.is_active = 1
      GROUP BY r.id, r.number, r.floor, t.name
      ORDER BY room_revenue_minor DESC, r.number`,
    from,
    to,
    from,
    to,
  );

  return rows.map((r) => ({
    ...r,
    total_revenue_minor: r.room_revenue_minor + r.food_revenue_minor,
    occupancy_percent: Math.round((r.nights_sold / nights) * 100),
    average_rate_minor: r.nights_sold ? Math.round(r.room_revenue_minor / r.nights_sold) : 0,
  }));
}

/* ---------------------------------------------------------------- cashbook */

export interface CashBookRow {
  entry_date: string;
  sort_key: string;
  direction: 'in' | 'out';
  source: 'payment' | 'income' | 'expense';
  reference: string;
  description: string;
  mode: string;
  amount_minor: number;
  running_minor: number;
  link: string | null;
}

/**
 * Every movement of money in one chronological list, guest payments in,
 * expenses out, with a running balance. This is the page an owner reconciles
 * against the cash box at the end of a day or a month.
 */
export function cashBook(from: string, to: string, mode = 'all'): CashBookRow[] {
  const modeFilter = mode && mode !== 'all' ? mode : null;

  const payments = all<{
    entry_date: string; sort_key: string; reference: string; description: string;
    mode: string; amount_minor: number; invoice_id: number;
  }>(
    `SELECT DATE(p.created_at) AS entry_date, p.created_at AS sort_key,
            i.number AS reference,
            CASE WHEN i.guest_name <> '' THEN i.guest_name ELSE 'Walk-in' END AS description,
            p.mode, p.amount_minor, i.id AS invoice_id
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.status <> 'void' AND DATE(p.created_at) BETWEEN ? AND ?
        AND (? IS NULL OR p.mode = ?)`,
    from,
    to,
    modeFilter,
    modeFilter,
  );

  const ledger = all<{
    entry_date: string; kind: string; reference: string; description: string;
    mode: string; amount_minor: number; category_name: string; paid_to: string;
  }>(
    `SELECT e.entry_date, e.kind, e.reference, e.description,
            e.payment_mode AS mode, e.amount_minor, c.name AS category_name, e.paid_to
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.entry_date BETWEEN ? AND ?
        AND (? IS NULL OR e.payment_mode = ?)`,
    from,
    to,
    modeFilter,
    modeFilter,
  );

  const rows: Omit<CashBookRow, 'running_minor'>[] = [
    ...payments.map((p) => ({
      entry_date: p.entry_date,
      sort_key: p.sort_key,
      direction: 'in' as const,
      source: 'payment' as const,
      reference: p.reference,
      description: `Payment, ${p.description}`,
      mode: p.mode,
      amount_minor: p.amount_minor,
      link: `/invoices/${p.invoice_id}`,
    })),
    ...ledger.map((e) => ({
      entry_date: e.entry_date,
      // Ledger entries carry a date only; place them after the day's payments.
      sort_key: `${e.entry_date} 23:59:59`,
      direction: (e.kind === 'income' ? 'in' : 'out') as 'in' | 'out',
      source: (e.kind === 'income' ? 'income' : 'expense') as 'income' | 'expense',
      reference: e.reference || e.category_name,
      description: `${e.category_name}, ${e.description}${e.paid_to ? ` (${e.paid_to})` : ''}`,
      mode: e.mode,
      amount_minor: e.amount_minor,
      link: '/expenses',
    })),
  ].sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));

  let running = 0;
  return rows.map((row) => {
    running += row.direction === 'in' ? row.amount_minor : -row.amount_minor;
    return { ...row, running_minor: running };
  });
}

export interface CashBookSummary {
  in_minor: number;
  out_minor: number;
  net_minor: number;
  by_mode: { mode: string; in_minor: number; out_minor: number }[];
}

export function cashBookSummary(rows: CashBookRow[]): CashBookSummary {
  const byMode = new Map<string, { mode: string; in_minor: number; out_minor: number }>();
  let inTotal = 0;
  let outTotal = 0;

  for (const row of rows) {
    const entry = byMode.get(row.mode) ?? { mode: row.mode, in_minor: 0, out_minor: 0 };
    if (row.direction === 'in') {
      entry.in_minor += row.amount_minor;
      inTotal += row.amount_minor;
    } else {
      entry.out_minor += row.amount_minor;
      outTotal += row.amount_minor;
    }
    byMode.set(row.mode, entry);
  }

  return {
    in_minor: inTotal,
    out_minor: outTotal,
    net_minor: inTotal - outTotal,
    by_mode: [...byMode.values()].sort((a, b) => b.in_minor - a.in_minor),
  };
}

/* --------------------------------------------------------------- tax report */

export interface TaxRow {
  month: string;
  invoices: number;
  taxable_minor: number;
  tax_minor: number;
  total_minor: number;
}

/**
 * Tax charged on invoices, by month, the figures needed to file a return.
 * Voided invoices are excluded because no tax was ever due on them.
 */
export function taxReport(from: string, to: string): TaxRow[] {
  return all<TaxRow>(
    `SELECT strftime('%Y-%m', created_at) AS month,
            COUNT(*) AS invoices,
            COALESCE(SUM(room_charges_minor + food_charges_minor - discount_minor), 0) AS taxable_minor,
            COALESCE(SUM(tax_minor), 0)   AS tax_minor,
            COALESCE(SUM(total_minor), 0) AS total_minor
       FROM invoices
      WHERE status <> 'void' AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month`,
    from,
    to,
  );
}

/* ------------------------------------------------------------ yearly view */

export interface YearMonthRow {
  month: string;
  label: string;
  room_minor: number;
  food_minor: number;
  other_income_minor: number;
  total_sale_minor: number;
  expense_minor: number;
  profit_minor: number;
  rooms_sold: number;
  occupancy_percent: number;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Twelve months of profit and loss, for the year-end conversation. */
export function yearlySummary(year: number): { months: YearMonthRow[]; totals: YearMonthRow } {
  const months: YearMonthRow[] = [];
  const stop = today();

  for (let m = 0; m < 12; m++) {
    const first = `${year}-${String(m + 1).padStart(2, '0')}-01`;
    if (first > stop) break;
    const nextMonth = m === 11 ? `${year + 1}-01-01` : `${year}-${String(m + 2).padStart(2, '0')}-01`;
    const last = addDays(nextMonth, -1);
    const pnl = profitAndLoss(first, last > stop ? stop : last);

    months.push({
      month: first.slice(0, 7),
      label: MONTH_NAMES[m]!,
      room_minor: pnl.room_revenue_minor,
      food_minor: pnl.food_revenue_minor,
      other_income_minor: pnl.other_income_minor,
      total_sale_minor: pnl.total_sale_minor,
      expense_minor: pnl.expense_total_minor,
      profit_minor: pnl.profit_minor,
      rooms_sold: pnl.rooms_sold,
      occupancy_percent: pnl.occupancy_percent,
    });
  }

  const sum = (pick: (r: YearMonthRow) => number) => months.reduce((s, r) => s + pick(r), 0);
  const occupancyAvg = months.length
    ? Math.round(months.reduce((s, r) => s + r.occupancy_percent, 0) / months.length)
    : 0;

  return {
    months,
    totals: {
      month: String(year),
      label: 'Year total',
      room_minor: sum((r) => r.room_minor),
      food_minor: sum((r) => r.food_minor),
      other_income_minor: sum((r) => r.other_income_minor),
      total_sale_minor: sum((r) => r.total_sale_minor),
      expense_minor: sum((r) => r.expense_minor),
      profit_minor: sum((r) => r.profit_minor),
      rooms_sold: sum((r) => r.rooms_sold),
      occupancy_percent: occupancyAvg,
    },
  };
}
