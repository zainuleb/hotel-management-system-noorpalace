import type { Request } from 'express';
import { all, get, run, scalar } from '../db/index.js';
import { nowTs } from '../lib/dates.js';
import { logActivity } from '../lib/activity.js';
import { ValidationError } from '../lib/validate.js';
import type { Expense, ExpenseCategory, LedgerKind, PaymentMode } from '../types/domain.js';

/**
 * The money side of the business that has nothing to do with a guest: salaries,
 * utility bills, kitchen purchases, laundry, maintenance, the headings from
 * the hotel's own monthly report sheet, plus any income that is not a room or
 * a meal.
 *
 * Recorded against a *date*, not a timestamp, because that is how the owner
 * thinks about them ("March's electricity bill"), and it is what makes the
 * daily and monthly profit figures line up with the paper book.
 */

/* ------------------------------------------------------------- categories */

export function listCategories(includeInactive = false): ExpenseCategory[] {
  return all<ExpenseCategory>(
    // Expenses before income: 'expense' < 'income', and the entry form should
    // land on a spending category, which is what it is used for 99% of the time.
    `SELECT * FROM expense_categories ${includeInactive ? '' : 'WHERE is_active = 1'}
     ORDER BY kind ASC, sort_order, name`,
  );
}

export function getCategory(id: number): ExpenseCategory | undefined {
  return get<ExpenseCategory>('SELECT * FROM expense_categories WHERE id = ?', id);
}

export function saveCategory(
  id: number,
  name: string,
  kind: LedgerKind,
  isActive: number,
  req: Request,
): void {
  const clash = scalar('SELECT COUNT(*) FROM expense_categories WHERE name = ? AND id <> ?', name, id);
  if (clash) throw new ValidationError(`There is already a category called "${name}".`);

  if (id) {
    const existing = getCategory(id);
    if (!existing) throw new ValidationError('Category not found.');
    // Changing the kind would silently flip the sign of every past entry.
    if (existing.kind !== kind && scalar('SELECT COUNT(*) FROM expenses WHERE category_id = ?', id)) {
      throw new ValidationError(
        `"${existing.name}" already has entries recorded against it, so it cannot be switched between expense and income. Make a new category instead.`,
      );
    }
    run('UPDATE expense_categories SET name = ?, kind = ?, is_active = ? WHERE id = ?', name, kind, isActive, id);
    logActivity(req, 'updated expense category', 'expense_category', id, name);
  } else {
    const created = run(
      'INSERT INTO expense_categories (name, kind, sort_order) VALUES (?,?,?)',
      name,
      kind,
      scalar('SELECT COALESCE(MAX(sort_order),0) + 1 FROM expense_categories'),
    );
    logActivity(req, 'added expense category', 'expense_category', created.lastInsertRowid, name);
  }
}

export function deleteCategory(id: number, req: Request): void {
  const category = getCategory(id);
  if (!category) throw new ValidationError('Category not found.');
  const used = scalar('SELECT COUNT(*) FROM expenses WHERE category_id = ?', id);
  if (used) {
    throw new ValidationError(
      `"${category.name}" has ${used} entr${used === 1 ? 'y' : 'ies'} recorded against it. Deleting it would change past reports. Switch it off instead and it will stop appearing on the form.`,
    );
  }
  run('DELETE FROM expense_categories WHERE id = ?', id);
  logActivity(req, 'deleted expense category', 'expense_category', id, category.name);
}

/* ---------------------------------------------------------------- entries */

export interface ExpenseInput {
  entry_date: string;
  category_id: number;
  description: string;
  paid_to: string;
  amount_minor: number;
  payment_mode: PaymentMode;
  reference: string;
  notes: string;
}

export interface ExpenseRow extends Expense {
  category_name: string;
  created_by_name: string | null;
}

const SELECT = `
  SELECT e.*, c.name AS category_name, u.full_name AS created_by_name
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN users u ON u.id = e.created_by`;

export function getExpense(id: number): ExpenseRow | undefined {
  return get<ExpenseRow>(`${SELECT} WHERE e.id = ?`, id);
}

export function createExpense(input: ExpenseInput, req: Request): number {
  const category = getCategory(input.category_id);
  if (!category) throw new ValidationError('Choose a category.');
  if (input.amount_minor <= 0) throw new ValidationError('Enter an amount greater than zero.');

  const created = run(
    `INSERT INTO expenses
       (entry_date, category_id, kind, description, paid_to, amount_minor, payment_mode, reference, notes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    input.entry_date,
    input.category_id,
    category.kind,
    input.description,
    input.paid_to,
    input.amount_minor,
    input.payment_mode,
    input.reference,
    input.notes,
    req.user?.id ?? null,
    nowTs(),
  );
  logActivity(
    req,
    category.kind === 'income' ? 'recorded other income' : 'recorded expense',
    'expense',
    created.lastInsertRowid,
    `${category.name} · ${(input.amount_minor / 100).toFixed(2)} on ${input.entry_date}`,
  );
  return created.lastInsertRowid;
}

export function updateExpense(id: number, input: ExpenseInput, req: Request): void {
  const existing = getExpense(id);
  if (!existing) throw new ValidationError('Entry not found.');
  const category = getCategory(input.category_id);
  if (!category) throw new ValidationError('Choose a category.');
  if (input.amount_minor <= 0) throw new ValidationError('Enter an amount greater than zero.');

  run(
    `UPDATE expenses SET entry_date = ?, category_id = ?, kind = ?, description = ?, paid_to = ?,
            amount_minor = ?, payment_mode = ?, reference = ?, notes = ?
      WHERE id = ?`,
    input.entry_date,
    input.category_id,
    category.kind,
    input.description,
    input.paid_to,
    input.amount_minor,
    input.payment_mode,
    input.reference,
    input.notes,
    id,
  );
  logActivity(
    req,
    'edited expense',
    'expense',
    id,
    `${category.name} · ${(existing.amount_minor / 100).toFixed(2)} → ${(input.amount_minor / 100).toFixed(2)}`,
  );
}

export function deleteExpense(id: number, req: Request): void {
  const existing = getExpense(id);
  if (!existing) throw new ValidationError('Entry not found.');
  run('DELETE FROM expenses WHERE id = ?', id);
  logActivity(
    req,
    'deleted expense',
    'expense',
    id,
    `${existing.category_name} · ${(existing.amount_minor / 100).toFixed(2)} on ${existing.entry_date}`,
  );
}

export interface ExpenseFilters {
  from?: string;
  to?: string;
  category_id?: number;
  kind?: string;
  q?: string;
  limit?: number;
}

export function listExpenses(filters: ExpenseFilters = {}): ExpenseRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.from) {
    where.push('e.entry_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('e.entry_date <= ?');
    params.push(filters.to);
  }
  if (filters.category_id) {
    where.push('e.category_id = ?');
    params.push(filters.category_id);
  }
  if (filters.kind && filters.kind !== 'all') {
    where.push('e.kind = ?');
    params.push(filters.kind);
  }
  if (filters.q) {
    where.push('(e.description LIKE ? OR e.paid_to LIKE ? OR e.reference LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }
  params.push(filters.limit ?? 300);

  return all<ExpenseRow>(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.entry_date DESC, e.id DESC LIMIT ?`,
    ...params,
  );
}

/* ----------------------------------------------------------------- totals */

export function totalBetween(from: string, to: string, kind: LedgerKind): number {
  return scalar(
    'SELECT COALESCE(SUM(amount_minor),0) FROM expenses WHERE kind = ? AND entry_date BETWEEN ? AND ?',
    kind,
    from,
    to,
  );
}

export interface CategoryTotal {
  category_id: number;
  category_name: string;
  kind: LedgerKind;
  entries: number;
  amount_minor: number;
}

/** One row per category that had activity, the body of the monthly report. */
export function totalsByCategory(from: string, to: string): CategoryTotal[] {
  return all<CategoryTotal>(
    `SELECT c.id AS category_id, c.name AS category_name, c.kind AS kind,
            COUNT(e.id) AS entries, COALESCE(SUM(e.amount_minor),0) AS amount_minor
       FROM expense_categories c
       JOIN expenses e ON e.category_id = c.id AND e.entry_date BETWEEN ? AND ?
      GROUP BY c.id, c.name, c.kind
      ORDER BY c.kind ASC, c.sort_order, c.name`,
    from,
    to,
  );
}

/** Day-by-day expense totals, for the monthly report's trend column. */
export function expensesByDay(from: string, to: string): { day: string; amount_minor: number }[] {
  return all(
    `SELECT entry_date AS day, COALESCE(SUM(amount_minor),0) AS amount_minor
       FROM expenses WHERE kind = 'expense' AND entry_date BETWEEN ? AND ?
      GROUP BY entry_date ORDER BY day`,
    from,
    to,
  );
}
