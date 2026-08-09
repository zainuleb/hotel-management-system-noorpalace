import type { NextFunction, Request, Response } from 'express';
import { all, get, run } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, safeEquals } from './security.js';
import { nowTs } from './dates.js';
import { can, type Permission } from './permissions.js';
import type { Role } from '../types/domain.js';

const COOKIE_NAME = 'hms_sid';
const FLASH_COOKIE = 'hms_flash';

interface SessionRow {
  id: string;
  user_id: number;
  csrf_token: string;
  expires_at: string;
}

interface SessionUser {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  must_change_password: number;
  is_active: number;
}

function expiryTs(): string {
  const d = new Date(Date.now() + config.sessionHours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createSession(res: Response, userId: number, ip: string): string {
  const id = randomToken(32);
  const csrf = randomToken(24);
  run(
    `INSERT INTO sessions (id, user_id, csrf_token, ip, created_at, expires_at) VALUES (?,?,?,?,?,?)`,
    id,
    userId,
    csrf,
    ip,
    nowTs(),
    expiryTs(),
  );
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionHours * 3_600_000,
  });
  return id;
}

export function destroySession(req: Request, res: Response): void {
  const id = req.cookies?.[COOKIE_NAME];
  if (id) run('DELETE FROM sessions WHERE id = ?', id);
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Removes expired rows so the table does not grow without bound. */
export function purgeExpiredSessions(): void {
  run(`DELETE FROM sessions WHERE expires_at < ?`, nowTs());
}

/** Signs every session belonging to a user out — used when a login is disabled. */
export function destroyUserSessions(userId: number): void {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function activeSessionCount(userId: number): number {
  return all('SELECT id FROM sessions WHERE user_id = ? AND expires_at >= ?', userId, nowTs()).length;
}

/**
 * Minimal cookie parser — avoids pulling in cookie-parser for two cookies.
 */
export function cookies(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.cookie;
  const jar: Record<string, string> = {};
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!key) continue;
      try {
        jar[key] = decodeURIComponent(value);
      } catch {
        jar[key] = value;
      }
    }
  }
  (req as Request & { cookies: Record<string, string> }).cookies = jar;
  next();
}

/** Reads the session cookie and attaches `req.user` when it is valid. */
export function loadSession(req: Request, res: Response, next: NextFunction): void {
  const id = req.cookies?.[COOKIE_NAME];
  if (id) {
    const session = get<SessionRow>('SELECT id, user_id, csrf_token, expires_at FROM sessions WHERE id = ?', id);
    if (session && session.expires_at >= nowTs()) {
      const user = get<SessionUser>(
        'SELECT id, username, full_name, role, must_change_password, is_active FROM users WHERE id = ?',
        session.user_id,
      );
      if (user && user.is_active) {
        req.user = {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          role: user.role,
          must_change_password: user.must_change_password,
        };
        req.sessionId = session.id;
        req.csrfToken = session.csrf_token;
      } else {
        // Login was disabled or deleted while the cookie was still alive.
        run('DELETE FROM sessions WHERE id = ?', id);
        res.clearCookie(COOKIE_NAME, { path: '/' });
      }
    } else if (session) {
      run('DELETE FROM sessions WHERE id = ?', id);
      res.clearCookie(COOKIE_NAME, { path: '/' });
    }
  }

  // Flash messages survive exactly one redirect.
  const raw = req.cookies?.[FLASH_COOKIE];
  let flashes: { type: string; message: string }[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) flashes = parsed as { type: string; message: string }[];
    } catch {
      /* malformed cookie — ignore */
    }
    res.clearCookie(FLASH_COOKIE, { path: '/' });
  }

  const pending: { type: string; message: string }[] = [];
  req.flash = (type, message) => {
    pending.push({ type, message });
    res.cookie(FLASH_COOKIE, JSON.stringify(pending), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 30_000,
    });
  };

  res.locals.flashes = flashes;
  res.locals.currentUser = req.user ?? null;
  res.locals.csrfToken = req.csrfToken ?? '';
  res.locals.can = (permission: Permission) => can(req.user?.role, permission);
  next();
}

const PUBLIC_PATHS = new Set(['/login', '/logout', '/healthz']);

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/assets')) return next();
  if (!req.user) {
    if (req.method !== 'GET') {
      res.status(401).send('Your session expired. Please sign in again.');
      return;
    }
    const target = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?next=${target}`);
    return;
  }
  // Force a password change before anything else can be done.
  if (req.user.must_change_password && req.path !== '/account/password') {
    if (req.method === 'GET') {
      res.redirect('/account/password');
      return;
    }
  }
  next();
}

/** Route guard: `app.get('/rooms', requirePermission('rooms.view'), ...)` */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.redirect('/login');
      return;
    }
    if (!can(req.user.role, permission)) {
      res.status(403).render('pages/error', {
        title: 'Not allowed',
        heading: 'You do not have access to this',
        message: 'Your role does not include this action. Ask an administrator if you need it.',
      });
      return;
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rejects state-changing requests that do not carry the session's CSRF token. */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.user) return next(); // login POST is handled separately
  const supplied = String(
    (req.body as Record<string, unknown> | undefined)?._csrf ?? req.headers['x-csrf-token'] ?? '',
  );
  if (!req.csrfToken || !supplied || !safeEquals(supplied, req.csrfToken)) {
    res.status(403).send('Security check failed. Please reload the page and try again.');
    return;
  }
  next();
}
