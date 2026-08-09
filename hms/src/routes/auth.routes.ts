import { Router } from 'express';
import { get, run } from '../db/index.js';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/security.js';
import { createSession, destroySession, destroyUserSessions, verifyCsrf } from '../lib/session.js';
import { landingPath } from '../lib/permissions.js';
import { logActivity } from '../lib/activity.js';
import { nowTs } from '../lib/dates.js';
import { str } from '../lib/validate.js';
import type { User } from '../types/domain.js';

const router = Router();

/** Small in-memory throttle. Enough to stop guessing on a LAN. */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 60_000;

function throttled(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  if (Date.now() > entry.until) {
    attempts.delete(key);
    return 0;
  }
  return entry.count >= MAX_ATTEMPTS ? Math.ceil((entry.until - Date.now()) / 1000) : 0;
}

function recordFailure(key: string): void {
  const entry = attempts.get(key) ?? { count: 0, until: Date.now() + LOCK_MS };
  entry.count++;
  entry.until = Date.now() + LOCK_MS;
  attempts.set(key, entry);
}

router.get('/login', (req, res) => {
  if (req.user) {
    res.redirect(landingPath(req.user.role));
    return;
  }
  res.render('pages/login', {
    title: 'Sign in',
    error: null,
    username: '',
    next: str(req.query.next),
  });
});

router.post('/login', (req, res) => {
  const body = req.body as Record<string, unknown>;
  const username = str(body.username);
  const password = str(body.password);
  const next = str(body.next);
  const key = `${req.ip ?? 'local'}:${username.toLowerCase()}`;

  const render = (error: string, status = 401) =>
    res.status(status).render('pages/login', {
      title: 'Sign in',
        error,
      username,
      next,
    });

  const wait = throttled(key);
  if (wait) return render(`Too many failed attempts. Try again in ${wait} seconds.`, 429);
  if (!username || !password) return render('Enter your username and password.', 400);

  const user = get<User>('SELECT * FROM users WHERE username = ?', username);
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    recordFailure(key);
    return render('That username and password do not match.');
  }

  attempts.delete(key);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowTs(), user.id);
  createSession(res, user.id, req.ip ?? '');
  req.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    must_change_password: user.must_change_password,
  };
  logActivity(req, 'signed in', 'user', user.id, '');

  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : landingPath(user.role);
  res.redirect(user.must_change_password ? '/account/password' : target);
  return;
});

router.post('/logout', verifyCsrf, (req, res) => {
  if (req.user) logActivity(req, 'signed out', 'user', req.user.id, '');
  destroySession(req, res);
  res.redirect('/login');
});

// Some browsers turn a middle-click into a GET; make sign-out work either way.
router.get('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/login');
});

router.get('/account/password', (req, res) => {
  if (!req.user) {
    res.redirect('/login');
    return;
  }
  res.render('pages/change-password', {
    title: 'Change password',
    forced: Boolean(req.user.must_change_password),
    error: null,
  });
});

router.post('/account/password', verifyCsrf, (req, res) => {
  if (!req.user) {
    res.redirect('/login');
    return;
  }
  const body = req.body as Record<string, unknown>;
  const current = str(body.current_password);
  const next = str(body.new_password);
  const confirm = str(body.confirm_password);
  const forced = Boolean(req.user.must_change_password);

  const render = (error: string) =>
    res.status(400).render('pages/change-password', { title: 'Change password', forced, error });

  const user = get<User>('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!user) return render('Your account could not be loaded.');
  if (!verifyPassword(current, user.password_hash)) return render('Your current password is not correct.');
  if (next !== confirm) return render('The two new passwords do not match.');
  const weak = passwordProblem(next);
  if (weak) return render(weak);
  if (verifyPassword(next, user.password_hash)) return render('Please choose a different password from the current one.');

  run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(next), user.id);
  logActivity(req, 'changed own password', 'user', user.id, '');
  // Force every other device to sign in again with the new password.
  destroyUserSessions(user.id);
  createSession(res, user.id, req.ip ?? '');
  req.flash('success', 'Your password has been changed.');
  res.redirect(landingPath(user.role));
  return;
});

export default router;
