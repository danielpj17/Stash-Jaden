# Stash

A responsive financial dashboard built with **Next.js 14**, **Tailwind CSS**, and **Lucide React** icons. Charcoal background with light blue accents.

## Features

- **Sidebar navigation**: New Expense, Expenses (default), Budget, Net Worth
- **Month selector**: Dropdown in the top right
- **Responsive layout**: Collapsible sidebar on desktop; drawer overlay on mobile
- **Theme**: Charcoal (`#1E1E1E`) with light blue accent (`#7BC0FF`)
- **Blank-slate accounts**: Define your own accounts (checking, savings, cash, credit, brokerage) on the Net Worth page — no hard-coded accounts or balances.
- **Self-mapping CSV upload**: Reconcile any bank's CSV — the app auto-detects the column layout and lets you confirm/override a mapping per account.
- **Google Sheets backend**: Connect your own sheet via a Google Apps Script Web App (see below).

## Google Sheets backend

1. Create two tabs:
   - **Expenses** headers: **Timestamp**, **Expense Type**, **Amount**, **Description**, **Month**, **Row ID**
   - **Transfers** headers: **Timestamp**, **Transfer from**, **Transfer To**, **Transfer Amount**, **Month**, **Transfer Row ID**
2. Use the sample script in `docs/google-apps-script-sample.js`: Extensions → Apps Script, paste the code, then Deploy → New deployment → Web app. Copy the Web App URL.
3. Create `.env.local` from `.env.example` and set `NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL` to that URL.
4. Restart the dev server. The Expenses page will load data from the sheet; the New Expense form will append rows (Timestamp is set by the script).

For reconciliation claim-linking, each expense row must have a stable **Row ID**:
- new rows created via the sample script will get a UUID automatically
- older rows should be backfilled once manually in the sheet

For transfer leg claiming, each transfer row must have a stable **Transfer Row ID**:
- new rows created via the sample script will get a UUID automatically
- older transfer rows should be backfilled once manually in the sheet

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Database setup

Paste the single schema file `docs/neon-setup.sql` into the Neon SQL editor and run it
(it's idempotent and contains every table). The app also auto-creates/upgrades these
tables on first use of each route.

## Accounts

Add your accounts on the **Net Worth** page (Accounts section). Each account has a type, an
opening balance + as-of date, and an optional per-account CSV column mapping used by reconciliation.
Name an account to match your existing sheet/reconcile names to keep prior history attached.

## Scripts

- `npm run dev` – development server
- `npm run build` – production build
- `npm run start` – run production server
- `npm run lint` – run ESLint
