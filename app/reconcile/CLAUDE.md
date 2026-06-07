# Reconciliation System — CLAUDE.md

## Purpose

The reconcile page matches bank CSV statement rows against user-inputted expense and transfer entries from Google Sheets. The goal is to confirm every bank transaction has a corresponding user entry, and every user entry has a corresponding bank transaction.

**Two sources of truth:**
- **Google Sheets** — user-inputted expenses and transfers (what the user recorded)
- **Bank CSV** — raw bank statements (what actually happened)

Reconciliation produces a claim: a persistent link between a bank transaction hash and a sheet row ID.

---

## Key Files

| File | Role |
|------|------|
| `app/reconcile/page.tsx` | Main UI (~5100+ lines) — all state, handlers, view logic |
| `services/reconciliationService.ts` | Match algorithm, bank CSV parsing, hash generation, merchant memory match step |
| `lib/activityLog.ts` | Server-side activity log helpers (Node.js only — API routes) |
| `lib/merchantFingerprint.ts` | Browser-safe merchant fingerprint generator (no crypto deps) |
| `app/api/reconciliation/match/route.ts` | CSV rows → BankTransaction[] → MatchResult[]; restores Neon claims |
| `app/api/reconciliation/claims/route.ts` | Expense claim links CRUD + activity log |
| `app/api/reconciliation/transfer-claims/route.ts` | Transfer claim links CRUD |
| `app/api/reconciliation/processed/route.ts` | Processed hash CRUD + activity log |
| `app/api/reconciliation/dismissals/route.ts` | Bank transaction dismissal CRUD |
| `app/api/reconciliation/user-dismissals/route.ts` | Sheet row dismissal CRUD |
| `app/api/reconciliation/anchors/route.ts` | Account balance anchor CRUD |
| `app/api/reconciliation/match-cache/route.ts` | Persist/restore MatchResult[] per account |
| `app/api/reconciliation/csv-rows/route.ts` | Persist raw CSV rows per account; **server-side identity merge** (`merge:true`) |
| `app/api/reconciliation/dedupe/route.ts` | Remove already-reconciled duplicate CSV rows for an account (count-based) |
| `app/api/reconciliation/uploaded-files/route.ts` | File upload history per account |
| `app/api/reconciliation/memory/route.ts` | Merchant memory CRUD (GET all, POST upsert/increment, DELETE) |
| `app/api/reconciliation/activity/route.ts` | Activity log fetch with `?since=` filter |
| `app/api/reconciliation/activity/[id]/undo/route.ts` | Per-action undo |
| `app/api/reconciliation/reset/route.ts` | Wipe all reconciliation state from Neon |

---

## Core TypeScript Types

### `services/reconciliationService.ts`

```typescript
type BankProfile = {
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex?: number | null;
  creditIndex?: number | null;
};

type BankTransaction = {
  accountName: string;
  date: string;           // YYYY-MM-DD
  amount: number;         // negative = debit
  description: string;
  hash: string;           // SHA256 of date|amount|description (normalized)
  raw?: string[];         // original CSV row
};

type MatchType =
  | "exact_match"              // auto-matched or manually claimed
  | "processed"                // hash in Neon, no current sheet row linked
  | "questionable_match_fuzzy" // multiple same-amount candidates, needs manual review
  | "suggested_match"          // amount matches, confidence below auto-threshold
  | "transfer"                 // matches a sheet transfer row
  | "unmatched";               // no match found

type MatchResult = {
  bankTransaction: BankTransaction;
  matchType: MatchType;
  reason: string;
  matchedSheetExpense?: SheetExpenseLike;
  matchedSheetIndex?: number;
  matchedSheetTransfer?: SheetTransferLike;
  matchedSheetTransferIndex?: number;
  transferCounterparty?: BankTransaction;  // other leg of cross-account transfer
  matchedByNeonHash?: boolean;             // true if match was restored from Neon claim
  confidenceScore?: number;
  candidateCount?: number;
  isAmbiguousCluster?: boolean;
};

type MerchantMemoryEntry = {
  fingerprint: string;
  bankAccountName: string;
  confirmedCount: number;
  sheetCategory: string | null;
  sheetAccount: string | null;
};
```

### Modal and UI state types (`page.tsx`)

```typescript
type TransferClaimModalState = {
  open: boolean;
  rowId: string | null;
  expectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type UserStatementClaimModalState = {
  open: boolean;
  entry: UserInputtedEntry | null;
  selectedBankRowId: string | null;
  searchQuery: string;
  accountFilter: AccountOption | typeof ALL_ACCOUNTS_OPTION;
  transferExpectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type DismissModalState = {
  open: boolean;
  match: MatchResult | null;
  note: string;
  submitting: boolean;
  error: string;
};

type AnchorModalState = {
  open: boolean;
  date: string;
  balance: string;
  loading: boolean;
  saving: boolean;
  error: string;
};

// Bulk approve filter chips
type BulkFilter = "all" | "high_confidence" | "suggested" | "transfers";
```

---

## Neon Database Schema

Full schema is in `docs/neon-budget-setup.sql`. Run that file in the Neon SQL editor to create all tables.

```sql
-- Hash-based deduplication. One row per bank transaction.
CREATE TABLE processed_transactions (
  hash TEXT PRIMARY KEY,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now()
);

-- Links a bank transaction to an expense sheet row.
-- UNIQUE(sheet_name, sheet_row_id) ensures one expense = one bank tx.
CREATE TABLE reconciliation_claim_links (
  bank_hash TEXT NOT NULL,
  account_name TEXT,
  sheet_name TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
  UNIQUE (sheet_name, sheet_row_id)
);

-- Links a bank transaction to a transfer sheet row.
-- UNIQUE(bank_hash) ensures one bank tx = one transfer leg.
-- Same transfer_sheet_row_id can appear twice (one per leg of a 2-leg transfer).
CREATE TABLE reconciliation_transfer_claim_links (
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  bank_account_name TEXT,
  bank_amount_cents INTEGER NOT NULL,
  expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (transfer_sheet_row_id, bank_hash),
  UNIQUE (bank_hash)
);

-- Bank transaction dismissed (no corresponding sheet entry needed).
CREATE TABLE reconciliation_statement_dismissals (
  hash TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (hash, account_name)
);

-- User sheet row dismissed (no corresponding bank transaction needed).
CREATE TABLE reconciliation_user_sheet_dismissals (
  sheet_name TEXT NOT NULL,
  sheet_row_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (sheet_name, sheet_row_id)
);

-- Cached MatchResult[] per account (avoids re-matching on page reload).
CREATE TABLE reconciliation_match_cache (
  account_name TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  match_data JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, bank_hash)
);

-- Raw CSV rows per account. dedupe_key is the transaction identity:
-- "id:<hash>" for parseable rows (occurrence-disambiguated, so genuine in-file
-- duplicates get distinct keys) or "raw:<cells>" for header/unparseable rows.
-- Written by POST /csv-rows merge mode (replace) and POST /dedupe.
-- (Legacy rows from the old append path used full-row content keys.)
CREATE TABLE reconciliation_csv_rows (
  account_name TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  cells        JSONB NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, dedupe_key)
);

-- Upload history per account. bank_hashes stores every tx hash from that upload
-- so individual files can be selectively cleared (DELETE /api/reconciliation/uploaded-files).
CREATE TABLE reconciliation_uploaded_files (
  account_name TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  bank_hashes  JSONB,
  PRIMARY KEY (account_name, file_name)
);

-- Statement ending balance anchors for account balance computation.
CREATE TABLE account_anchors (
  account_name TEXT PRIMARY KEY,
  confirmed_balance NUMERIC,
  as_of_date DATE
);

-- Merchant memory: tracks recurring patterns to auto-claim after 2+ confirmations.
CREATE TABLE reconciliation_merchant_memory (
  fingerprint TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  sheet_category TEXT,
  sheet_account TEXT,
  confirmed_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (fingerprint, bank_account_name)
);

-- Persistent audit log of every reconciliation action. Never auto-purged.
CREATE TABLE reconciliation_activity_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMP NOT NULL DEFAULT now(),
  action_type TEXT NOT NULL,
  -- action types: claim_create, claim_delete, transfer_claim_create,
  --   transfer_claim_delete, dismiss_create, dismiss_delete,
  --   memory_create, memory_increment, memory_delete, processed_create
  actor TEXT NOT NULL,           -- 'user' | 'auto_match' | 'memory_match'
  csv_upload_id UUID,            -- groups all actions from one CSV upload
  bulk_action_id UUID,           -- groups all actions from one bulk approve
  parent_action_id UUID,         -- compound actions (e.g., quick_log chains)
  payload JSONB NOT NULL,
  reverted_at TIMESTAMP,
  reverted_by_action_id UUID
);
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
  ON reconciliation_activity_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_csv
  ON reconciliation_activity_log(csv_upload_id);
```

---

## Bank Profiles & CSV Parsing

### Supported Banks

| Account Name | Bank Profile | Date Col | Amount Col | Notes |
|---|---|---|---|---|
| WF Checking | Wells Fargo | 0 | 1 | Embeds purchase date in description |
| WF Savings | Wells Fargo | 0 | 1 | Same profile as WF Checking |
| Venmo - Daniel | Venmo | auto-detect | auto-detect | Header row scanned dynamically |
| Venmo - Katie | Venmo | auto-detect | auto-detect | Same profile |
| Capital One | Capital One | auto-detect | debit/credit cols | Two separate debit/credit columns |
| America First | America First | null | null | Not yet configured — returns empty |
| Discover | Discover | null | null | Not yet configured — returns empty |
| Fidelity | Fidelity | — | — | No BANK_PROFILES entry — returns empty |
| Schwab | Charles Schwab | — | — | No BANK_PROFILES entry — returns empty |
| Ally | Ally | — | — | No BANK_PROFILES entry — returns empty |

**WF Checking, WF Savings, Venmo - Daniel, Venmo - Katie, and Capital One have working CSV parsers.** Other accounts can be added to `BANK_PROFILES` in `services/reconciliationService.ts`.

### Hash Generation (`generateTransactionHash`)

```
SHA256(YYYY-MM-DD | normalized_amount | trimmed_lowercase_description)
```

- Amount normalized to 2 decimal places
- Description trimmed and lowercased
- Hash is stable across multiple imports of the same statement

**Never change the hash inputs** — existing Neon claims and processed records are keyed to these hashes.

### Wells Fargo Date Derivation

Wells Fargo posts transactions with a posting date, but embeds the actual purchase date in the description as `PURCHASE AUTHORIZED ON MM/DD`. The parser extracts this date to reduce date-lag mismatches during matching. Year is inferred from context (handles Jan/Dec boundary).

### Description Cleaning

`cleanBankDescription()` in `services/reconciliationService.ts` removes noise before matching:
- `PURCHASE AUTHORIZED ON MM/DD` prefix
- Reference codes (`ref #...`)
- Card numbers (`card XXXX`)
- ATM IDs and transaction refs
- Alpha-prefixed long digit sequences (e.g., `B12345678`) — last 4 digits kept as `#NNNN` tag
- Pure long digit sequences (10+ digits, e.g., `00624243319836`) — last 4 digits kept as `#NNNN` tag
- Trailing whitespace

The `#NNNN` tag preserves just enough of the stripped number to disambiguate duplicate transactions (e.g., two DELTA flights on the same day become `DELTA #9836` and `DELTA #9840`). The tag is stripped by `normalizeDescriptionForMatch` before Jaccard similarity scoring, so it doesn't affect matching against manually-entered Sheets descriptions.

### CSV MIME Type (Windows)

Windows browsers report `.csv` files with inconsistent MIME types (`text/plain`, `application/vnd.ms-excel`, `application/csv`, or `text/csv`). The dropzone accepts all four to avoid silent rejections. An `onDropRejected` handler surfaces a visible error for genuinely wrong file types.

### Transaction Identity & CSV Dedup (server-side)

CSV merge/dedup is keyed by **transaction identity** (date+amount+description, i.e. the hash) rather than the full raw CSV line. This prevents the same transaction from being stored twice when overlapping statements are re-imported and a *non-identifying* column differs (e.g. a running-balance column) — which previously produced a phantom `…-2` disambiguated hash that showed up as both matched and unmatched.

Because `services/reconciliationService.ts` imports `node:crypto` it is **not browser-safe** (`page.tsx` imports only types from it), so the merge runs **server-side**:

- `PROFILE_BY_ACCOUNT` (exported from the service; also imported by `match/route.ts`) maps a UI account → bank profile, e.g. `"WF Checking" → "Wells Fargo"`.
- `computeCsvIdentityKeys(accountName, rows)` → one key per row: `id:<hash>` for rows that parse to a transaction (the hash is already occurrence-disambiguated, so genuine in-file duplicates get distinct keys), or an occurrence-indexed `raw:<cells>` key for header/unparseable rows (preserves header rows for Venmo/Capital One profile resolution).
- `mergeCsvRowsByIdentity(accountName, existing, incoming)` → identity-merge with **max-count-per-identity** semantics: a re-imported transaction collapses onto its existing copy; a genuine second identical line is kept.

**Caveat:** This prevents *new* duplicates at import time but does not retroactively collapse duplicates already stored from before the fix (once two same-identity rows exist, the disambiguator keeps both). Legacy duplicates are handled at the display layer (see `statementReviewRowsByAccount`) and by `POST /dedupe`.

---

## Match Algorithm (`findMatches` in `reconciliationService.ts`)

Runs in priority order. Once a bank transaction is matched at a step, later steps are skipped. Sheet rows are "consumed" (removed from the pool) as they are matched to prevent double-matching.

Before `findMatches()` runs, the match route pre-processes bank transactions with existing Neon claim links and restores them as `exact_match` (with `matchedSheetExpense`/`matchedSheetTransfer` populated). Only unclaimed transactions are passed to `findMatches()`.

### Step 0 — Merchant Memory Pre-pass

Before the main algorithm, each unclaimed bank transaction is checked against loaded merchant memory entries (`confirmed_count >= 2`). The fingerprint is computed via `generateMerchantFingerprint(description, amount)` in `lib/merchantFingerprint.ts`. If a memory entry matches, the best unclaimed sheet row with matching category/account is paired as `exact_match` with `actor: "memory_match"`. Memory is account-scoped — WF Checking memory doesn't fire on Capital One.

### Step 1 — Exact Match (Sheet Expense)

- Bank amount and date match a sheet expense row exactly
- Finds the first **unclaimed** Sheets entry (skips rows already consumed by an earlier bank transaction in this batch)
- Sheet row consumed from pool
- `matchType: "exact_match"`
- **Critical:** Two identical bank transactions (same amount + date) each get a distinct Sheets entry if two exist; the second falls through to later steps if no unclaimed entry remains.

### Step 2 — Processed Hash (Neon)

- Hash exists in `processed_transactions` but no sheet row is currently linked
- Indicates the transaction was handled in a prior session (dismissed, or sheet row was deleted)
- `matchType: "processed"`, `matchedByNeonHash: true`

### Step 3 — Transfer Matching

- Looks for sheet transfer rows where amount matches (within 31-day window), description contains transfer keywords, and Jaccard similarity >= 0.12
- Transfer claim must not already be complete (`claimedCount < expectedLegs`)
- Single candidate → `matchType: "transfer"`
- Multiple candidates → `matchType: "questionable_match_fuzzy"` (manual review required)
- Also handles cross-account transfers: negative amount in account A matched against positive in account B (same day)

### Step 4 — Confidence-Scored Expense Matching

Finds all sheet expenses with matching amount, then scores each:

| Factor | Score |
|---|---|
| Same day | +1.0 |
| 1 day apart | +0.9 |
| 3 days apart | +0.7 |
| 7 days apart | +0.5 |
| 14 days apart | +0.3 |
| 30 days apart | +0.1 |
| > 30 days | +0.0 |
| Description Jaccard similarity | +0.0–1.0 scaled |
| Account name match | +0.2 |

**Auto-match threshold** (all conditions must hold):
- Top score >= 1.0
- Gap between top and second score >= 0.3
- Transaction is NOT in an ambiguous cluster
- Sheet row is not already claimed

Below threshold → `matchType: "suggested_match"` (needs user approval)

### Step 5 — Ambiguous Cluster Detection

A bank transaction is part of an ambiguous cluster if another transaction in the same account has the same amount, description similarity >= 0.3, and is within 1 day. Clustered transactions never auto-match regardless of confidence score.

### Step 6 — Unmatched

No amount match found anywhere. `matchType: "unmatched"`.

### Description Similarity (Jaccard)

```
tokens_a = { words with 3+ chars, not in stop-word list }
tokens_b = { same }
similarity = |tokens_a ∩ tokens_b| / max(|tokens_a|, |tokens_b|)
```

Stop words: purchase, authorized, transfer, payment, to, from, ref, pos, debit, credit, card, on, at, with, for, the, and, via.

---

## Merchant Memory

### Purpose

Recurring subscriptions (Netflix, gym, etc.) get auto-claimed after 2 confirmed matches instead of requiring manual approval each month.

### Fingerprint Generation (`lib/merchantFingerprint.ts`)

`generateMerchantFingerprint(description, amount)` — browser-safe (no Node.js `crypto`):
- Strip variable tokens: dates, transaction IDs, store numbers, location codes
- Normalize amount to nearest dollar (handles minor price fluctuations)
- Lowercase, collapse whitespace
- Returns a stable string that represents the recurring pattern

### Confirmation Flow

Every successful claim handler (`handleApprove`, `handleSplitSubmit`, `handleTransferClaimSubmit`) calls `recordMerchantMemory()` which POSTs to `/api/reconciliation/memory`. The endpoint upserts `(fingerprint, bankAccountName)` and increments `confirmed_count`. After 2 confirmations, the next upload auto-claims matching transactions.

### Memory Management

The "Memory" button in the page header opens a modal showing all memory entries per account. Users can delete individual entries to stop auto-claiming a pattern.

### API: `/api/reconciliation/memory`

- `GET` — returns all entries
- `POST { fingerprint, bankAccountName, sheetCategory?, sheetAccount? }` — upsert + increment count
- `DELETE { fingerprint, bankAccountName }` — remove single entry

---

## Activity Log

### Purpose

Persistent audit trail of every reconciliation action. Enables per-action undo and future CSV-cascade-delete.

### `lib/activityLog.ts` (API routes only — uses Node.js `crypto`)

- `ensureActivityLogTable(sql)` — creates the table if missing
- `buildActivityLogInsert(sql, { actionType, actor, payload, csvUploadId?, bulkActionId?, parentActionId? })` — returns `{ id: UUID, query: SqlQuery }` for use inside a `sql.transaction([...])` call
- `parseActivityGroupingIds(body)` — extracts `csvUploadId`, `bulkActionId`, `parentActionId` from request body

### csvUploadId Threading

When a CSV is dropped, `onDrop` generates a `csvUploadId` (UUID via `crypto.randomUUID()` or Date.now() fallback). This ID is passed through:
- Every `persistProcessedHash()` call for auto-approved matches
- Every `POST /claims` for auto-claimed rows
- Stored alongside the upload record in `uploaded-files`

This allows all actions triggered by one upload to be grouped and undone together (future feature).

### API: `/api/reconciliation/activity`

- `GET ?since=YYYY-MM-DD` — returns log entries from that date forward, grouped by `csvUploadId` when present
- Default window: last 30 days

### API: `/api/reconciliation/activity/[id]/undo`

- `POST` — reverses the action and writes a counter-entry with `reverted_at` and `reverted_by_action_id`
- `claim_create` → deletes the claim link, unmarks processed (if no other claims on that hash)
- `claim_delete` → re-creates the claim link
- `processed_create` → removes from `processed_transactions`
- Already-reverted actions return an error

---

## Bulk Approve

### UI

Filter chips above the review list:
- **All** — all review rows
- **High confidence** — `suggested_match` rows with `confidenceScore >= 1.4` and score margin >= 0.5
- **Suggested** — all `suggested_match` rows
- **Transfers** — `transfer` and `questionable_match_fuzzy` rows

A master "Select all visible" checkbox selects all bulk-approvable rows matching the current filter. Individual checkboxes per row. A sticky "Approve N selected" button appears when any rows are selected.

### `handleBulkApprove(selectedMatches)`

1. Generates one `bulkActionId` (UUID)
2. For each selected match, calls the same approval path as `handleApprove` (single-row), threaded with `bulkActionId`
3. Partial failures are surfaced via `bulkError` — successful items commit, failed items remain in review
4. After completion, clears `bulkSelected`

### State

```typescript
bulkFilter: BulkFilter          // current filter chip selection
bulkSelected: Set<string>       // bank tx IDs selected for bulk approve
bulkApproving: boolean          // spinner during bulk operation
bulkError: string               // error message after partial failure
```

---

## API Routes

### `POST /api/reconciliation/match`

- **In:** `{ accountName, rows: string[][], sheetExpenses, sheetTransfers, processedHashes? }`
- **Out:** `{ bankTransactions: BankTransaction[], matches: MatchResult[] }`
- Fetches merchant memory for account, fetches existing claim links, restores claimed bank hashes as `exact_match`, runs `findMatches()` on the remainder
- Imports `PROFILE_BY_ACCOUNT` from `services/reconciliationService.ts` (shared with the CSV identity helpers)

### `GET /api/reconciliation/claims`

- **Out:** `{ claims: ClaimRow[], claimedRowIds: string[] }` — claimedRowIds in `"sheetName:sheetRowId"` format
- Returns all claims (no date filter — needed for full match restoration)

### `POST /api/reconciliation/claims`

- **In:** `{ bankTransaction: { hash, accountName, amount, date, description }, links: [{ sheetName, sheetRowId, amount }], actor?, csvUploadId?, bulkActionId?, parentActionId? }`
- Validates amounts sum to bank transaction amount; inserts claim_links + processed_transactions in one transaction, plus activity log row
- Returns 409 if sheet row already claimed by a different bank hash

### `DELETE /api/reconciliation/claims`

- **In:** `{ bankTransaction: { hash, accountName }, actor?, ... }`
- Deletes all claim links for that bank hash; logs `claim_delete` activity

### `GET /api/reconciliation/transfer-claims`

- **Out:** `{ claims: TransferClaimRow[], statusByRowId: Record<transferRowId, { claimedCount, expectedLegs, isComplete }> }`

### `POST /api/reconciliation/transfer-claims`

- **In:** `{ transferRowId, expectedLegs: 1|2, bankTransaction: { hash, accountName, amount } }`
- Validates: new leg must have opposite sign if 2-leg transfer; returns 409 if complete

### `GET|POST|DELETE /api/reconciliation/processed`

- GET: `{ hashes: string[] }`
- POST: `{ hash, accountName?, csvUploadId?, actor? }` — mark processed + log activity
- DELETE: `{ hash, accountName? }` — unmark processed

### `GET|POST /api/reconciliation/dismissals`

- POST: `{ hash, accountName, note }` — dismisses bank transaction + marks processed atomically

### `GET|POST /api/reconciliation/user-dismissals`

- POST: `{ sheetName, sheetRowId, note }`

### `GET|POST /api/reconciliation/anchors`

- POST: `{ accountName, confirmedBalance, asOfDate }`

### `GET|POST /api/reconciliation/memory`

- GET: returns all memory entries
- POST: `{ fingerprint, bankAccountName, sheetCategory?, sheetAccount? }` — upsert + increment `confirmed_count`
- DELETE: `{ fingerprint, bankAccountName }` — remove entry

### `GET /api/reconciliation/activity`

- `?since=YYYY-MM-DD` — returns log entries; defaults to 30 days back

### `POST /api/reconciliation/activity/[id]/undo`

- Reverses a single action; writes counter-log entry

### `POST /api/reconciliation/match-cache`

- **In:** `{ accountName, matches: MatchResult[], replace?: boolean }`
- `replace: true` deletes all cache rows for account first

### `GET|POST /api/reconciliation/csv-rows`

- GET: `{ rowsByAccount: Record<string, string[][]> }` — all stored CSV rows per account
- **POST `merge` mode** (`{ accountName, rows: incomingRows, merge: true }`) — the primary path used by `onDrop`:
  - Reads existing stored rows, identity-merges incoming via `mergeCsvRowsByIdentity` (collapses re-imported transactions, keeps genuine duplicates)
  - **Replaces** the account's stored rows with the merged set (DELETE rides with the first insert chunk; chunked at `CSV_SAVE_CHUNK_SIZE = 15`)
  - Returns `{ rows: mergedRows }`
  - Because the server reads existing rows from the table, there is no "upload before the in-memory ref loaded" race
- **POST legacy append mode** (`{ accountName, rows }`, no `merge`) — occurrence-indexed full-row keys; kept only for the one-time localStorage migration

### `POST /api/reconciliation/dedupe`

- **In:** `{ accountName }`
- Removes **already-reconciled duplicate** CSV rows: groups stored rows by base identity (hash without the `-N` suffix); an *unresolved* row is dropped when a same-identity sibling is **resolved** (claimed / transfer-claimed / processed / dismissed). Count-based, so genuine duplicates with no resolved sibling are preserved.
- Replaces the account's stored CSV rows with the kept set and deletes the removed copies from `reconciliation_match_cache`
- **Out:** `{ removedHashes, removedCount, rows }`
- Triggered by the "Remove duplicate rows" button (`handleRemoveDuplicateRows`)

### `GET|POST|DELETE /api/reconciliation/uploaded-files`

- GET: `{ filesByAccount: Record<string, string[]> }` — file names per account
- POST: `{ accountName, fileName, bankHashes?: string[] }` — records upload; stores bank tx hashes so the file can be selectively cleared. Upserts on conflict (re-uploading same file name updates the stored hashes).
- DELETE: `{ accountName, fileName }` — clears all reconciliation state for that file:
  - Bulk-deletes from `claim_links`, `transfer_claim_links`, `processed_transactions`, `statement_dismissals`, `match_cache` for all stored bank hashes
  - Deletes the file record
  - Returns `{ clearedHashes: string[] }`

### `POST /api/reconciliation/reset`

- Truncates all reconciliation tables (used from reset modal)

---

## Page State Architecture (`page.tsx`)

### View Modes

- `"home"` — two-column dashboard: incomplete user entries + matched entries (left) | account summaries (right)
- `"accountDetail"` — CSV upload zone + review/matched/closed sections for one account

### Rendering Structure

```
{viewMode === "accountDetail" && <upload zone + file list>}   // always top when in account detail
{viewMode === "home" ? <home view> : <account detail sections>}
```

The **Files** panel (top of account detail) lists uploaded files (✕ to clear each) plus two maintenance buttons in its header:
- **Re-match from sheet** (`handleRematchFromSheet`) — runs `rematchAllStoredAccounts()` to re-link bank lines against the *current* sheet. Use after adding sheet expenses post-upload, or after a hash-change re-key. Exact matches move to Matched; the rest become suggested matches to bulk-approve.
- **Remove duplicate rows** (`handleRemoveDuplicateRows`) — calls `POST /dedupe` for the selected account.

Account detail sections (rendered in the ternary else branch):
1. **Unmatched / Suggested** — rows needing manual review; includes filter chips + bulk approve UI
2. **Matched to sheet** — `exact_match` rows with linked sheet entries; disconnect button per row
3. **Closed on statement (no sheet link)** — `processed` rows with no active claim; unmark button per row

After a CSV upload, `matchedSectionRef` is scrolled into view automatically so matched rows are immediately visible even when the review section is empty.

### State Groups

**Core match state**
```typescript
matchesByAccount: Record<string, MatchResult[]>
selectedAccount: AccountOption
activeTab: string
viewMode: "home" | "accountDetail"
```

**Sheet data**
```typescript
sheetExpenses: SheetRow[]
sheetTransfers: TransferRow[]
claimedRowKeys: Set<string>           // "sheetName:sheetRowId"
```

**Bank/Neon state**
```typescript
processedHashes: Set<string>
dismissalNotesById: Record<string, string>
bankHashesWithNeonClaim: Set<string>
transferClaimStatusByRowId: TransferClaimStatusByRowId
```

**User dismissals**
```typescript
userDismissedRowKeys: Set<string>
userDismissalNotesByEntryId: Record<string, string>
```

**Bulk approve**
```typescript
bulkFilter: BulkFilter              // "all" | "high_confidence" | "suggested" | "transfers"
bulkSelected: Set<string>           // bank tx IDs selected for bulk approve
bulkApproving: boolean
bulkError: string
```

**Scroll / UX**
```typescript
matchedSectionRef: RefObject<HTMLElement>   // ref to "Matched to sheet" section
shouldScrollToMatched: boolean              // triggers scroll after upload
```

**Maintenance buttons**
```typescript
rematching: boolean          // spinner on "Re-match from sheet"
removingDuplicates: boolean  // spinner on "Remove duplicate rows"
```

**In-memory CSV (ref, not state)**
```typescript
statementCsvRowsByAccountRef.current: Record<string, string[][]>
```
Used by `rematchAllStoredAccounts()` — survives re-renders without triggering them.

### Key `useMemo` Values

**`userInputtedEntries`** — combines expenses + transfers, marks each as "completed" if:
- Claimed to a bank hash, OR auto-matched by exact match, OR transfer is auto-completed, OR user-dismissed

**`statementReviewRowsByAccount`** — bank transactions needing manual review (unmatched, suggested, questionable, transfer). Excludes `processed` unless disconnected. Also applies **count-based duplicate suppression**: a pending row is hidden when the same transaction identity (base hash, ignoring the `-N` suffix) already appears as a matched/closed row for that account — preventing the same bank transaction from showing in both the Unmatched and Matched sections. Count-based so genuine duplicate purchases (no resolved sibling) are still shown. (Note: this only suppresses against matched rows currently *loaded*; matched rows older than the match-cache window aren't loaded — see hash-change recovery in Gotchas.)

**`statementAutoMatchedRowsByAccount`** — `exact_match` rows with linked sheet entries (`hasLinkedUserInputtedEntry`).

**`statementCompletedRowsByAccount`** — rows in `processedHashes` that aren't in the review set and aren't `isProcessedWithoutNeonClaim`.

**`activeUserLinkedMatchedRows`** — matched rows for the active account that have a sheet entry or Neon claim (`hasLinkedOrClaimedEntry`).

**`activeStatementClosedOnlyRows`** — matched rows for the active account with no sheet link (processed, no claim — e.g., dismissed or hash from a previous session with deleted expense).

**`homeFilteredIncompleteRows`** — user entries without a matched bank transaction (left column of home view).

**`homeFilteredMatchedRows`** — user entries with a linked bank transaction (middle column of home view).

---

## Key Handler Functions

### `handleApprove(match, userEntry?)`

- With `userEntry`: Links a specific sheet entry to a bank transaction
  - Validates amount match; POST `/claims` or `/transfer-claims`; POST `/processed`; records merchant memory
- Without `userEntry`: Auto-approves a suggested match
  - Opens transfer claim modal if match is a transfer; creates claim link if expense

### `handleBulkApprove(selectedMatches)`

- Generates `bulkActionId` UUID
- Calls individual approve logic per match, tagged with `bulkActionId`
- Surfaces partial failures in `bulkError`; clears `bulkSelected` on completion

### `handleDisconnectSheetLink(match)`

1. DELETE `/claims` and `/transfer-claims` for this bank hash
2. DELETE `/processed` for this bank hash
3. Call `rematchAllStoredAccounts()` to regenerate matches from stored CSV
4. Falls back to patching `matchType` to `"unmatched"` if no stored CSV available

### `handleSplitSubmit()`

- Links one bank transaction to multiple sheet rows
- Validates: all rows same type (all expenses OR all transfers); amounts sum to bank amount
- Creates one claim link per row

### `handleTransferClaimSubmit()`

- Claims a bank transaction as one leg of a transfer
- Triggers `rematchAllStoredAccounts()` after (expensive — re-runs `/match` for every stored account)

### `rematchAllStoredAccounts()`

- Iterates `statementCsvRowsByAccountRef.current`
- POST `/match` for each account with current sheet data + processedHashes
- Auto-approves any new `exact_match` with linked entries
- POST `/match-cache` to persist updated results

### `onDrop(files)`

1. Parses CSV with PapaParse, then POSTs to `/csv-rows` **`merge` mode** — the server identity-merges with stored rows, persists the replaced set, and returns `mergedCsv` (the client no longer merges or hashes; the old client-side `mergeCsvRowArrays`/`csvRowDedupeKey` were removed)
2. Generates `csvUploadId` UUID for audit grouping; sets `statementCsvRowsByAccountRef.current[account] = mergedCsv`
3. Fetches fresh sheet data + all Neon state (processed hashes, claims, dismissals)
4. POST `/match` with `mergedCsv` + fresh sheet data
5. Auto-approves all `exact_match` rows (calls `persistProcessedHash` with `csvUploadId`)
6. `setMatchesByAccount` with new results; `setShouldScrollToMatched(true)` triggers scroll to matched section
7. POST `/match-cache` to Neon (CSV rows were already persisted by the merge in step 1 — no separate `/csv-rows` save)
8. `setProcessedHashes` updated with auto-approved hashes
9. POST `/uploaded-files` with file name **and `bankHashes`** (all tx hashes from this upload) so the file can later be selectively cleared

### `handleRematchFromSheet()`

- Confirms, then calls `rematchAllStoredAccounts()` (re-matches every stored account against the current sheet, `replace`-saving the match cache)
- Used to pick up sheet expenses added after upload, or to rebuild the view after a hash-change re-key

### `handleRemoveDuplicateRows(accountName)`

- Confirms, then `POST /dedupe`; removes the returned `removedHashes` from `matchesByAccount` and updates `statementCsvRowsByAccountRef` with the returned cleaned rows
- Reports how many rows were removed

### `handleClearFile(accountName, fileName)`

- Shows a browser `confirm` dialog; on confirm calls DELETE `/api/reconciliation/uploaded-files`
- Receives `clearedHashes: string[]` from the API
- Surgically removes cleared hashes from `processedHashes`, `matchesByAccount`, and `bankHashesWithNeonClaim` state (no full rematch needed)
- Removes the file from `uploadedFilesByAccount`
- UI: ✕ button next to each file name in the Files panel

### `recordMerchantMemory(match, userEntry?)`

- Computes fingerprint from bank transaction description + amount
- POST `/api/reconciliation/memory` to upsert and increment `confirmed_count`
- Called from `handleApprove`, `handleSplitSubmit`, `handleTransferClaimSubmit`

---

## Key Workflows

### Standard Reconciliation

1. Select account from dropdown (switches to account detail view)
2. Upload bank CSV (drag-and-drop)
3. High-confidence transactions auto-match (`exact_match`); page auto-scrolls to "Matched to sheet"
4. Review remaining rows in "Unmatched / Suggested" section
5. Approve suggested matches individually or use Bulk Approve
6. Dismiss bank transactions that need no sheet entry (fees, refunds)
7. All rows become processed and appear in "Matched to sheet" or "Closed on statement"

### Bulk Approve

1. Accumulate review rows; select filter chip (e.g., "High confidence")
2. "Select all visible" → "Approve N selected"
3. All selected rows get claim links created atomically with a shared `bulkActionId`
4. Partial failures shown inline; successful rows disappear from review

### Merchant Memory Auto-Claim

1. Claim Netflix-$15.99 manually once → `confirmed_count = 1`
2. Claim it again the next month → `confirmed_count = 2`
3. Next month's upload: the transaction is auto-claimed at match time, never enters review
4. Open Memory panel to view or delete entries

### Split Claim

1. One bank transaction covers multiple sheet expenses (e.g., $200 + $300 = $500)
2. Open split modal, select both expense rows
3. System validates totals match; creates two claim links under same bank hash

### Transfer Claim (2-leg)

1. User records a $1000 transfer Checking → Savings in Sheets
2. Upload Checking CSV: `-$1000` → matches transfer, claim leg 1 (`expectedLegs=2`)
3. `rematchAllStoredAccounts()` runs
4. Upload Savings CSV: `+$1000` → matches same transfer, claim leg 2
5. Transfer status: `claimedCount=2`, `isComplete=true`

### Disconnect & Re-reconcile

1. Wrong claim exists; click disconnect (orange icon on matched row)
2. System removes claim + unmarks processed
3. `rematchAllStoredAccounts()` re-runs all stored CSVs against current sheet state
4. Bank row reappears in review with updated candidates

### Activity Log & Undo

1. Click "Activity" button to open the activity log modal
2. Log loads last 30 days of actions on first open
3. Each action has an "Undo" button (greyed if already reverted)
4. Undoing a `claim_create` removes the claim link and unmarks processed
5. Undoing a `processed_create` removes the hash from `processed_transactions`

### Clear a Specific File

1. Click the ✕ next to a file name in the Files panel
2. Browser confirm dialog
3. DELETE `/api/reconciliation/uploaded-files` removes all claim links, transfer claims, processed markers, dismissals, and cache entries for that file's bank transactions
4. File disappears from the Files list; affected transactions drop out of the matched/closed sections
5. Re-upload the file to re-reconcile from scratch

### Re-match an Account Against the Current Sheet

Use when you added/edited sheet expenses *after* uploading a statement, so the cached matches are stale and bank lines sit in "Unmatched" despite having a matching expense.

1. Open the account; click **Re-match from sheet** (Files panel header)
2. `rematchAllStoredAccounts()` re-runs `/match` for every stored account against the current sheet and `replace`-saves the cache
3. Exact same-day matches auto-link; the rest become suggested matches → clear them with Bulk Approve (Suggested filter)

### Remove Already-Reconciled Duplicate Rows

Use when overlapping legacy uploads left duplicate copies of already-matched transactions in "Unmatched".

1. Open the account; click **Remove duplicate rows**
2. `POST /dedupe` drops unresolved CSV rows whose identity already has a resolved sibling (count-based) and clears their match-cache entries
3. The duplicates leave the Unmatched section; genuine still-unmatched transactions remain

### Recovering Orphaned Records After a Hash Change

When a `cleanBankDescription`/hash change orphans claim/processed records (reconciled transactions reappear as "Unmatched / No candidate match"), re-key the old hashes to the current ones instead of clearing:

1. Confirm scope with a read-only check: for each account, parse stored `csv_rows` with the **current** `mapBankRowsToTransactions` (current hashes) and with the **old** module version (`git show <pre-change-commit>:services/reconciliationService.ts`) to get old hashes; align old→new by the shared `tx.raw` row reference. Count how many `claim_links.bank_hash` / `processed_transactions.hash` are orphaned vs recoverable. (Top-level await isn't supported under tsx's cjs transform — wrap the script in an `async main()`.)
2. Re-key (one-off `tsx` script against `DATABASE_URL`): for each unambiguous old→new pair, `UPDATE` the hash in `reconciliation_claim_links`, `processed_transactions`, `reconciliation_transfer_claim_links`, `reconciliation_statement_dismissals`. **Conflict-safe:** if the new hash already exists in a table, `DELETE` the redundant old row instead of updating (avoids PK/unique violations). Wrap each account's writes in `sql.transaction([...])` so it's atomic and idempotent (re-runnable).
3. Have the user click **Re-match from sheet** so the cache rebuilds and the re-keyed claims restore as `exact_match`.

This was used to recover WF Checking (92 claims + 101 processed, 0 ambiguous mappings) without re-doing any reconciliation. Hash inputs are unchanged by the re-key, so going forward records stay valid.

---

## Important Invariants & Gotchas

- **Hash stability is critical.** All existing Neon records key off SHA256(date|amount|cleaned-description). The cleaned description now includes `#NNNN` suffix tags for stripped long digit sequences (e.g., `"DELTA #9836"`). Any change to `cleanBankDescription` changes hashes and **orphans** existing claim/processed/transfer-claim/dismissal records — they point at hashes the current parser no longer produces. Symptom: transactions you already reconciled reappear in "Unmatched" with "No candidate match" (the linked sheet expense is still flagged claimed, so it's excluded from the matching pool). **Prefer re-keying over clear/Reset** so months of work aren't lost — see "Recovering orphaned records after a hash change".

  Known incident: commit `d1077b9` changed `cleanBankDescription` (long digit sequences went from *removed* → tagged `#NNNN`). This only affected Wells Fargo descriptions (the long auth codes) and orphaned ~92 WF Checking claims + ~101 processed records, recovered by the re-key below.

- **One expense row per claim.** `UNIQUE(sheet_name, sheet_row_id)` on `reconciliation_claim_links`. Attempting to link the same sheet row to two bank hashes returns 409.

- **One bank hash per transfer leg.** `UNIQUE(bank_hash)` on `reconciliation_transfer_claim_links`. The same `transfer_sheet_row_id` appears twice (two legs).

- **Transfer claim triggers full rematch.** `handleTransferClaimSubmit()` calls `rematchAllStoredAccounts()` which hits `/match` once per account. Expensive with many stored accounts.

- **Ambiguous clusters never auto-match.** Two transactions with same amount, similar description, within 1 day — both require manual review regardless of confidence.

- **`processedHashes` prevents rematch loops.** When `rematchAllStoredAccounts()` calls `/match`, it passes current `processedHashes`. The match route skips these, preventing already-resolved transactions from re-entering review.

- **`lib/activityLog.ts` is server-only.** It imports `randomUUID` from Node.js `crypto`. Never import it in client components or browser-executed code. Merchant fingerprinting uses `lib/merchantFingerprint.ts` instead, which has no Node.js deps.

- **`lib/merchantFingerprint.ts` is browser-safe.** Generates fingerprints without `crypto`. Can be imported by both `page.tsx` and server-side routes.

- **Match route restores claims before running algorithm.** Bank hashes that have Neon claim links are pulled out and returned as `exact_match` before `findMatches()` runs. Only unclaimed transactions go through the algorithm. This means re-uploading the same CSV after a session always shows the same matched state.

- **Wells Fargo year boundary.** Date derivation from description handles Dec→Jan wraparound. `PURCHASE AUTHORIZED ON 12/31` in a January posting date → assigned to prior year.

- **Neon HTTP driver chunk limit.** Bulk inserts use `NEON_SAVE_CHUNK_SIZE` to split large arrays across multiple per-row transactions, working around the Neon serverless HTTP driver's payload limits.

- **Amount sign convention.** Bank amounts are signed: negative = debit/outgoing, positive = credit/incoming. Sheet expense amounts are always positive. Transfer amounts are positive; directionality comes from `transferFrom`/`transferTo`.

- **CSV merge strategy (server-side, identity-based).** New uploads are merged on the server (`POST /csv-rows` `merge` mode) by **transaction identity** (date+amount+description), not by full raw row. Re-importing an overlapping statement collapses the repeated transaction onto its existing copy even when a non-identifying column (e.g. running balance) differs; genuine duplicate lines within one file are still kept (distinct occurrence-disambiguated hashes). The client no longer merges/hashes (the service is not browser-safe). See "Transaction Identity & CSV Dedup". Legacy duplicates already in storage are not auto-collapsed — use **Remove duplicate rows** / `POST /dedupe`.

- **`isProcessedWithoutNeonClaim`** — returns true if a bank hash is in `processedHashes` AND not in `bankHashesWithNeonClaim` AND not dismissed. These rows appear in the review section (not matched), flagged as needing re-reconciliation.

- **Auto-scroll after upload.** `setShouldScrollToMatched(true)` is set in `onDrop` after `setMatchesByAccount`. A `useEffect` watching `shouldScrollToMatched` fires `matchedSectionRef.current?.scrollIntoView()`. This ensures the "Matched to sheet" section is visible even when the review section is empty (all transactions already reconciled).

- **WF legacy bucket.** The `LEGACY_WF_PROFILE_BUCKET` key ("Wells Fargo") may appear in `matchesByAccount` from old cached data. `mergeWellsFargoBucketIntoChecking()` merges these rows into "WF Checking" on load and on state changes.
