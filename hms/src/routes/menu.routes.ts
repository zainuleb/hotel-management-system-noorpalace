import { Router } from 'express';
import { run, scalar } from '../db/index.js';
import { requirePermission } from '../lib/session.js';
import { toMinor } from '../lib/money.js';
import { logActivity } from '../lib/activity.js';
import { bool, int, oneOf, positiveInt, requiredStr, str, ValidationError } from '../lib/validate.js';
import { getMenuItem, listMenuItems } from '../services/orders.service.js';
import type { MenuCategory } from '../types/domain.js';

const router = Router();

const CATEGORIES: MenuCategory[] = ['breakfast', 'lunch', 'dinner', 'beverages', 'extras'];

router.get('/menu', requirePermission('menu.view'), (req, res) => {
  const category = str(req.query.category) || 'all';
  const items = listMenuItems({ category: category as MenuCategory | 'all' });
  res.render('pages/menu', {
    title: 'Menu',
    items,
    category,
    categories: CATEGORIES,
    editing: getMenuItem(int(req.query.edit, 0)) ?? null,
  });
});

router.post('/menu', requirePermission('menu.manage'), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const id = int(body.id, 0);
  const name = requiredStr(body.name, 'Item name', 80);
  const category = oneOf(body.category, CATEGORIES, 'Category');
  const price = toMinor(body.price);
  if (price < 0) throw new ValidationError('Price cannot be negative.');
  const available = bool(body.is_available);
  const description = str(body.description);

  if (id) {
    run(
      'UPDATE menu_items SET name = ?, category = ?, price_minor = ?, is_available = ?, description = ? WHERE id = ?',
      name,
      category,
      price,
      available,
      description,
      id,
    );
    logActivity(req, 'updated menu item', 'menu_item', id, name);
    req.flash('success', `"${name}" updated.`);
  } else {
    const created = run(
      'INSERT INTO menu_items (name, category, price_minor, is_available, description, sort_order) VALUES (?,?,?,?,?,?)',
      name,
      category,
      price,
      1,
      description,
      scalar('SELECT COALESCE(MAX(sort_order),0) + 1 FROM menu_items'),
    );
    logActivity(req, 'added menu item', 'menu_item', created.lastInsertRowid, name);
    req.flash('success', `"${name}" added to the ${category} menu.`);
  }
  res.redirect(`/menu?category=${category}`);
});

router.post('/menu/:id/availability', requirePermission('menu.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'Menu item');
  const item = getMenuItem(id);
  if (!item) throw new ValidationError('Menu item not found.');
  const available = item.is_available ? 0 : 1;
  run('UPDATE menu_items SET is_available = ? WHERE id = ?', available, id);
  logActivity(req, available ? 'marked item available' : 'marked item unavailable', 'menu_item', id, item.name);
  res.redirect(req.get('referer') ?? '/menu');
});

router.post('/menu/:id/delete', requirePermission('menu.manage'), (req, res) => {
  const id = positiveInt(req.params.id, 'Menu item');
  const item = getMenuItem(id);
  if (!item) throw new ValidationError('Menu item not found.');
  const used = scalar('SELECT COUNT(*) FROM order_items WHERE menu_item_id = ?', id);
  if (used) {
    throw new ValidationError(
      `"${item.name}" appears on ${used} past order, so it cannot be deleted. Mark it unavailable instead. It will disappear from the ordering screen.`,
    );
  }
  run('DELETE FROM menu_items WHERE id = ?', id);
  logActivity(req, 'deleted menu item', 'menu_item', id, item.name);
  req.flash('success', `"${item.name}" deleted.`);
  res.redirect('/menu');
});

export default router;
