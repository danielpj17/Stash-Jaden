# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build
npm run start    # Run production build
npm run lint     # ESLint
```

No test suite — feature verification is manual via browser.

## Environment Setup

Copy `.env.example` to `.env.local` and populate:
- `NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL` — deployed Google Apps Script web app URL
- `DATABASE_URL` — Neon Postgres connection string
- `NEXT_PUBLIC_CONTACT_EMAIL` — optional, shown on the Contact page

**Neon schema lives in a single file: `docs/neon-setup.sql`.** It contains every table the app uses and is the one copy-pasteable setup script (run it in Neon's SQL editor). It is idempotent (safe to re-run). **Always keep this one consolidated file complete** — whenever you add or change a table/column anywhere in the app, update `docs/neon-setup.sql` in the same change so it stays the single source of truth. Do not split the schema into per-feature SQL fragments. (`docs/neon-blank-slate-reset.sql` is a separate destructive "wipe everything" script.)

## Architecture

**Stash** is a Next.js 14 personal finance dashboard. It is a **blank-slate, single-instance template**: a new user starts empty and defines their own accounts/assets/liabilities in-app. Data lives in two external systems:
1. **Google Sheets** (via a deployed Apps Script web app) — source of truth for all expense/transfer transactions
2. **Neon Postgres** — stores the `accounts` table (single source of truth for account config), budget allocations, manual assets/liabilities, and reconciliation state (anchors, claims, dismissals, CSV rows, processed hashes)

### Data Flow

- All pages are client components that fetch via internal API routes (`/api/*`)
- `/api/sheets` proxies to Google Apps Script (GET = fetch expenses/transfers, POST = submit new transaction)
- `/api/accounts` reads/writes the user's accounts (name, type, opening balance, per-account `csv_format`) to Neon
- `/api/budget` reads/writes monthly budgets to Neon as JSONB
- `/api/assets` and `/api/liabilities` — manual asset/liability CRUD (GET/POST/DELETE)
- `/api/reconciliation/*` manages bank CSV matching state in Neon

There is **no SnapTrade / live brokerage integration** — brokerage accounts are manual-value accounts (type `brokerage`).

### State Management

Five React contexts (in `contexts/`):
- `ExpensesDataContext` — caches full-year expenses + transfers on mount; refetches when `refreshKey` changes
- `AccountsContext` — caches the user's `accounts` (from `/api/accounts`); exposes `accountNames` / `reconcileAccountNames`; refetches on `refreshKey`
- `MonthContext` — selected month (1–12 or `"full"`)
- `RefreshContext` — provides `refreshKey` integer + `triggerRefresh()` to force data reload
- `SidebarContext` — sidebar collapsed/open state

Pages use `useMemo` to filter the cached full-year data by `selectedMonth` — month switching is instant with no network calls.

### Accounts (single source of truth)

The `accounts` table replaces the previously hard-coded account lists / opening balances / bank CSV profiles. It is keyed by a canonical `name` (the same string used across reconciliation tables, so reconciliation history stays attached as long as the name matches). Account config drives: transfer dropdowns (budget + new-expense), the reconcile account selector, opening balances in `computeAccountBalances`, and per-account CSV column mappings. Manage accounts on the Net Worth page.

### Key Files

| File | Notes |
|------|-------|
| `app/page.tsx` | Main budget dashboard (home): pie/line charts, budget bars, account balances card; transfer dropdowns sourced from `AccountsContext` |
| `app/reconcile/page.tsx` | Bank CSV upload + transaction matching UI; account options from `AccountsContext`; opens the CSV mapping modal on first upload |
| `app/net-worth/page.tsx` | Net worth KPIs, manual assets/liabilities (with delete), and **account management** (add/edit/delete accounts) |
| `app/new-expense/page.tsx` | Form to add expenses/income to Google Sheets |
| `services/sheetsApi.ts` | All Google Sheets fetch/submit logic + type normalization |
| `services/accountBalancesService.ts` | `computeAccountBalances(accounts, rows, transfers, anchors)` — data-driven, seeded by account opening balances |
| `services/netWorthService.ts` | Net worth summary; liquid total is passed in by the page (sum of account balances) |
| `contexts/AccountsContext.tsx` | Accounts cache + derived name lists; `CsvFormat`/`Account` types |
| `app/api/accounts/route.ts` | Accounts GET/POST(upsert)/DELETE |
| `components/CsvMappingModal.tsx` | Per-account CSV column-mapping UI (auto-detect + manual override + live preview) |
| `lib/constants.ts` | Expense/asset/liability categories (generic) |
| `components/GlassDropdown.tsx` | Reusable styled dropdown used across pages |
| `app/investment-calculator/page.tsx` | Life-stage compound-interest calculator — fully client-side, persists to localStorage, uses Recharts |

### Budget Logic

- Monthly budgets stored as `Record<monthNumber, Record<categoryName, amount>>` in Neon
- If a month has no budget, it inherits (carry-forward) from the previous month
- Full Year view aggregates all 12 months
- Budget category names are normalized through `budgetCategoryMigration.ts` to handle legacy data

### Reconciliation

The reconciliation workflow (`/reconcile`) matches uploaded bank CSV rows against Google Sheets transactions. State is persisted in Neon across four tables: `account_anchors`, `reconciliation_claim_links`, `reconciliation_transfer_claim_links`, `reconciliation_statement_dismissals`. The match algorithm (`findMatches`) in `services/reconciliationService.ts` is unchanged and untouchable.

**CSV column mapping:** instead of only the hard-coded `BANK_PROFILES`, each account can store a `csv_format` (a superset of `BankProfile`) in the `accounts` table. On first upload for an account with no built-in/saved parser, `CsvMappingModal` auto-detects the layout and lets the user confirm/override it, then saves it to `accounts.csv_format`. The parser applies this override at the seam in `mapBankRowsToTransactions` (via `getCsvParseOptionsForAccount`), which is loaded identically in the `match`, `csv-rows`, and `dedupe` routes so stored dedupe keys stay consistent with matched hashes. The transaction hash inputs are never changed — built-in accounts with no saved format parse exactly as before.

### Styling

Tailwind CSS with a custom dark theme — charcoal (`#1A1A1A`) background, green (`#50C878`) accent. Alternating tile rows use `#2C2C2C`. All custom tokens are in `tailwind.config.ts`.

### Neon DB Access Pattern

API routes use raw SQL via `@neondatabase/serverless`. No ORM. Bulk inserts use per-row transactions (chunked) to stay within Neon HTTP driver limits — see `NEON_SAVE_CHUNK_SIZE` in reconciliation routes.
