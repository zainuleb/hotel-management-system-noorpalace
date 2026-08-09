# Staff guide

Everything below is done in a browser. Front desk, restaurant and accounts all
use the same address; what you see depends on your role.

---

## Signing in

Open the bookmark, enter your username and password. The first time, you will be
asked to replace the temporary password with one of your own.

Sign out from the bottom of the left-hand menu when you leave the desk. On a
tablet, tap **☰** at the top to show the menu.

---

## The dashboard

The first screen answers "what is happening right now":

* Revenue billed today and how much of it has actually been collected
* Occupancy, with a bar
* Who is arriving and who is departing today, with **Check in** / **Check out**
  buttons right there
* The room grid — **green** free, **red** occupied, **amber** reserved,
  **grey** under maintenance. Click a room to open the guest, or to start a
  booking if it is free.
* A yellow bar if food has been charged to rooms and not yet billed

---

## Taking a booking

**Bookings → New booking**, or click a green room on the grid.

1. Set the arrival and departure dates. The room list refreshes to show only the
   rooms free for the *whole* stay — a room already taken for one night in the
   middle will not appear.
2. Pick the room. The nightly rate fills in from the room type; type over it for
   a negotiated rate.
3. **Booking type** — "Room + Meals" makes this guest's breakfast complimentary
   automatically.
4. Start typing the guest's name. If they have stayed before, click their name to
   reuse the record and keep their history together.
5. If the guest is standing at the desk right now, tick **Walk-in — check this
   guest in right now**. Leave it unticked for an advance reservation.

The summary line under the dates shows the nights and room charge as you type.

### Checking a guest in

Dashboard → **Check in** next to their name, or open the booking and use the
button. A booking cannot be checked in before its arrival date.

### Extending a stay

Open the booking → **Extend stay** → new departure date. If someone else has
already booked that room for those nights, the system says who and until when,
so you can move the guest instead.

### Moving a guest to another room

Open the booking → **Change room from today**. Nights already spent stay charged
at the old room's rate; from today the new rate applies. The bill shows both
lines separately.

### Cancelling

Only a reservation can be cancelled. A guest who has already checked in must be
checked out instead — that is what produces the bill.

---

## Food orders

**Orders → + Room service** or **+ Dine-in**, or from a checked-in booking.

1. Choose room service (pick the room) or dine-in (type the table number).
2. Choose the meal — Breakfast, Lunch or Dinner. It is pre-selected from the
   time of day.
3. Choose how it is paid:
   * **Add to Room** — goes onto the guest's final bill at check-out. Only
     rooms with a guest actually checked in can be chosen.
   * **Cash Now** — the customer pays straight away and you print a receipt.
   * **Complimentary** — no charge.
4. Tap items on the menu to add them; use **+ / −** to change quantities.
5. **Save order**, then **Print KOT** for the kitchen.

**Picked the wrong one?** Open the order and use *Change how this is billed* —
you can switch between Add to Room and Cash Now yourself, no manager needed,
right up until the order is billed.

**Kitchen Queue** shows every open order on one screen and refreshes itself.
Press **Served** as each goes out.

To take payment on a Cash Now order: open it → **Take payment now** → choose
cash / card / bank transfer / online → the receipt opens ready to print.

---

## Checking out

Open the booking → **Check out & bill**.

The bill shows room charges (one line per room the guest used) and every meal
charged to the room, grouped under Breakfast, Lunch and Dinner, then discount,
tax and the total.

* **Leaving early?** Change the check-out date and press **Recalculate** — the
  nights charged change with it.
* **Giving a discount?** Enter it and press **Recalculate**.
* **Amount paid now** starts at the full total. Reduce it for a part payment, or
  set it to 0 to bill the company later — the balance shows up under
  **Outstanding** until it is paid.

Press **Check out & create invoice**. The invoice opens, and from there you can
print an **80 mm thermal receipt** or a **full A4 invoice**.

The room becomes available again the moment the guest checks out.

---

## Money

**Invoices** lists every bill with what has been paid and what is outstanding.
Open one to record a further payment — part payments are fine and each is logged
with the mode, reference and who took it.

**Outstanding** is the chase list: every unpaid or partly paid bill with its
balance, exportable to Excel.

A mistake on a bill: if nothing has been paid against it, an administrator or
accountant can **Void** it. The orders on it become billable again, and the
booking screen offers **Re-issue invoice**.

---

## Admin dashboard

**Admin Dashboard** in the left menu (Administrator and Accountant). One screen
answering "how is the business doing":

* Total sale, total expenses, net profit and occupancy — each compared with the
  same length of time immediately before, so you see direction and not just a number
* **Where the money came from** — room rent, restaurant split into charged-to-rooms
  and cash, plus other income, against the previous period
* **Where it went** — every expense category with its share and what percentage of
  sales it eats
* **Cash position** — received, paid out, net movement, and what guests still owe
* **Needs attention** — guests in house, arrivals and departures still to process,
  open kitchen orders, food on rooms not yet billed, rooms under maintenance
* **Quick expense** — record a bill without leaving the page
* Best performing rooms, latest expenses, and recent staff activity

Pick a period at the top: today, yesterday, last 7 days, this month, last month,
this year, or your own dates.

---

## All reports

**Reports → All Reports** is the index. Everything prints, and most export to Excel.

| Report | What it answers |
|---|---|
| Daily Report | What happened yesterday — rooms, sales, expenses, profit |
| Monthly Report | The month's profit and loss with expenses by category |
| Year Summary | Twelve months side by side |
| Sales & Occupancy | Revenue by day, meal-wise sales, best sellers, occupancy |
| Room-wise Performance | Which rooms earn and which sit empty |
| Cash Book | Every movement of money with a running balance |
| Tax Collected | Tax charged month by month, for filing |
| Outstanding Payments | The chase list |

### Room-wise performance

Every room with nights sold, occupancy, average rate, room revenue and the food
delivered to it. Sorted by what each earned, so the rooms nobody books are
obvious. Use it to decide which rooms need a price change or attention.

### Cash book

Every movement of money in one chronological list — guest payments in, expenses
out — with a running balance and a breakdown by payment mode.

**The Cash row is the one to check against the box**: cash taken from guests less
cash paid out. Card and bank transfer rows should match your statements.

The running balance starts at zero on the first day of the range. It is the
movement across the period, not your bank balance.

### Tax collected

Tax charged on invoices, month by month, with the taxable amount behind it.

Tax is taken from what each invoice actually charged, never recalculated — so
changing the rate in Settings never rewrites history. Voided invoices are
excluded, because no tax was ever due on them. Treat it as a working figure for
your accountant, not a filed return.

---

## Sales & occupancy

Pick a period at the top — today, yesterday, last 7 days, this month, last 30
days, or your own dates. Every table has an **Export CSV** button that opens in
Excel.

* **Revenue by day** — room income against food income
* **Meal-wise sales** — Breakfast vs Lunch vs Dinner
* **Food billing split** — this is the reconciliation one. "Cash Now" should
  match the cash drawer for the day. "Add to Room" is money that will arrive on
  guest invoices at check-out, not cash you should already be holding.
* **Payments by mode** — what came in as cash, card, transfer, online
* **Best sellers**, **Occupancy**, **Outstanding bills**

---

## Menu

**Menu** → add items under Breakfast, Lunch, Dinner, Beverages or Extras with a
price.

Run out of something? Press **Take off** — it disappears from the ordering screen
straight away and comes back with **Put back**. Items that appear on past orders
cannot be deleted (that would corrupt old bills); take them off the menu instead.

---

## Rooms

**Room Status** shows the grid for any date — use ‹ Prev and Next › to look ahead
at a week. **Availability** answers "what have we got free between these dates".

Administrators can add rooms and room types under **Rooms & Room Types**, and
mark a room **Maintenance** so it stops being offered. A room with a guest in it
cannot be marked for maintenance — move them or check them out first.

---

## If something goes wrong

**"Security check failed"** — the page sat open too long. Reload it and try again.

**"Your session expired"** — sign in again. Sessions last 12 hours.

**A guest is missing from the room list when taking an order** — they are not
checked in. Food can only be charged to a room with a guest actually in it.

**Nobody can reach the system** — the host PC is off, or the black window on it
was closed. Start it from the desktop shortcut.

**Something looks wrong in a bill** — check **Admin → Activity Log**. Every
booking, order, invoice and payment change is recorded with who did it and when.

---

## Expenses

Everything the hotel spends goes in here, so the profit figures mean something.
**Expenses** in the left menu (Administrator and Accountant only).

The categories match the monthly report sheet:

* Salaries
* Utility Bills
* Kitchen Expense
* General Expense
* Laundry Expense
* Maintenance
* Other Income — for money coming in that is not a room or a meal

To record one: fill in the date, category, description and amount, say how it
was paid, and add the supplier and bill number if you have them. Press
**Record entry**.

**The date matters.** An entry is counted on the date the money was spent, not
the day you typed it in — so a July electricity bill entered in August still
lands in July's report. Always check the date field before saving.

Add, rename or switch off categories under **Categories**. A category that
already has entries against it cannot be deleted or flipped between expense and
income, because that would rewrite past reports. Switch it off instead: it
disappears from the entry form and old figures stay exactly as they were.

---

## Daily report

**Reports → Daily Report** is the evening sheet:

* every room occupied that night, with the guest, the booking and the rent
* total room rent for the night
* restaurant sale, split into charged-to-rooms and cash-now
* the day's expenses
* profit or loss for the day

Use ‹ Prev and Next › to move between days, and **Print** for a paper copy.

Front desk staff see the rooms and the sales. The expenses and the profit line
are shown to Administrators and Accountants only.

### Why "room rent earned" is not the same as money received

The report counts a room on the night the guest sleeps in it, even though they
pay at check-out a few days later. That is the only way a day's income can be
compared with that day's costs, and it is how the paper sheet has always worked.

The **Cash collected today** figure next to it is the other view: money actually
received today against any bill, old or new. Use that one to check the drawer.

---

## Monthly report

**Reports → Monthly Report** (Administrator and Accountant). Pick a month at the
top and press **Print** for a copy.

* **Income** — room rent with room-nights and average rate, restaurant sales
  split between charged-to-rooms and cash, plus any other income
* **Expenses** — one line per category with its share of the total
* **Profit & loss** — total sale, every expense heading, and the net figure
* **Day by day** — a table of each date's rooms, rent, restaurant, expenses and
  profit. Click any date to open that day's report

### One thing to watch

A month's salaries entered on a single date will make that one day look like a
heavy loss on the daily report. That is correct — the money did go out that day.
Judge the business on the **monthly** figure, where those costs sit against a
full month of income.

All profit figures exclude tax. Tax you collect for the government was never the
hotel's money, so counting it would flatter the result.
