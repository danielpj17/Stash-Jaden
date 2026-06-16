-- ============================================================================
-- Stash — complete Neon schema (single source of truth).
-- Paste this ENTIRE file into the Neon SQL Editor and run.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / ON CONFLICT).
--
-- Whenever a table or column is added/changed in the app, update THIS file so it
-- stays the one copy-pasteable setup script. The API routes also auto-create
-- these tables on first use, but this file is the canonical reference.
-- For a destructive "wipe everything" reset, see docs/neon-blank-slate-reset.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Budgets (single JSONB row keyed by id = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_store (
  id integer PRIMARY KEY DEFAULT 1,
  data jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO budget_store (id, data) VALUES (1, '{}')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Accounts — single source of truth for user-defined accounts.
-- Keyed by a canonical `name` (the join key used across reconciliation tables).
-- `csv_format` is a superset of BankProfile (headerRows, dateFormat, amountSign,
-- configured) used to parse this account's bank CSVs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                   text PRIMARY KEY,
  name                 text NOT NULL UNIQUE,
  type                 text NOT NULL DEFAULT 'other',   -- checking|savings|cash|credit|brokerage|other
  opening_balance      numeric(14, 2) NOT NULL DEFAULT 0,
  opening_balance_date date,
  csv_format           jsonb NOT NULL DEFAULT '{}'::jsonb,
  include_in_reconcile boolean NOT NULL DEFAULT true,
  sort_order           integer NOT NULL DEFAULT 0,
  archived             boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_name ON accounts (name);

-- ---------------------------------------------------------------------------
-- Manual assets / liabilities (Net Worth page)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_assets (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  acquisition_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_liabilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  acquisition_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reconciliation state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_transactions (
  hash TEXT PRIMARY KEY,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_anchors (
  account_name TEXT PRIMARY KEY,
  confirmed_balance NUMERIC,
  as_of_date DATE
);

CREATE TABLE IF NOT EXISTS reconciliation_claim_links (
  bank_hash TEXT NOT NULL,
  account_name TEXT,
  sheet_name TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
  UNIQUE (sheet_name, sheet_row_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_transfer_claim_links (
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  bank_account_name TEXT,
  bank_amount_cents INTEGER NOT NULL,
  expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (transfer_sheet_row_id, bank_hash),
  UNIQUE (bank_hash)
);

CREATE TABLE IF NOT EXISTS reconciliation_statement_dismissals (
  hash TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (hash, account_name)
);

CREATE TABLE IF NOT EXISTS reconciliation_user_sheet_dismissals (
  sheet_name TEXT NOT NULL,
  sheet_row_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (sheet_name, sheet_row_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_match_cache (
  account_name TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  match_data JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, bank_hash)
);

CREATE TABLE IF NOT EXISTS reconciliation_csv_rows (
  account_name TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  cells        JSONB NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, dedupe_key)
);

CREATE TABLE IF NOT EXISTS reconciliation_uploaded_files (
  account_name TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  bank_hashes  JSONB,
  PRIMARY KEY (account_name, file_name)
);

-- Merchant memory: tracks recurring patterns to auto-claim after 2+ confirmations.
CREATE TABLE IF NOT EXISTS reconciliation_merchant_memory (
  fingerprint TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  sheet_category TEXT,
  sheet_account TEXT,
  confirmed_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (fingerprint, bank_account_name)
);

-- Persistent audit log of every reconciliation action (Activity tab + per-action undo).
CREATE TABLE IF NOT EXISTS reconciliation_activity_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMP NOT NULL DEFAULT now(),
  action_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  csv_upload_id UUID,
  bulk_action_id UUID,
  parent_action_id UUID,
  payload JSONB NOT NULL,
  reverted_at TIMESTAMP,
  reverted_by_action_id UUID
);
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
  ON reconciliation_activity_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_csv
  ON reconciliation_activity_log(csv_upload_id);

-- ---------------------------------------------------------------------------
-- In-place upgrades (idempotent) for older databases.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opening_balance_date date;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS csv_format jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS include_in_reconcile boolean NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Drop the legacy SnapTrade snapshot table (integration removed).
DROP TABLE IF EXISTS snaptrade_balance_snapshots;
