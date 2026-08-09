import { Router } from 'express';
import { requirePermission } from '../lib/session.js';
import { isValidDate, today } from '../lib/dates.js';
import { toMinor } from '../lib/money.js';
import { oneOf, positiveInt, str, ValidationError } from '../lib/validate.js';
import { recentActivity } from '../lib/activity.js';
import {
  addPayment,
  balanceOf,
  getInvoice,
  groupedInvoiceLines,
  invoiceLines,
  invoicePayments,
  listInvoices,
  paidTotal,
  voidInvoice,
} from '../services/billing.service.js';
import { getBooking } from '../services/bookings.service.js';
import { getSettings } from '../services/settings.service.js';
import type { PaymentMode } from '../types/domain.js';

const router = Router();

const PAYMENT_MODES: PaymentMode[] = ['cash', 'card', 'bank_transfer', 'online'];

router.get('/invoices', requirePermission('billing.view'), (req, res) => {
  const filters = {
    status: str(req.query.status) || 'all',
    kind: str(req.query.kind) || 'all',
    q: str(req.query.q),
    from: isValidDate(str(req.query.from)) ? str(req.query.from) : '',
    to: isValidDate(str(req.query.to)) ? str(req.query.to) : '',
  };
  const invoices = listInvoices(filters);
  res.render('pages/invoices', {
    title: 'Invoices',
    filters,
    invoices,
    totals: {
      billed: invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + i.total_minor, 0),
      paid: invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + i.paid_minor, 0),
      outstanding: invoices
        .filter((i) => i.status === 'unpaid' || i.status === 'partial')
        .reduce((s, i) => s + i.balance_minor, 0),
    },
  });
});

function invoicePage(id: number) {
  const invoice = getInvoice(id);
  if (!invoice) throw new ValidationError('Invoice not found.');
  return {
    invoice,
    groups: groupedInvoiceLines(id),
    lines: invoiceLines(id),
    payments: invoicePayments(id),
    paid: paidTotal(id),
    balance: balanceOf(invoice),
    booking: invoice.booking_id ? getBooking(invoice.booking_id) : null,
  };
}

router.get('/invoices/:id', requirePermission('billing.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Invoice');
  const data = invoicePage(id);
  res.render('pages/invoice-detail', {
    title: `Invoice ${data.invoice.number}`,
    ...data,
    paymentModes: PAYMENT_MODES,
    autoPrint: str(req.query.print),
    history: recentActivity(30, 'invoice', id),
  });
});

/* ------------------------------------------------------------- printing */

router.get('/invoices/:id/receipt', requirePermission('billing.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Invoice');
  const data = invoicePage(id);
  res.render('print/receipt', {
    title: `Receipt ${data.invoice.number}`,
    ...data,
    settings: getSettings(),
    autoPrint: str(req.query.auto) !== '0',
  });
});

router.get('/invoices/:id/print', requirePermission('billing.view'), (req, res) => {
  const id = positiveInt(req.params.id, 'Invoice');
  const data = invoicePage(id);
  res.render('print/invoice-a4', {
    title: `Invoice ${data.invoice.number}`,
    ...data,
    settings: getSettings(),
    autoPrint: str(req.query.auto) !== '0',
  });
});

/* ------------------------------------------------------------- payments */

router.post('/invoices/:id/payments', requirePermission('billing.payment'), (req, res) => {
  const id = positiveInt(req.params.id, 'Invoice');
  const body = req.body as Record<string, unknown>;
  addPayment(
    id,
    toMinor(body.amount),
    oneOf(body.mode, PAYMENT_MODES, 'Payment mode'),
    str(body.reference),
    str(body.note),
    req,
  );
  req.flash('success', 'Payment recorded.');
  res.redirect(`/invoices/${id}`);
});

router.post('/invoices/:id/void', requirePermission('billing.void'), (req, res) => {
  const id = positiveInt(req.params.id, 'Invoice');
  voidInvoice(id, str((req.body as Record<string, unknown>).reason), req);
  req.flash('success', 'Invoice voided. Its orders are available to bill again.');
  res.redirect(`/invoices/${id}`);
});

/* ----------------------------------------------------------- outstanding */

router.get('/billing/outstanding', requirePermission('billing.view'), (_req, res) => {
  const invoices = listInvoices({ status: 'outstanding', limit: 500 });
  res.render('pages/outstanding', {
    title: 'Outstanding Payments',
    invoices,
    total: invoices.reduce((s, i) => s + i.balance_minor, 0),
    asOf: today(),
  });
});

export default router;
