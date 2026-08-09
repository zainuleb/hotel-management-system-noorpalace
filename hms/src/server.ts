import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { initSchema, scalar } from './db/index.js';
import { cookies, loadSession, purgeExpiredSessions, requireLogin, verifyCsrf } from './lib/session.js';
import { ValidationError } from './lib/validate.js';
import { formatDate, formatDateTime, nowTs, today } from './lib/dates.js';
import { formatMinor, toInputValue, toMajor } from './lib/money.js';
import { getSettings } from './services/settings.service.js';
import { startBackupSchedule } from './services/backup.service.js';
import * as domain from './types/domain.js';

import authRoutes from './routes/auth.routes.js';
import setupRoutes from './routes/setup.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import roomRoutes from './routes/rooms.routes.js';
import guestRoutes from './routes/guests.routes.js';
import bookingRoutes from './routes/bookings.routes.js';
import menuRoutes from './routes/menu.routes.js';
import orderRoutes from './routes/orders.routes.js';
import billingRoutes from './routes/billing.routes.js';
import reportRoutes from './routes/reports.routes.js';
import expenseRoutes from './routes/expenses.routes.js';
import adminDashboardRoutes from './routes/admin-dashboard.routes.js';
import adminRoutes from './routes/admin.routes.js';

export function createApp(): express.Express {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', config.viewsDir);
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  // `extended: false` keeps `lines[0][qty]` as a flat key, which is what
  // lib/validate.collectRows() parses. Do not switch this to `true`.
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/assets', express.static(config.publicDir, { maxAge: config.isProduction ? '7d' : 0 }));
  app.use(cookies);

  // Helpers every template can rely on.
  app.use((req, res, next) => {
    res.locals.hotel = getSettings();
    res.locals.fmt = formatMinor;
    res.locals.money = formatMinor;
    res.locals.majorValue = toInputValue;
    res.locals.toMajor = toMajor;
    res.locals.fmtDate = formatDate;
    res.locals.fmtDateTime = formatDateTime;
    res.locals.today = today();
    res.locals.nowStamp = nowTs();
    res.locals.domain = domain;
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    res.locals.title = 'Hotel Management';
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use(loadSession);

  // Before any user exists the whole app funnels into the setup wizard.
  app.use((req, res, next) => {
    const installed = scalar('SELECT COUNT(*) FROM users');
    if (!installed && !req.path.startsWith('/setup') && !req.path.startsWith('/assets')) {
      res.redirect('/setup');
      return;
    }
    if (installed && req.path.startsWith('/setup')) {
      res.redirect('/');
      return;
    }
    next();
  });

  app.use(setupRoutes);
  app.use(authRoutes);
  app.use(requireLogin);
  app.use(verifyCsrf);

  app.use(dashboardRoutes);
  app.use(roomRoutes);
  app.use(guestRoutes);
  app.use(bookingRoutes);
  app.use(menuRoutes);
  app.use(orderRoutes);
  app.use(billingRoutes);
  app.use(reportRoutes);
  app.use(expenseRoutes);
  app.use(adminDashboardRoutes);
  app.use(adminRoutes);

  app.use((req, res) => {
    res.status(404).render('pages/error', {
      title: 'Not found',
      heading: 'Page not found',
      message: `There is nothing at ${req.path}.`,
    });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ValidationError) {
      req.flash?.('error', err.message);
      const back = req.get('referer');
      res.redirect(back && !back.includes('/login') ? back : '/');
      return;
    }
    console.error('[hms] unhandled error:', err);
    res.status(500).render('pages/error', {
      title: 'Something went wrong',
      heading: 'Something went wrong',
      message: config.isProduction
        ? 'The action could not be completed. Please try again, and tell your administrator if it keeps happening.'
        : String((err as Error)?.stack ?? err),
    });
  });

  return app;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

function main(): void {
  initSchema();
  purgeExpiredSessions();
  startBackupSchedule();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const hotel = getSettings().hotel_name;
    console.log('');
    console.log(`  ${hotel} — Hotel Management System`);
    console.log('  ------------------------------------------------');
    console.log(`  On this PC          http://localhost:${config.port}`);
    for (const ip of lanAddresses()) {
      console.log(`  On the hotel wifi   http://${ip}:${config.port}`);
    }
    console.log(`  Database            ${path.relative(process.cwd(), config.dataDir)}`);
    console.log('');
    console.log('  Keep this window open. Closing it stops the system.');
    console.log('');
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) main();
