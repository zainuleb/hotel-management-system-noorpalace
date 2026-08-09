import { Router } from 'express';
import { all, get, run, scalar } from '../db/index.js';
import { requirePermission } from '../lib/session.js';
import { hashPassword, passwordProblem, randomToken } from '../lib/security.js';
import { destroyUserSessions } from '../lib/session.js';
import { logActivity, recentActivity } from '../lib/activity.js';
import { nowTs } from '../lib/dates.js';
import { bool, oneOf, positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import { clearSettingsCache, getSettings, saveSettings } from '../services/settings.service.js';
import {
  backupPath,
  createBackup,
  deleteBackup,
  formatBytes,
  listBackups,
  restoreBackup,
} from '../services/backup.service.js';
import { ROLES, type Role, type User } from '../types/domain.js';

const router = Router();

/* ------------------------------------------------------------------ users */

router.get('/admin/users', requirePermission('users.manage'), (_req, res) => {
  res.render('pages/users', {
    title: 'Staff & Logins',
    users: all<User>('SELECT * FROM users ORDER BY role, username'),
    roles: ROLES,
  });
});

router.post('/admin/users', requirePermission('users.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const username = requiredStr(body.username, 'Username', 40);
  const fullName = requiredStr(body.full_name, 'Full name', 120);
  const role = oneOf(body.role, ROLES, 'Role') as Role;
  const password = str(body.password);

  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new ValidationError('Username can only contain letters, numbers, dots, dashes and underscores.');
  }
  if (scalar('SELECT COUNT(*) FROM users WHERE username = ?', username)) {
    throw new ValidationError(`The username "${username}" is already taken.`);
  }
  const weak = passwordProblem(password);
  if (weak) throw new ValidationError(weak);

  const created = run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, must_change_password, created_at)
     VALUES (?,?,?,?,1,1,?)`,
    username,
    hashPassword(password),
    fullName,
    role,
    nowTs(),
  );
  logActivity(req, 'created user', 'user', created.lastInsertRowid, `${username} (${role})`);
  req.flash('success', `Login created for ${fullName}. They will be asked to set their own password at first sign-in.`);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id', requirePermission('users.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'User');
  const body = req.body as Record<string, unknown>;
  const user = get<User>('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new ValidationError('User not found.');

  const fullName = requiredStr(body.full_name, 'Full name', 120);
  const role = oneOf(body.role, ROLES, 'Role') as Role;
  const active = bool(body.is_active);

  // Never let the last administrator lock everybody out.
  const otherAdmins = scalar(
    `SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?`,
    id,
  );
  if (user.role === 'admin' && (role !== 'admin' || !active) && otherAdmins === 0) {
    throw new ValidationError('This is the only active administrator. Give another user the admin role first.');
  }

  run('UPDATE users SET full_name = ?, role = ?, is_active = ? WHERE id = ?', fullName, role, active, id);
  if (!active) destroyUserSessions(id);
  logActivity(req, 'updated user', 'user', id, `${user.username} → ${role}${active ? '' : ' (disabled)'}`);
  req.flash('success', `${fullName} updated.`);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/reset-password', requirePermission('users.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'User');
  const user = get<User>('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new ValidationError('User not found.');

  const temporary = `${randomToken(6).replace(/[^a-zA-Z0-9]/g, '')}A1`.slice(0, 12);
  run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(temporary), id);
  destroyUserSessions(id);
  logActivity(req, 'reset password', 'user', id, user.username);
  req.flash(
    'info',
    `Temporary password for ${user.username}: ${temporary} — give it to them now, it is not shown again. They must change it at first sign-in.`,
  );
  res.redirect('/admin/users');
});

/* --------------------------------------------------------------- settings */

router.get('/admin/settings', requirePermission('settings.manage'), (_req, res) => {
  res.render('pages/settings', { title: 'Hotel Settings', settings: getSettings() });
});

router.post('/admin/settings', requirePermission('settings.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const taxPercent = Number.parseFloat(str(body.tax_percent) || '0');
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
    throw new ValidationError('Tax percent must be a number between 0 and 100.');
  }

  saveSettings({
    hotel_name: requiredStr(body.hotel_name, 'Hotel name', 120),
    hotel_address: str(body.hotel_address),
    hotel_phone: str(body.hotel_phone),
    hotel_email: str(body.hotel_email),
    currency_symbol: str(body.currency_symbol) || 'Rs.',
    currency_code: str(body.currency_code) || 'PKR',
    tax_percent: String(taxPercent),
    tax_label: str(body.tax_label) || 'Tax',
    invoice_prefix: str(body.invoice_prefix) || 'INV',
    booking_prefix: str(body.booking_prefix) || 'BK',
    order_prefix: str(body.order_prefix) || 'ORD',
    receipt_footer: str(body.receipt_footer),
    thermal_width_mm: str(body.thermal_width_mm) === '58' ? '58' : '80',
    checkin_time: str(body.checkin_time) || '14:00',
    checkout_time: str(body.checkout_time) || '12:00',
    package_includes_breakfast: bool(body.package_includes_breakfast) ? '1' : '0',
  });
  clearSettingsCache();
  logActivity(req, 'updated settings', 'system', 0, '');
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

/* ---------------------------------------------------------------- backups */

router.get('/admin/backup', requirePermission('backup.manage'), (_req, res) => {
  res.render('pages/backup', {
    title: 'Backup & Restore',
    backups: listBackups(),
    formatBytes,
  });
});

router.post('/admin/backup', requirePermission('backup.manage'), (req, res) => {
  const file = createBackup('manual');
  logActivity(req, 'created backup', 'system', 0, file.name);
  req.flash('success', `Backup created (${formatBytes(file.size_bytes)}).`);
  res.redirect('/admin/backup');
});

router.get('/admin/backup/download', requirePermission('backup.manage'), (req, res) => {
  const name = str(req.query.name);
  const full = backupPath(name);
  res.download(full);
});

router.post('/admin/backup/restore', requirePermission('backup.manage'), (req, res) => {
  const name = str((req.body as Record<string, unknown>).name);
  const confirm = str((req.body as Record<string, unknown>).confirm);
  if (confirm !== 'RESTORE') {
    throw new ValidationError('Type RESTORE in the confirmation box to replace the live database.');
  }
  const result = restoreBackup(name);
  clearSettingsCache();
  logActivity(req, 'restored backup', 'system', 0, `${result.restored} (safety copy ${result.safetyCopy})`);
  req.flash(
    'success',
    `Restored from ${result.restored}. A copy of the previous database was saved as ${result.safetyCopy}.`,
  );
  res.redirect('/admin/backup');
});

router.post('/admin/backup/delete', requirePermission('backup.manage'), (req, res) => {
  const name = str((req.body as Record<string, unknown>).name);
  deleteBackup(name);
  logActivity(req, 'deleted backup', 'system', 0, name);
  req.flash('success', 'Backup deleted.');
  res.redirect('/admin/backup');
});

/* ----------------------------------------------------------- activity log */

router.get('/admin/activity', requirePermission('activity.view'), (req, res) => {
  const entity = str(req.query.entity);
  const entityId = str(req.query.entity_id);
  res.render('pages/activity', {
    title: 'Activity Log',
    entries: entity && entityId ? recentActivity(300, entity, entityId) : recentActivity(300),
    entity,
    entityId,
  });
});

/** Quick health view for whoever supports the install. */
router.get('/admin/system', requirePermission('settings.manage'), (_req, res) => {
  const backups = listBackups();
  res.render('pages/system', {
    title: 'System',
    stats: {
      rooms: scalar('SELECT COUNT(*) FROM rooms'),
      bookings: scalar('SELECT COUNT(*) FROM bookings'),
      guests: scalar('SELECT COUNT(*) FROM guests'),
      orders: scalar('SELECT COUNT(*) FROM orders'),
      invoices: scalar('SELECT COUNT(*) FROM invoices'),
      users: scalar('SELECT COUNT(*) FROM users'),
    },
    dbSize: formatBytes(dbSizeBytes()),
    lastBackup: backups[0] ?? null,
    node: process.version,
    uptimeHours: (process.uptime() / 3600).toFixed(1),
  });
});

function dbSizeBytes(): number {
  try {
    const pageCount = scalar('PRAGMA page_count');
    const pageSize = scalar('PRAGMA page_size');
    return pageCount * pageSize;
  } catch {
    return 0;
  }
}

export default router;
