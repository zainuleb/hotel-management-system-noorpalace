/**
 * Full database schema.
 *
 * Conventions used throughout:
 *  - Money is stored as INTEGER in *minor units* (paisa / cents). Never floats.
 *    Use lib/money.ts to convert to and from what the user types.
 *  - Dates are 'YYYY-MM-DD' strings in hotel-local time.
 *  - Timestamps are 'YYYY-MM-DD HH:MM:SS' strings in hotel-local time
 *    (datetime('now','localtime')), NOT UTC, so that "today's revenue" means
 *    today at the hotel.
 *  - Room status (Available / Occupied / Reserved) is *derived* from bookings
 *    for a given date rather than stored, so it can never drift out of sync.
 *    Only "Under Maintenance" is a stored flag, because nothing else implies it.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','reception','waiter','accountant')),
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login_at        TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS room_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  base_rate   INTEGER NOT NULL DEFAULT 0,
  capacity    INTEGER NOT NULL DEFAULT 2,
  description TEXT NOT NULL DEFAULT '',
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rooms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  room_type_id      INTEGER NOT NULL REFERENCES room_types(id),
  floor             TEXT NOT NULL DEFAULT '',
  capacity          INTEGER NOT NULL DEFAULT 0,
  amenities         TEXT NOT NULL DEFAULT '',
  is_out_of_service INTEGER NOT NULL DEFAULT 0,
  maintenance_note  TEXT NOT NULL DEFAULT '',
  is_active         INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rooms_type ON rooms(room_type_id);

CREATE TABLE IF NOT EXISTS guests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  id_number   TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  nationality TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_guests_name  ON guests(full_name);
CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests(phone);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  guest_id        INTEGER NOT NULL REFERENCES guests(id),
  status          TEXT NOT NULL CHECK (status IN ('reserved','checked_in','checked_out','cancelled','no_show')),
  package         TEXT NOT NULL DEFAULT 'room_only' CHECK (package IN ('room_only','room_meals','dine_in_stay')),
  arrival_date    TEXT NOT NULL,
  departure_date  TEXT NOT NULL,
  adults          INTEGER NOT NULL DEFAULT 1,
  children        INTEGER NOT NULL DEFAULT 0,
  discount_minor  INTEGER NOT NULL DEFAULT 0,
  notes           TEXT NOT NULL DEFAULT '',
  checked_in_at   TEXT,
  checked_out_at  TEXT,
  cancelled_at    TEXT,
  cancel_reason   TEXT NOT NULL DEFAULT '',
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_dates  ON bookings(arrival_date, departure_date);
CREATE INDEX IF NOT EXISTS idx_bookings_guest  ON bookings(guest_id);

-- One row per contiguous occupancy of one room. A mid-stay room change closes
-- the current segment and opens a new one, so nightly charges stay correct.
CREATE TABLE IF NOT EXISTS booking_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  room_id    INTEGER NOT NULL REFERENCES rooms(id),
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  rate_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_booking_rooms_booking ON booking_rooms(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_rooms_room    ON booking_rooms(room_id, from_date, to_date);

CREATE TABLE IF NOT EXISTS menu_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('breakfast','lunch','dinner','beverages','extras')),
  price_minor  INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  description  TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_menu_category ON menu_items(category);

CREATE TABLE IF NOT EXISTS invoices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  number             TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('stay','food_sale')),
  booking_id         INTEGER REFERENCES bookings(id),
  guest_name         TEXT NOT NULL DEFAULT '',
  guest_phone        TEXT NOT NULL DEFAULT '',
  room_charges_minor INTEGER NOT NULL DEFAULT 0,
  food_charges_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor     INTEGER NOT NULL DEFAULT 0,
  tax_percent        REAL    NOT NULL DEFAULT 0,
  tax_minor          INTEGER NOT NULL DEFAULT 0,
  total_minor        INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('unpaid','partial','paid','void')),
  notes              TEXT NOT NULL DEFAULT '',
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  voided_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_booking ON invoices(booking_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  section      TEXT NOT NULL CHECK (section IN ('room','breakfast','lunch','dinner','other')),
  description  TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 1,
  unit_minor   INTEGER NOT NULL DEFAULT 0,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  order_type     TEXT NOT NULL CHECK (order_type IN ('room_service','dine_in')),
  booking_id     INTEGER REFERENCES bookings(id),
  room_id        INTEGER REFERENCES rooms(id),
  table_no       TEXT NOT NULL DEFAULT '',
  guest_name     TEXT NOT NULL DEFAULT '',
  meal_type      TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner')),
  billing_mode   TEXT NOT NULL CHECK (billing_mode IN ('add_to_room','cash_now','complimentary')),
  status         TEXT NOT NULL CHECK (status IN ('open','served','settled','cancelled')),
  discount_minor INTEGER NOT NULL DEFAULT 0,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor      INTEGER NOT NULL DEFAULT 0,
  total_minor    INTEGER NOT NULL DEFAULT 0,
  invoice_id     INTEGER REFERENCES invoices(id),
  notes          TEXT NOT NULL DEFAULT '',
  kot_printed_at TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_orders_booking ON orders(booking_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_billing ON orders(billing_mode);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id  INTEGER REFERENCES menu_items(id),
  name_snapshot TEXT NOT NULL,
  unit_minor    INTEGER NOT NULL DEFAULT 0,
  qty           INTEGER NOT NULL DEFAULT 1,
  line_minor    INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_minor  INTEGER NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('cash','card','bank_transfer','online')),
  reference     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  received_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- Money going out (and any income that is not a room or a meal). This is what
-- turns the revenue figures into a real profit and loss.
CREATE TABLE IF NOT EXISTS expense_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date   TEXT NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES expense_categories(id),
  kind         TEXT NOT NULL CHECK (kind IN ('expense','income')),
  description  TEXT NOT NULL DEFAULT '',
  paid_to      TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL,
  payment_mode TEXT NOT NULL DEFAULT 'cash' CHECK (payment_mode IN ('cash','card','bank_transfer','online')),
  reference    TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(entry_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_entity  ON activity_log(entity, entity_id);
`;
