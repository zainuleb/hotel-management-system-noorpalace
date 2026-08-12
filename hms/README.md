# Hotel Management System

Room booking and food service for a single hotel property, covering everything in
*Hotel Management Software — Proposal v1.0*: reservations, check-in/out, the
restaurant, combined billing, staff roles, reports and backups.

It runs on **one Windows PC** and everyone else — reception, the kitchen, waiters
on tablets, the accountant — uses it through a normal browser on the hotel's own
wifi. **No internet connection is required**; nothing leaves the building.

---

## Quick start on Windows

1. Install **Node.js LTS (v24 or newer)** from <https://nodejs.org> — default options.
2. Copy this whole folder onto the front-desk PC, e.g. `C:\HotelSystem`.
3. Right-click `deploy\install-windows.ps1` → **Run with PowerShell**.
   Accept the administrator prompt so the firewall can be opened.
4. Double-click the **Hotel Management System** shortcut on the desktop.
5. Open `http://localhost:8080` and complete the short setup wizard.
6. On every other PC or tablet, open the wifi address the black window printed,
   e.g. `http://192.168.1.50:8080`, and bookmark it.

Full instructions, including printers and daily use, are in
[`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md) and
[`docs/USER-GUIDE.md`](docs/USER-GUIDE.md).

---

## What is in the box

| Area | What it does |
|---|---|
| **Rooms** | Room types with nightly rates, rooms with floor/amenities, bulk add by range (`101-108`), maintenance flag, colour-coded status board for any date |
| **Bookings** | Availability search, advance reservations, walk-ins, check-in, check-out, extend stay, change room mid-stay, cancellations, guest history |
| **Food service** | Menu by Breakfast / Lunch / Dinner / Beverages / Extras, room-service and dine-in orders, kitchen queue, KOT printing |
| **Billing** | "Add to Room" vs "Cash Now" vs complimentary, switchable after the order is placed; one combined invoice at check-out; tax and discounts; partial payments; 80/58 mm thermal receipts and A4 invoices |
| **Staff** | Admin / Front Desk / Waiter / Accountant roles, forced password change on first sign-in, full activity log. Profit and expenses are visible to Admin and Accountant only |
| **Expenses** | Ledger for salaries, utility bills, kitchen, general, laundry and maintenance — plus any other income. Editable categories, recorded against the date the money was spent |
| **Daily report** | The evening sheet: rooms occupied with numbers and rent, restaurant sale, expenses, profit or loss for the day. Printable |
| **Monthly report** | Total sale, expenses broken down by category, net profit or loss, occupancy, average room rate, and a day-by-day table. Printable |
| **Admin dashboard** | Owner's console — sale, expenses, profit and occupancy against the previous period, cash position, what needs attention, quick expense entry, best rooms, recent activity |
| **Reports** | Hub of eight: daily, monthly, year summary, sales & occupancy, room-wise performance, cash book, tax collected, outstanding. Printable, most export to CSV |
| **Inventory** | Stock for kitchen, bar, housekeeping, linen and maintenance. Suppliers, reorder levels, purchases that post straight to the expense ledger, issues, wastage and stock-take adjustments, low-stock alerts, valuation and full movement history |
| **Data** | Single-file SQLite database, automatic daily backups, one-click backup, restore with a safety copy |

---

## How the money works

* Every amount is stored as a whole number of **paisa**, never as a decimal, so
  totals cannot drift by a rounding error.
* Food orders are stored **pre-tax**. Tax is applied once — on the walk-in
  receipt, or on the guest's final bill — so "Add to Room" items can never be
  taxed twice.
* Room status (Available / Occupied / Reserved) is **derived from the bookings**,
  not stored, so the board can never disagree with the booking list. Only
  "Under Maintenance" is a stored flag.
* A stay is a half-open range: arrive on the 10th, depart on the 12th = 2 nights,
  and the room is bookable again from the 12th.
* The daily and monthly profit figures use **accrued** revenue: a room occupied on
  the 5th is the 5th's income, even though the guest checks out and pays on the
  8th. That is the only way a day's income can be set against that day's costs,
  and it is what the hotel's own paper sheet counts.
* Profit figures **exclude tax**. Tax collected on a guest's behalf is not the
  hotel's income, so counting it would overstate profit.
* A mid-stay room change splits the stay into segments, so the guest is charged
  the right rate for the nights spent in each room. Meals stay attached to the
  room they were delivered to, and still land on the one bill at check-out.
* Stock quantities are integers in **thousandths of a unit**, for the same
  reason money is in paisa. Stock on hand is never stored — it is summed from
  the movement table, so every figure can be explained line by line and a
  miscount is corrected with a recorded adjustment rather than an edit.
* A room that is taken cannot be booked. The form shows it greyed out with who
  holds it and until when, rather than hiding it and leaving staff guessing.

---

## Running it from a terminal

```bash
npm install          # once
npm run build        # compile TypeScript to dist/
npm start            # http://localhost:8080
```

Useful environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HMS_PORT` | `8080` | Port staff connect on |
| `HMS_DATA_DIR` | `./data` | Where the database and backups live |
| `HMS_HOST` | `0.0.0.0` | Set to `127.0.0.1` to allow this PC only |
| `HMS_SESSION_HOURS` | `12` | How long a sign-in lasts |
| `HMS_BACKUP_RETENTION` | `30` | Automatic backups kept before pruning |

### Checking it still works after a change

```bash
npm run build && node scripts/smoke-test.mjs
```

98 checks run against a real server and a throwaway database, covering the whole
journey from setup to a paid invoice and on to the monthly profit figure, plus
the rules that must hold (no double booking, no charging food to an empty room,
no overpaying an invoice, no taking stock below zero, no deleting a category or
stock item that has history against it, and waiters locked out of reports,
expenses and stock management).

### Demo data for showing a customer

```bash
node scripts/demo-data.mjs --user <admin-username> --password <password>
```

Fills a running system with plausible guests, stays, orders and invoices. Take a
backup first if you want to get back to an empty system afterwards.

---

## Layout

```
src/
  server.ts            Express app, middleware order, error handling
  config.ts            Ports, paths, environment
  db/                  SQLite wrapper, schema, optional starter data
  lib/                 Money, dates, sessions, permissions, validation, audit
  services/            Business rules — rooms, bookings, orders, billing, reports
  routes/              HTTP endpoints, one file per area
views/                 EJS templates: pages/ for screens, print/ for paper
public/                CSS and a little vanilla JS — no build step, no framework
deploy/                Windows installer and start scripts
scripts/               Smoke test and demo data
docs/                  Install guide and staff user guide
```

The business rules live in `services/` and are the part worth reading first.
Routes only validate input and render; templates contain no logic beyond display.
