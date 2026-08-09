import type { Role } from '../types/domain.js';

/**
 * Every guarded action in the system. Routes ask for a permission, never for a
 * role, so changing who can do what is a change to the ROLE_PERMISSIONS table
 * below and nothing else.
 */
export type Permission =
  | 'dashboard.view'
  | 'rooms.view'
  | 'rooms.manage'
  | 'guests.view'
  | 'guests.manage'
  | 'bookings.view'
  | 'bookings.create'
  | 'bookings.edit'
  | 'bookings.cancel'
  | 'bookings.checkin'
  | 'bookings.checkout'
  | 'menu.view'
  | 'menu.manage'
  | 'orders.view'
  | 'orders.create'
  | 'orders.edit'
  | 'orders.cancel'
  | 'billing.view'
  | 'billing.create'
  | 'billing.payment'
  | 'billing.void'
  | 'reports.view'
  | 'reports.pnl'
  | 'expenses.view'
  | 'expenses.manage'
  | 'activity.view'
  | 'users.manage'
  | 'settings.manage'
  | 'backup.manage';

const RECEPTION: Permission[] = [
  'dashboard.view',
  'rooms.view',
  'guests.view',
  'guests.manage',
  'bookings.view',
  'bookings.create',
  'bookings.edit',
  'bookings.cancel',
  'bookings.checkin',
  'bookings.checkout',
  'menu.view',
  'orders.view',
  'orders.create',
  'orders.edit',
  'orders.cancel',
  'billing.view',
  'billing.create',
  'billing.payment',
  'reports.view',
];

const WAITER: Permission[] = [
  'dashboard.view',
  'rooms.view',
  'menu.view',
  'orders.view',
  'orders.create',
  'orders.edit',
  'orders.cancel',
];

const ACCOUNTANT: Permission[] = [
  'dashboard.view',
  'rooms.view',
  'guests.view',
  'bookings.view',
  'orders.view',
  'menu.view',
  'billing.view',
  'billing.create',
  'billing.payment',
  'billing.void',
  'reports.view',
  'reports.pnl',
  'expenses.view',
  'expenses.manage',
  'activity.view',
];

const ALL: Permission[] = [
  'dashboard.view',
  'rooms.view',
  'rooms.manage',
  'guests.view',
  'guests.manage',
  'bookings.view',
  'bookings.create',
  'bookings.edit',
  'bookings.cancel',
  'bookings.checkin',
  'bookings.checkout',
  'menu.view',
  'menu.manage',
  'orders.view',
  'orders.create',
  'orders.edit',
  'orders.cancel',
  'billing.view',
  'billing.create',
  'billing.payment',
  'billing.void',
  'reports.view',
  'reports.pnl',
  'expenses.view',
  'expenses.manage',
  'activity.view',
  'users.manage',
  'settings.manage',
  'backup.manage',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ALL),
  reception: new Set(RECEPTION),
  waiter: new Set(WAITER),
  accountant: new Set(ACCOUNTANT),
};

export function can(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** The page each role lands on after login. */
export function landingPath(role: Role): string {
  return role === 'waiter' ? '/orders' : '/';
}
