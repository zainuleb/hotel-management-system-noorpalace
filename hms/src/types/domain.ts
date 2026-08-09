export type Role = 'admin' | 'reception' | 'waiter' | 'accountant';

export const ROLES: Role[] = ['admin', 'reception', 'waiter', 'accountant'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  reception: 'Front Desk / Receptionist',
  waiter: 'Restaurant / Waiter',
  accountant: 'Accountant',
};

export type BookingStatus = 'reserved' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show';
export type PackageType = 'room_only' | 'room_meals' | 'dine_in_stay';
export type MealType = 'breakfast' | 'lunch' | 'dinner';
export type MenuCategory = MealType | 'beverages' | 'extras';
export type OrderType = 'room_service' | 'dine_in';
export type BillingMode = 'add_to_room' | 'cash_now' | 'complimentary';
export type OrderStatus = 'open' | 'served' | 'settled' | 'cancelled';
export type InvoiceKind = 'stay' | 'food_sale';
export type InvoiceStatus = 'unpaid' | 'partial' | 'paid' | 'void';
export type PaymentMode = 'cash' | 'card' | 'bank_transfer' | 'online';
/** Derived, never stored (except maintenance). */
export type RoomStatus = 'available' | 'occupied' | 'reserved' | 'maintenance';

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  reserved: 'Reserved',
  checked_in: 'Checked In',
  checked_out: 'Checked Out',
  cancelled: 'Cancelled',
  no_show: 'No Show',
};

export const PACKAGE_LABELS: Record<PackageType, string> = {
  room_only: 'Room only',
  room_meals: 'Room + Meals',
  dine_in_stay: 'Dine-in stay',
};

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

export const MENU_CATEGORY_LABELS: Record<MenuCategory, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  beverages: 'Beverages',
  extras: 'Extras',
};

export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  add_to_room: 'Add to Room',
  cash_now: 'Cash Now',
  complimentary: 'Complimentary',
};

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  online: 'Online',
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  open: 'Open',
  served: 'Served',
  settled: 'Settled',
  cancelled: 'Cancelled',
};

export const ROOM_STATUS_LABELS: Record<RoomStatus, string> = {
  available: 'Available',
  occupied: 'Occupied',
  reserved: 'Reserved',
  maintenance: 'Under Maintenance',
};

export interface User {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: Role;
  is_active: number;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
}

export interface RoomType {
  id: number;
  name: string;
  base_rate: number;
  capacity: number;
  description: string;
  is_active: number;
}

export interface Room {
  id: number;
  number: string;
  room_type_id: number;
  floor: string;
  capacity: number;
  amenities: string;
  is_out_of_service: number;
  maintenance_note: string;
  is_active: number;
  sort_order: number;
}

export interface RoomWithType extends Room {
  type_name: string;
  base_rate: number;
  type_capacity: number;
}

export interface Guest {
  id: number;
  full_name: string;
  id_number: string;
  phone: string;
  email: string;
  address: string;
  nationality: string;
  notes: string;
  created_at: string;
}

export interface Booking {
  id: number;
  code: string;
  guest_id: number;
  status: BookingStatus;
  package: PackageType;
  arrival_date: string;
  departure_date: string;
  adults: number;
  children: number;
  discount_minor: number;
  notes: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface BookingRoom {
  id: number;
  booking_id: number;
  room_id: number;
  from_date: string;
  to_date: string;
  rate_minor: number;
  created_at: string;
}

export interface MenuItem {
  id: number;
  name: string;
  category: MenuCategory;
  price_minor: number;
  is_available: number;
  description: string;
  sort_order: number;
  created_at: string;
}

export interface Order {
  id: number;
  code: string;
  order_type: OrderType;
  booking_id: number | null;
  room_id: number | null;
  table_no: string;
  guest_name: string;
  meal_type: MealType;
  billing_mode: BillingMode;
  status: OrderStatus;
  discount_minor: number;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  invoice_id: number | null;
  notes: string;
  kot_printed_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  menu_item_id: number | null;
  name_snapshot: string;
  unit_minor: number;
  qty: number;
  line_minor: number;
  note: string;
}

export interface Invoice {
  id: number;
  number: string;
  kind: InvoiceKind;
  booking_id: number | null;
  guest_name: string;
  guest_phone: string;
  room_charges_minor: number;
  food_charges_minor: number;
  discount_minor: number;
  tax_percent: number;
  tax_minor: number;
  total_minor: number;
  status: InvoiceStatus;
  notes: string;
  created_by: number | null;
  created_at: string;
  voided_at: string | null;
}

export interface InvoiceLine {
  id: number;
  invoice_id: number;
  section: 'room' | MealType | 'other';
  description: string;
  qty: number;
  unit_minor: number;
  amount_minor: number;
  sort_order: number;
}

export interface Payment {
  id: number;
  invoice_id: number;
  amount_minor: number;
  mode: PaymentMode;
  reference: string;
  note: string;
  received_by: number | null;
  created_at: string;
}

/* ------------------------------------------------------ expenses & income */

export type LedgerKind = 'expense' | 'income';

export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  expense: 'Expense',
  income: 'Other income',
};

export interface ExpenseCategory {
  id: number;
  name: string;
  kind: LedgerKind;
  sort_order: number;
  is_active: number;
}

export interface Expense {
  id: number;
  entry_date: string;
  category_id: number;
  kind: LedgerKind;
  description: string;
  paid_to: string;
  amount_minor: number;
  payment_mode: PaymentMode;
  reference: string;
  notes: string;
  created_by: number | null;
  created_at: string;
}
