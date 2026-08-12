import type { Request } from 'express';
import { all, get, run, scalar, tx } from '../db/index.js';
import { nowTs, today } from '../lib/dates.js';
import { logActivity } from '../lib/activity.js';
import { ValidationError } from '../lib/validate.js';
import { createExpense, getCategory, listCategories } from './expenses.service.js';
import type { PaymentMode } from '../types/domain.js';

/**
 * Stock for the kitchen, bar, housekeeping and maintenance.
 *
 * Current stock is never stored. It is the sum of every movement against an
 * item, so any figure on screen can be explained line by line, which is the
 * whole point of keeping a stock book. Correcting a mistake means recording an
 * adjustment, not quietly editing a number, and the adjustment carries a reason
 * and the name of whoever made it.
 */

export type StockCategory =
  | 'kitchen' | 'beverages' | 'housekeeping' | 'linen'
  | 'toiletries' | 'maintenance' | 'office' | 'other';

export const STOCK_CATEGORIES: StockCategory[] = [
  'kitchen', 'beverages', 'housekeeping', 'linen', 'toiletries', 'maintenance', 'office', 'other',
];

export const STOCK_CATEGORY_LABELS: Record<StockCategory, string> = {
  kitchen: 'Kitchen & food',
  beverages: 'Beverages',
  housekeeping: 'Housekeeping',
  linen: 'Linen & bedding',
  toiletries: 'Guest toiletries',
  maintenance: 'Maintenance & spares',
  office: 'Office & stationery',
  other: 'Other',
};

export type MovementKind = 'purchase' | 'opening' | 'issue' | 'wastage' | 'adjustment' | 'return';

export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  purchase: 'Purchase in',
  opening: 'Opening stock',
  issue: 'Issued out',
  wastage: 'Wastage / spoilage',
  adjustment: 'Stock-take adjustment',
  return: 'Returned to supplier',
};

/** Which way each kind moves the shelf. Adjustments can go either way. */
const DIRECTION: Record<MovementKind, 1 | -1 | 0> = {
  purchase: 1,
  opening: 1,
  issue: -1,
  wastage: -1,
  return: -1,
  adjustment: 0,
};

/* -------------------------------------------------------------- suppliers */

export interface Supplier {
  id: number;
  name: string;
  contact: string;
  phone: string;
  address: string;
  notes: string;
  is_active: number;
  created_at: string;
}

export function listSuppliers(includeInactive = false): Supplier[] {
  return all<Supplier>(
    `SELECT * FROM suppliers ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY name`,
  );
}

export function getSupplier(id: number): Supplier | undefined {
  return get<Supplier>('SELECT * FROM suppliers WHERE id = ?', id);
}

export function saveSupplier(
  id: number,
  input: { name: string; contact: string; phone: string; address: string; notes: string; is_active: number },
  req: Request,
): void {
  if (scalar('SELECT COUNT(*) FROM suppliers WHERE name = ? AND id <> ?', input.name, id)) {
    throw new ValidationError(`There is already a supplier called "${input.name}".`);
  }
  if (id) {
    run(
      'UPDATE suppliers SET name = ?, contact = ?, phone = ?, address = ?, notes = ?, is_active = ? WHERE id = ?',
      input.name, input.contact, input.phone, input.address, input.notes, input.is_active, id,
    );
    logActivity(req, 'updated supplier', 'supplier', id, input.name);
  } else {
    const created = run(
      'INSERT INTO suppliers (name, contact, phone, address, notes, created_at) VALUES (?,?,?,?,?,?)',
      input.name, input.contact, input.phone, input.address, input.notes, nowTs(),
    );
    logActivity(req, 'added supplier', 'supplier', created.lastInsertRowid, input.name);
  }
}

export function deleteSupplier(id: number, req: Request): void {
  const supplier = getSupplier(id);
  if (!supplier) throw new ValidationError('Supplier not found.');
  const items = scalar('SELECT COUNT(*) FROM inventory_items WHERE supplier_id = ?', id);
  const movements = scalar('SELECT COUNT(*) FROM stock_movements WHERE supplier_id = ?', id);
  if (items || movements) {
    throw new ValidationError(
      `"${supplier.name}" is linked to ${items} item(s) and ${movements} stock entr${movements === 1 ? 'y' : 'ies'}. Switch them off instead of deleting, so the purchase history stays intact.`,
    );
  }
  run('DELETE FROM suppliers WHERE id = ?', id);
  logActivity(req, 'deleted supplier', 'supplier', id, supplier.name);
}

/* ------------------------------------------------------------------ items */

export interface InventoryItem {
  id: number;
  name: string;
  category: StockCategory;
  unit: string;
  reorder_level: number;
  cost_minor: number;
  supplier_id: number | null;
  location: string;
  notes: string;
  is_active: number;
  created_at: string;
}

export interface StockRow extends InventoryItem {
  supplier_name: string | null;
  on_hand: number;
  value_minor: number;
  is_low: number;
  last_movement: string | null;
}

/**
 * Items with their current stock. The `on_hand` figure is summed from the
 * movement table on every read rather than cached, which keeps it honest, a
 * hotel's stock list is a few hundred rows, not a few million.
 */
const STOCK_SELECT = `
  SELECT i.*, s.name AS supplier_name,
         COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m WHERE m.item_id = i.id), 0) AS on_hand,
         (SELECT MAX(m.entry_date) FROM stock_movements m WHERE m.item_id = i.id) AS last_movement
    FROM inventory_items i
    LEFT JOIN suppliers s ON s.id = i.supplier_id`;

function decorate(row: StockRow): StockRow {
  return {
    ...row,
    value_minor: Math.round((row.on_hand * row.cost_minor) / 1000),
    is_low: row.reorder_level > 0 && row.on_hand <= row.reorder_level ? 1 : 0,
  };
}

export interface ItemFilters {
  category?: string;
  q?: string;
  low_only?: boolean;
  includeInactive?: boolean;
}

export function listStock(filters: ItemFilters = {}): StockRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (!filters.includeInactive) where.push('i.is_active = 1');
  if (filters.category && filters.category !== 'all') {
    where.push('i.category = ?');
    params.push(filters.category);
  }
  if (filters.q) {
    where.push('(i.name LIKE ? OR i.location LIKE ? OR s.name LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }

  const rows = all<StockRow>(
    `${STOCK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY i.category, i.name`,
    ...params,
  ).map(decorate);

  return filters.low_only ? rows.filter((r) => r.is_low) : rows;
}

export function getStockItem(id: number): StockRow | undefined {
  const row = get<StockRow>(`${STOCK_SELECT} WHERE i.id = ?`, id);
  return row ? decorate(row) : undefined;
}

/** Items at or below their reorder level, the shopping list. */
export function lowStock(): StockRow[] {
  return listStock({ low_only: true });
}

export interface ItemInput {
  name: string;
  category: StockCategory;
  unit: string;
  reorder_level: number;
  cost_minor: number;
  supplier_id: number | null;
  location: string;
  notes: string;
  is_active: number;
}

export function saveItem(id: number, input: ItemInput, req: Request): number {
  if (scalar('SELECT COUNT(*) FROM inventory_items WHERE name = ? AND id <> ?', input.name, id)) {
    throw new ValidationError(`There is already an item called "${input.name}".`);
  }
  if (id) {
    run(
      `UPDATE inventory_items SET name = ?, category = ?, unit = ?, reorder_level = ?, cost_minor = ?,
              supplier_id = ?, location = ?, notes = ?, is_active = ?
        WHERE id = ?`,
      input.name, input.category, input.unit, input.reorder_level, input.cost_minor,
      input.supplier_id, input.location, input.notes, input.is_active, id,
    );
    logActivity(req, 'updated stock item', 'inventory_item', id, input.name);
    return id;
  }
  const created = run(
    `INSERT INTO inventory_items (name, category, unit, reorder_level, cost_minor, supplier_id, location, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    input.name, input.category, input.unit, input.reorder_level, input.cost_minor,
    input.supplier_id, input.location, input.notes, nowTs(),
  );
  logActivity(req, 'added stock item', 'inventory_item', created.lastInsertRowid, input.name);
  return created.lastInsertRowid;
}

export function deleteItem(id: number, req: Request): void {
  const item = getStockItem(id);
  if (!item) throw new ValidationError('Item not found.');
  const movements = scalar('SELECT COUNT(*) FROM stock_movements WHERE item_id = ?', id);
  if (movements) {
    throw new ValidationError(
      `"${item.name}" has ${movements} stock movement(s) against it. Deleting it would erase that history, switch it off instead and it will drop off the stock list.`,
    );
  }
  run('DELETE FROM inventory_items WHERE id = ?', id);
  logActivity(req, 'deleted stock item', 'inventory_item', id, item.name);
}

/* -------------------------------------------------------------- movements */

export interface MovementInput {
  item_id: number;
  entry_date: string;
  kind: MovementKind;
  /** Always positive as typed; the kind decides the direction. */
  qty: number;
  unit_cost_minor: number;
  supplier_id: number | null;
  reference: string;
  note: string;
  /** Adjustments only: true when the stock-take found less than the book said. */
  adjustment_is_loss?: boolean;
  /** Purchases only: also record it in the expense ledger. */
  post_to_expenses?: boolean;
  expense_category_id?: number | null;
  payment_mode?: PaymentMode;
}

export function recordMovement(input: MovementInput, req: Request): number {
  const item = getStockItem(input.item_id);
  if (!item) throw new ValidationError('Choose a stock item.');
  if (input.qty <= 0) throw new ValidationError('Enter a quantity greater than zero.');

  const direction = DIRECTION[input.kind];
  const signed =
    direction === 0
      ? (input.adjustment_is_loss ? -input.qty : input.qty)
      : input.qty * direction;

  // Stock cannot go negative: that always means an earlier entry is missing,
  // and letting it happen quietly makes the whole book untrustworthy.
  if (signed < 0 && item.on_hand + signed < 0) {
    throw new ValidationError(
      `Only ${item.on_hand / 1000} ${item.unit} of "${item.name}" is in stock, so ${input.qty / 1000} cannot be taken out. Record the missing purchase first, or use a stock-take adjustment.`,
    );
  }

  const unitCost = input.unit_cost_minor || item.cost_minor;
  const value = Math.round((Math.abs(signed) * unitCost) / 1000);

  return tx(() => {
    let expenseId: number | null = null;

    // A purchase is money out as well as stock in. Posting it to the ledger
    // here keeps the profit figures right without anyone typing it twice.
    if (input.kind === 'purchase' && input.post_to_expenses && value > 0) {
      const category = input.expense_category_id ? getCategory(input.expense_category_id) : undefined;
      if (!category) throw new ValidationError('Choose which expense heading this purchase belongs under.');
      const supplier = input.supplier_id ? getSupplier(input.supplier_id) : undefined;
      expenseId = createExpense(
        {
          entry_date: input.entry_date,
          category_id: category.id,
          description: `${item.name}, ${input.qty / 1000} ${item.unit}`,
          paid_to: supplier?.name ?? '',
          amount_minor: value,
          payment_mode: input.payment_mode ?? 'cash',
          reference: input.reference,
          notes: 'Recorded from the stock purchase screen',
        },
        req,
      );
    }

    const created = run(
      `INSERT INTO stock_movements
         (item_id, entry_date, kind, qty_change, unit_cost_minor, value_minor, supplier_id,
          reference, note, expense_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.item_id,
      input.entry_date,
      input.kind,
      signed,
      unitCost,
      value,
      input.supplier_id,
      input.reference,
      input.note,
      expenseId,
      req.user?.id ?? null,
      nowTs(),
    );

    // A purchase price is the best estimate of what the item is worth now.
    if (input.kind === 'purchase' && input.unit_cost_minor > 0) {
      run('UPDATE inventory_items SET cost_minor = ? WHERE id = ?', input.unit_cost_minor, input.item_id);
    }

    logActivity(
      req,
      MOVEMENT_LABELS[input.kind].toLowerCase(),
      'inventory_item',
      input.item_id,
      `${item.name} · ${signed > 0 ? '+' : ''}${signed / 1000} ${item.unit}${input.note ? ` · ${input.note}` : ''}`,
    );
    return created.lastInsertRowid;
  });
}

export interface MovementRow {
  id: number;
  item_id: number;
  item_name: string;
  unit: string;
  entry_date: string;
  kind: MovementKind;
  qty_change: number;
  unit_cost_minor: number;
  value_minor: number;
  supplier_name: string | null;
  reference: string;
  note: string;
  expense_id: number | null;
  created_by_name: string | null;
  created_at: string;
}

const MOVEMENT_SELECT = `
  SELECT m.*, i.name AS item_name, i.unit, s.name AS supplier_name, u.full_name AS created_by_name
    FROM stock_movements m
    JOIN inventory_items i ON i.id = m.item_id
    LEFT JOIN suppliers s ON s.id = m.supplier_id
    LEFT JOIN users u ON u.id = m.created_by`;

export interface MovementFilters {
  item_id?: number;
  kind?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function listMovements(filters: MovementFilters = {}): MovementRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.item_id) {
    where.push('m.item_id = ?');
    params.push(filters.item_id);
  }
  if (filters.kind && filters.kind !== 'all') {
    where.push('m.kind = ?');
    params.push(filters.kind);
  }
  if (filters.from) {
    where.push('m.entry_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('m.entry_date <= ?');
    params.push(filters.to);
  }
  params.push(filters.limit ?? 300);

  return all<MovementRow>(
    `${MOVEMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY m.entry_date DESC, m.id DESC LIMIT ?`,
    ...params,
  );
}

export function deleteMovement(id: number, req: Request): void {
  const movement = get<MovementRow>(`${MOVEMENT_SELECT} WHERE m.id = ?`, id);
  if (!movement) throw new ValidationError('Stock entry not found.');
  if (movement.expense_id) {
    throw new ValidationError(
      'This purchase also created an expense entry. Delete it from the Expenses ledger instead, so the two stay in step.',
    );
  }
  run('DELETE FROM stock_movements WHERE id = ?', id);
  logActivity(
    req,
    'deleted stock entry',
    'inventory_item',
    movement.item_id,
    `${movement.item_name} · ${movement.qty_change / 1000} ${movement.unit} on ${movement.entry_date}`,
  );
}

/* ---------------------------------------------------------------- summary */

export interface StockSummary {
  items: number;
  low_items: number;
  out_of_stock: number;
  value_minor: number;
  purchases_minor: number;
  consumed_minor: number;
  wastage_minor: number;
}

export function stockSummary(from: string, to: string): StockSummary {
  const rows = listStock();
  const period = (kind: MovementKind) =>
    scalar(
      'SELECT COALESCE(SUM(value_minor),0) FROM stock_movements WHERE kind = ? AND entry_date BETWEEN ? AND ?',
      kind, from, to,
    );

  return {
    items: rows.length,
    low_items: rows.filter((r) => r.is_low).length,
    out_of_stock: rows.filter((r) => r.on_hand <= 0).length,
    value_minor: rows.reduce((s, r) => s + r.value_minor, 0),
    purchases_minor: period('purchase'),
    consumed_minor: period('issue'),
    wastage_minor: period('wastage'),
  };
}

export interface CategoryValueRow {
  category: StockCategory;
  items: number;
  value_minor: number;
}

export function valueByCategory(): CategoryValueRow[] {
  const byCategory = new Map<StockCategory, CategoryValueRow>();
  for (const row of listStock()) {
    const entry = byCategory.get(row.category) ?? { category: row.category, items: 0, value_minor: 0 };
    entry.items++;
    entry.value_minor += row.value_minor;
    byCategory.set(row.category, entry);
  }
  return STOCK_CATEGORIES.map((c) => byCategory.get(c)).filter((r): r is CategoryValueRow => Boolean(r));
}

/** Expense headings a stock purchase can sensibly be posted against. */
export function purchaseExpenseCategories() {
  return listCategories().filter((c) => c.kind === 'expense');
}

export function defaultMovementDate(): string {
  return today();
}
