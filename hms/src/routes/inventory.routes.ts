import { Router } from 'express';
import { requirePermission } from '../lib/session.js';
import { isValidDate, monthRange, today } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { toQty } from '../lib/quantity.js';
import { bool, int, oneOf, optionalId, positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import {
  deleteItem,
  deleteMovement,
  deleteSupplier,
  getStockItem,
  listMovements,
  listStock,
  listSuppliers,
  lowStock,
  purchaseExpenseCategories,
  recordMovement,
  saveItem,
  saveSupplier,
  stockSummary,
  valueByCategory,
  MOVEMENT_LABELS,
  STOCK_CATEGORIES,
  STOCK_CATEGORY_LABELS,
  type MovementKind,
  type StockCategory,
} from '../services/inventory.service.js';
import { STOCK_UNITS } from '../lib/quantity.js';
import type { PaymentMode } from '../types/domain.js';

const router = Router();

const KINDS: MovementKind[] = ['purchase', 'opening', 'issue', 'wastage', 'adjustment', 'return'];
const PAYMENT_MODES: PaymentMode[] = ['cash', 'card', 'bank_transfer', 'online'];

function period(query: Record<string, unknown>): { from: string; to: string } {
  const month = monthRange(today());
  const from = isValidDate(str(query.from)) ? str(query.from) : month.start;
  const to = isValidDate(str(query.to)) ? str(query.to) : today();
  return from <= to ? { from, to } : { from: to, to: from };
}

/* ------------------------------------------------------------- stock list */

router.get('/inventory', requirePermission('inventory.view'), (req, res) => {
  const { from, to } = period(req.query as Record<string, unknown>);
  const filters = {
    category: str(req.query.category) || 'all',
    q: str(req.query.q),
    low_only: str(req.query.low) === '1',
  };
  const rows = listStock(filters);

  res.render('pages/inventory', {
    title: 'Inventory',
    filters,
    rows,
    from,
    to,
    summary: stockSummary(from, to),
    byCategory: valueByCategory(),
    categories: STOCK_CATEGORIES,
    categoryLabels: STOCK_CATEGORY_LABELS,
    lowCount: lowStock().length,
  });
});

/* ------------------------------------------------------- record a movement */

router.get('/inventory/movements', requirePermission('inventory.view'), (req, res) => {
  const { from, to } = period(req.query as Record<string, unknown>);
  const itemId = int(req.query.item_id, 0);

  res.render('pages/inventory-movements', {
    title: 'Stock Movements',
    from,
    to,
    itemId,
    kind: str(req.query.kind) || 'all',
    movements: listMovements({ from, to, item_id: itemId || undefined, kind: str(req.query.kind) }),
    items: listStock({ includeInactive: true }),
    suppliers: listSuppliers(),
    kinds: KINDS,
    kindLabels: MOVEMENT_LABELS,
    expenseCategories: purchaseExpenseCategories(),
    paymentModes: PAYMENT_MODES,
    preselect: {
      item_id: itemId,
      kind: (str(req.query.record) || 'purchase') as MovementKind,
    },
  });
});

router.post('/inventory/movements', requirePermission('inventory.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const entryDate = str(body.entry_date);
  if (!isValidDate(entryDate)) throw new ValidationError('Give a valid date for this stock entry.');

  const kind = oneOf(body.kind, KINDS, 'Entry type');
  const postToExpenses = bool(body.post_to_expenses) === 1;

  recordMovement(
    {
      item_id: positiveInt(body.item_id, 'Item'),
      entry_date: entryDate,
      kind,
      qty: toQty(body.qty),
      unit_cost_minor: toMinor(body.unit_cost),
      supplier_id: optionalId(body.supplier_id),
      reference: str(body.reference),
      note: str(body.note),
      adjustment_is_loss: str(body.adjustment_direction) === 'loss',
      post_to_expenses: kind === 'purchase' && postToExpenses,
      expense_category_id: optionalId(body.expense_category_id),
      payment_mode: oneOf(body.payment_mode, PAYMENT_MODES, 'Paid by'),
    },
    req,
  );

  req.flash('success', `${MOVEMENT_LABELS[kind]} recorded.`);
  res.redirect(`/inventory/movements?from=${str(body.filter_from) || entryDate}&to=${str(body.filter_to) || entryDate}`);
});

router.post('/inventory/movements/:id/delete', requirePermission('inventory.manage'), (req, res) => {
  deleteMovement(positiveInt(req.params.id, 'Stock entry'), req);
  req.flash('success', 'Stock entry removed.');
  res.redirect(req.get('referer') ?? '/inventory/movements');
});

/* ----------------------------------------------------------------- items */

router.get('/inventory/items', requirePermission('inventory.manage'), (req, res) => {
  res.render('pages/inventory-items', {
    title: 'Stock Items',
    rows: listStock({ includeInactive: true }),
    editing: getStockItem(int(req.query.edit, 0)) ?? null,
    suppliers: listSuppliers(true),
    categories: STOCK_CATEGORIES,
    categoryLabels: STOCK_CATEGORY_LABELS,
    units: STOCK_UNITS,
  });
});

router.post('/inventory/items', requirePermission('inventory.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const id = int(body.id, 0);
  const name = requiredStr(body.name, 'Item name', 100);

  const itemId = saveItem(
    id,
    {
      name,
      category: oneOf(body.category, STOCK_CATEGORIES, 'Category') as StockCategory,
      unit: str(body.unit) || 'pcs',
      reorder_level: toQty(body.reorder_level),
      cost_minor: toMinor(body.cost),
      supplier_id: optionalId(body.supplier_id),
      location: str(body.location),
      notes: str(body.notes),
      is_active: bool(body.is_active),
    },
    req,
  );

  // A new item usually has something already on the shelf; record it as the
  // opening balance so the stock figure starts out true.
  const opening = toQty(body.opening_qty);
  if (!id && opening > 0) {
    recordMovement(
      {
        item_id: itemId,
        entry_date: today(),
        kind: 'opening',
        qty: opening,
        unit_cost_minor: toMinor(body.cost),
        supplier_id: optionalId(body.supplier_id),
        reference: '',
        note: 'Opening stock when the item was added',
      },
      req,
    );
  }

  req.flash('success', `"${name}" saved.`);
  res.redirect('/inventory/items');
});

router.post('/inventory/items/:id/delete', requirePermission('inventory.manage'), (req, res) => {
  deleteItem(positiveInt(req.params.id, 'Item'), req);
  req.flash('success', 'Item deleted.');
  res.redirect('/inventory/items');
});

/* ------------------------------------------------------------- suppliers */

router.get('/inventory/suppliers', requirePermission('inventory.manage'), (req, res) => {
  const suppliers = listSuppliers(true);
  res.render('pages/inventory-suppliers', {
    title: 'Suppliers',
    suppliers,
    editing: suppliers.find((s) => s.id === int(req.query.edit, 0)) ?? null,
  });
});

router.post('/inventory/suppliers', requirePermission('inventory.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  saveSupplier(
    int(body.id, 0),
    {
      name: requiredStr(body.name, 'Supplier name', 100),
      contact: str(body.contact),
      phone: str(body.phone),
      address: str(body.address),
      notes: str(body.notes),
      is_active: bool(body.is_active),
    },
    req,
  );
  req.flash('success', 'Supplier saved.');
  res.redirect('/inventory/suppliers');
});

router.post('/inventory/suppliers/:id/delete', requirePermission('inventory.manage'), (req, res) => {
  deleteSupplier(positiveInt(req.params.id, 'Supplier'), req);
  req.flash('success', 'Supplier deleted.');
  res.redirect('/inventory/suppliers');
});

/* ------------------------------------------------------------------ item */

router.get('/inventory/items/:id', requirePermission('inventory.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Item');
  const item = getStockItem(id);
  if (!item) throw new ValidationError('Item not found.');

  res.render('pages/inventory-item', {
    title: item.name,
    item,
    movements: listMovements({ item_id: id, limit: 200 }),
    categoryLabels: STOCK_CATEGORY_LABELS,
    kindLabels: MOVEMENT_LABELS,
  });
});

/* ------------------------------------------------------------------- CSV */

router.get('/inventory/export.csv', requirePermission('inventory.view'), (req, res) => {
  const which = str(req.query.report) || 'stock';
  const { from, to } = period(req.query as Record<string, unknown>);

  let header: string[] = [];
  let rows: (string | number)[][] = [];

  if (which === 'movements') {
    header = ['Date', 'Item', 'Type', 'Quantity', 'Unit', 'Unit cost', 'Value', 'Supplier', 'Reference', 'Note', 'By'];
    rows = listMovements({ from, to, limit: 5000 }).map((m) => [
      m.entry_date, m.item_name, MOVEMENT_LABELS[m.kind], m.qty_change / 1000, m.unit,
      m.unit_cost_minor / 100, m.value_minor / 100, m.supplier_name ?? '', m.reference, m.note,
      m.created_by_name ?? '',
    ]);
  } else {
    header = ['Item', 'Category', 'Unit', 'On hand', 'Reorder level', 'Low?', 'Unit cost', 'Stock value', 'Supplier', 'Location'];
    rows = listStock({ includeInactive: true }).map((r) => [
      r.name, STOCK_CATEGORY_LABELS[r.category], r.unit, r.on_hand / 1000, r.reorder_level / 1000,
      r.is_low ? 'LOW' : '', r.cost_minor / 100, r.value_minor / 100, r.supplier_name ?? '', r.location,
    ]);
  }

  const escape = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${which}-${today()}.csv"`);
  res.send(`﻿${csv}`);
});

export default router;
