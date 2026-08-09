import { Router } from 'express';
import { run, tx } from '../db/index.js';
import { hashPassword, passwordProblem } from '../lib/security.js';
import { nowTs } from '../lib/dates.js';
import { bool, requiredStr, str } from '../lib/validate.js';
import { createSession } from '../lib/session.js';
import { saveSettings } from '../services/settings.service.js';
import { seedStarterData } from '../db/seed.js';
import { logActivity } from '../lib/activity.js';

const router = Router();

/**
 * First-run wizard. Nothing in the system works until an administrator account
 * exists, so there is no default password anywhere in this codebase.
 */
router.get('/setup', (_req, res) => {
  res.render('pages/setup', { title: 'Set up your hotel', form: {}, error: null });
});

router.post('/setup', (req, res) => {
  const body = req.body as Record<string, unknown>;
  const form = {
    hotel_name: str(body.hotel_name),
    hotel_address: str(body.hotel_address),
    hotel_phone: str(body.hotel_phone),
    currency_symbol: str(body.currency_symbol) || 'Rs.',
    tax_percent: str(body.tax_percent) || '0',
    full_name: str(body.full_name),
    username: str(body.username),
    seed: bool(body.seed),
  };

  const fail = (message: string) =>
    res.status(400).render('pages/setup', { title: 'Set up your hotel', form, error: message });

  try {
    const hotelName = requiredStr(body.hotel_name, 'Hotel name');
    const fullName = requiredStr(body.full_name, 'Your name');
    const username = requiredStr(body.username, 'Username', 40);
    const password = str(body.password);
    const confirm = str(body.confirm_password);

    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      return fail('Username can only contain letters, numbers, dots, dashes and underscores.');
    }
    if (password !== confirm) return fail('The two passwords do not match.');
    const weak = passwordProblem(password);
    if (weak) return fail(weak);

    const userId = tx(() => {
      saveSettings({
        hotel_name: hotelName,
        hotel_address: form.hotel_address,
        hotel_phone: form.hotel_phone,
        currency_symbol: form.currency_symbol,
        tax_percent: form.tax_percent,
      });
      const created = run(
        `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
         VALUES (?,?,?,'admin',1,?)`,
        username,
        hashPassword(password),
        fullName,
        nowTs(),
      );
      if (form.seed) seedStarterData();
      return created.lastInsertRowid;
    });

    createSession(res, userId, req.ip ?? '');
    logActivity(null, 'completed setup', 'system', 0, hotelName);
    req.flash('success', `Welcome, ${fullName}. Your system is ready.`);
    res.redirect('/');
    return;
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Setup could not be completed.');
  }
});

export default router;
