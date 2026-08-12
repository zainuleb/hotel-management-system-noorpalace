# Hotel Management System: Hotel Noor Palace

Room booking, restaurant service, combined billing, expenses and profit reporting
for a single hotel property.

It runs on **one Windows PC** on the hotel's own wifi. Reception, the kitchen,
waiters on tablets and the accountant all use it through an ordinary browser.
**No internet connection is required**. Nothing leaves the building.

The application lives in [`hms/`](hms). Start there:

| | |
|---|---|
| **What it does, and how to run it** | [`hms/README.md`](hms/README.md) |
| **Installing at the hotel** | [`hms/docs/INSTALL-WINDOWS.md`](hms/docs/INSTALL-WINDOWS.md) |
| **Day-to-day use, for staff** | [`hms/docs/USER-GUIDE.md`](hms/docs/USER-GUIDE.md) |

## Quick start

```bash
cd hms
npm install
npm run build
npm start          # http://localhost:8080
```

The first person to open it completes a short setup wizard, hotel details, tax
rate, and the administrator login. There is no default password anywhere in the
system.

## Checking it still works

```bash
cd hms
npm run build && node scripts/smoke-test.mjs
```

70 checks run against a real server and a throwaway database, covering the whole
journey from setup to a paid invoice and on to the monthly profit figure.

## The hotel

18 rooms, 101 to 108 on the ground floor, 201 to 210 on the first. The setup
wizard can create them, with placeholder rates to be replaced by the real tariff.

## Licence

Proprietary. Built for Hotel Noor Palace by QS Software Solution. Not licensed
for redistribution.
