import { Router } from 'express';
import { requirePermission } from '../lib/session.js';
import { isValidDate, monthRange, today } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { bool, int, oneOf, positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import {
  createExpense,
  deleteCategory,
  deleteExpense,
  getExpense,
  listCategories,
  listExpenses,
  saveCategory,
  totalsByCategory,
  updateExpense,
} from '../services/expenses.service.js';
import type { LedgerKind, PaymentMode } from '../types/domain.js';

const router = Router();

const PAYMENT_MODES: PaymentMode[] = ['cash', 'card', 'bank_transfer', 'online'];
const KINDS: LedgerKind[] = ['expense', 'income'];

/** Defaults to the current month, which is how the owner reviews spending. */
function period(query: Record<string, unknown>): { from: string; to: string } {
  const month = monthRange(today());
  const from = isValidDate(str(query.from)) ? str(query.from) : month.start;
  const to = isValidDate(str(query.to)) ? str(query.to) : today();
  return from <= to ? { from, to } : { from: to, to: from };
}

router.get('/expenses', requirePermission('expenses.view'), (req, res) => {
  const { from, to } = period(req.query as Record<string, unknown>);
  const filters = {
    from,
    to,
    category_id: int(req.query.category_id, 0),
    kind: str(req.query.kind) || 'all',
    q: str(req.query.q),
  };
  const entries = listExpenses(filters);
  const totals = totalsByCategory(from, to);

  res.render('pages/expenses', {
    title: 'Expenses',
    filters,
    entries,
    categories: listCategories(),
    totals,
    expenseTotal: totals.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount_minor, 0),
    incomeTotal: totals.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount_minor, 0),
    editing: getExpense(int(req.query.edit, 0)) ?? null,
    paymentModes: PAYMENT_MODES,
  });
});

function readInput(body: Record<string, unknown>) {
  const entryDate = str(body.entry_date);
  if (!isValidDate(entryDate)) throw new ValidationError('Give a valid date for this entry.');
  const amount = toMinor(body.amount);
  if (amount <= 0) throw new ValidationError('Enter an amount greater than zero.');

  return {
    entry_date: entryDate,
    category_id: positiveInt(body.category_id, 'Category'),
    description: requiredStr(body.description, 'Description', 200),
    paid_to: str(body.paid_to),
    amount_minor: amount,
    payment_mode: oneOf(body.payment_mode, PAYMENT_MODES, 'Paid by'),
    reference: str(body.reference),
    notes: str(body.notes),
  };
}

router.post('/expenses', requirePermission('expenses.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const id = int(body.id, 0);
  const input = readInput(body);

  if (id) {
    updateExpense(id, input, req);
    req.flash('success', 'Entry updated.');
  } else {
    createExpense(input, req);
    req.flash('success', 'Entry recorded.');
  }
  res.redirect(`/expenses?from=${str(body.filter_from) || input.entry_date}&to=${str(body.filter_to) || input.entry_date}`);
});

router.post('/expenses/:id/delete', requirePermission('expenses.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'Entry');
  deleteExpense(id, req);
  req.flash('success', 'Entry deleted.');
  res.redirect(req.get('referer') ?? '/expenses');
});

/* ------------------------------------------------------------- categories */

router.get('/expenses/categories', requirePermission('expenses.manage'), (req, res) => {
  res.render('pages/expense-categories', {
    title: 'Expense Categories',
    categories: listCategories(true),
    editing: listCategories(true).find((c) => c.id === int(req.query.edit, 0)) ?? null,
  });
});

router.post('/expenses/categories', requirePermission('expenses.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  saveCategory(
    int(body.id, 0),
    requiredStr(body.name, 'Category name', 60),
    oneOf(body.kind, KINDS, 'Type'),
    bool(body.is_active),
    req,
  );
  req.flash('success', 'Category saved.');
  res.redirect('/expenses/categories');
});

router.post('/expenses/categories/:id/delete', requirePermission('expenses.manage'), (req, res) => {
  deleteCategory(positiveInt(req.params.id, 'Category'), req);
  req.flash('success', 'Category deleted.');
  res.redirect('/expenses/categories');
});

export default router;
