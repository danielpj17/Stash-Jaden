-- Blank-slate reset for a fresh Stash deployment.
-- Run in the Neon SQL editor to wipe ALL personal data (accounts, assets/liabilities,
-- budgets, and every reconciliation table). This does NOT touch your Google Sheet —
-- clear or replace that separately if you want a truly empty transaction history.
--
-- WARNING: irreversible. Only run on an instance you intend to reset to empty.

TRUNCATE TABLE
  accounts,
  manual_assets,
  manual_liabilities,
  account_anchors,
  reconciliation_csv_rows,
  reconciliation_claim_links,
  reconciliation_transfer_claim_links,
  reconciliation_statement_dismissals,
  reconciliation_user_sheet_dismissals,
  reconciliation_match_cache,
  reconciliation_uploaded_files,
  reconciliation_merchant_memory,
  reconciliation_activity_log,
  processed_transactions;

-- Budgets are stored as a single JSONB row; clear them too if desired:
-- DELETE FROM budget_store;
