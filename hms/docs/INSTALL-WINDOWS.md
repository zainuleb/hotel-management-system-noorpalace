# Installing on Windows

Written for the person setting the system up at the hotel. You do not need to be
a programmer to follow it.

---

## 1. Choose the host PC

One Windows PC runs the system; everyone else connects to it with a browser.
Pick the PC that is **always on during working hours**: normally the front desk
machine. It needs:

* Windows 10 or 11
* 4 GB RAM or more (the system itself uses well under 200 MB)
* A wired or wifi connection to the same network as the other devices
* The thermal receipt printer and, if you have one, the kitchen printer,
  installed as ordinary Windows printers

**Give this PC a fixed IP address**: or reserve one for it on the router. If its
address changes, every bookmark on every other device stops working. Ask whoever
manages the wifi to do this. It takes a minute and saves a support call later.

---

## 2. Install Node.js

1. Go to <https://nodejs.org>.
2. Download the **LTS** installer for Windows (v24 or newer).
3. Run it and accept every default.

Node.js is what the system runs on. Nothing else needs installing.

---

## 3. Copy the system onto the PC

Put the folder somewhere permanent and simple, for example `C:\HotelSystem`.
Avoid Desktop, Downloads, and any OneDrive-synced folder. A cloud sync service
fighting over the database file causes problems.

---

## 4. Run the installer

Right-click `deploy\install-windows.ps1` → **Run with PowerShell**. Say **Yes**
to the administrator prompt.

It checks Node.js, builds the app, opens the firewall for the hotel network,
makes the system start whenever the PC is switched on, and puts a shortcut on
the desktop. At the end it prints the addresses your staff should use, write
them down.

> **If PowerShell refuses to run the file**: open PowerShell as administrator and run:
> ```
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```
> then run the installer again from that same window.

---

## 5. First run

1. Double-click **Hotel Management System** on the desktop. A black window opens
   and stays open. That is the system running. Closing it stops the system.
2. On that PC, open a browser at `http://localhost:8080`.
3. Complete the setup wizard: hotel name, address, phone, currency, tax percent,
   and the administrator login you will use.
4. Tick **Add the rooms and a starter menu**. This creates the hotel's 18 rooms.
   101 to 108 on the ground floor and 201 to 210 on the first, plus a sample
   restaurant menu.

**Then set your real prices before going live.** The nightly rates that come
with the rooms are placeholders. Go to **Rooms & Room Types**: set the real
tariff on each room type, and move any better rooms onto the Deluxe type. Do the
same for the menu prices under **Menu**.

To add more rooms later, use **Add a whole floor at once** at the bottom of
Rooms & Room Types: type `301-310`, pick the floor and type, and they are all
created in one go.

There is no default password anywhere in this system. The account you create in
the wizard is the only way in, so keep it safe.

---

## 6. Connect the other devices

On every reception PC, kitchen screen and waiter tablet, open the wifi address
from step 4, for example `http://192.168.1.50:8080`, and bookmark it. On
Android and iOS you can use the browser's "Add to Home screen" so it looks and
opens like an app.

**If a device cannot connect:**

1. Confirm it is on the same wifi as the host PC (not a guest network, guest
   networks usually block devices from seeing each other).
2. Confirm the host PC is switched on and the black window is open.
3. Re-run the installer as administrator so the firewall rule is added.
4. On the host PC, check the address is still the same. `ipconfig` in Command
   Prompt shows it.

---

## 7. Create the staff logins

Sign in as the administrator → **Staff & Logins** → add one login per person:

| Role | Who it is for | What they get |
|---|---|---|
| Administrator | Owner / manager | Everything, including settings, staff and backups |
| Front Desk | Receptionists | Bookings, check-in/out, guests, orders, invoices, payments. **Not** expenses or profit figures |
| Restaurant / Waiter | Waiters, kitchen | Take and edit orders, print KOTs. No prices reports, no billing |
| Accountant | Accounts | Invoices, payments, voiding, expenses, profit reports, activity log |

Give each person a temporary password. They will be forced to choose their own
the first time they sign in. **Do not share one login between staff**: the
activity log is only useful if it says who actually did each thing.

---

## 8. Printers

The system prints through the browser, so anything Windows can print to will
work.

**Thermal receipts (80 mm or 58 mm)**

1. Install the printer's Windows driver as normal.
2. In the system: **Settings → Thermal printer width**: pick 80 mm or 58 mm.
3. Open any invoice → **Thermal receipt** → Print.
4. In the print dialog choose the thermal printer, set **Margins: None** and
   turn **Headers and footers off**. Chrome and Edge remember this per printer.

**A4 invoices** print to any ordinary printer with no configuration.

**Kitchen order tickets (KOT)** open from an order screen. If the kitchen has
its own printer, set it as the default printer on the tablet or PC the waiters
use, or print KOTs from a machine next to the kitchen.

---

## 9. Backups: please read this one

The system backs itself up automatically when it starts and once every 24 hours,
keeping the newest 30 copies in `data\backups`.

**That is not enough on its own.** Those copies are on the same PC as the live
database, so a failed disk or a stolen machine takes both. Once a week:

* **Admin → Backup → Download** the newest file onto a USB stick or a cloud drive, **or**
* have IT copy the `data\backups` folder to another machine on a schedule.

To restore: **Admin → Backup**: click **Restore** next to a file, and type
`RESTORE` to confirm. The system saves a copy of the current database first, so
a mistaken restore can itself be undone.

---

## 10. Day-to-day

* Leave the PC and the black window running.
* After a Windows update or restart, the system starts again by itself.
* To stop it deliberately, close the black window.
* To move to a new PC: install Node.js there, copy the whole folder across
  including `data`, run the installer, done. All bookings, invoices and settings
  come with it.

---

## Changing the port

If something else on the PC already uses 8080, edit
`deploy\Start Hotel System.bat` and change:

```
set HMS_PORT=8080
```

Then re-run the installer so the firewall rule matches, and update the bookmark
on every device.

## Keeping the data on another drive

Add a line to `deploy\Start Hotel System.bat`:

```
set HMS_DATA_DIR=D:\HotelData
```

Move the existing `data` folder there first, while the system is stopped.
