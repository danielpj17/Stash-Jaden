"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { Ban, Check, Filter, Link2Off, Loader2, Pencil, PlusCircle, Search, Upload, X } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import GlassDropdown, { type GlassDropdownOption } from "@/components/GlassDropdown";
import {
  getExpenses,
  getTransfers,
  submitExpense,
  updateSheetEntryDate,
  type SheetRow,
  type TransferRow,
} from "@/services/sheetsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import type { BankTransaction, MatchResult, CsvFormat } from "@/services/reconciliationService";
import { generateMerchantFingerprint } from "@/lib/merchantFingerprint";
import {
  computeAccountBalances,
  getAccountAnchors,
} from "@/services/accountBalancesService";
import { useAccounts } from "@/contexts/AccountsContext";
import CsvMappingModal from "@/components/CsvMappingModal";
import { RECONCILIATION_RESET_CONFIRM } from "@/lib/reconciliationReset";

/** Account names are user-defined now; this is just a string. */
type AccountOption = string;

type MatchResponse = {
  bankTransactions: BankTransaction[];
  matches: MatchResult[];
};

type QuickAddState = {
  open: boolean;
  rowId: string | null;
  expenseType: string;
  amount: string;
  description: string;
  submitting: boolean;
  error: string;
};

type SplitDraftLine = {
  key: string;
  sheetName: "Expenses" | "Transfers";
  rowId: string;
  amount: number;
  expenseType: string;
  description: string;
  timestamp?: string;
  date?: string;
  account?: string;
  transferFrom?: string;
  transferTo?: string;
};

type SplitModalState = {
  open: boolean;
  rowId: string | null;
  selectedKeys: string[];
  candidates: SplitDraftLine[];
  /** Used when claiming a Transfers sheet row (1 vs 2 bank legs). */
  transferExpectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type TransferClaimModalState = {
  open: boolean;
  rowId: string | null;
  expectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
  pendingClaimSource: null | "manual" | "split";
};

type TransferClaimStatusByRowId = Record<
  string,
  { claimedCount: number; expectedLegs: number; isComplete: boolean }
>;

type ReconcileViewMode = "home" | "accountDetail";

type UserInputtedEntry = {
  id: string;
  source: "Expenses" | "Transfers";
  dateValue: string;
  title: string;
  subtitle: string;
  amount: number;
  isCompleted: boolean;
  /** Sheet "account" column for expense rows; used by home account filter. */
  expenseAccount?: string;
  transferFrom?: string;
  transferTo?: string;
};

type AnchorModalState = {
  open: boolean;
  date: string;
  balance: string;
  loading: boolean;
  saving: boolean;
  error: string;
};

type EditEntryModalState = {
  open: boolean;
  entry: UserInputtedEntry | null;
  rowId: string;
  date: string;
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

type UserDismissModalState = {
  open: boolean;
  entry: UserInputtedEntry | null;
  note: string;
  submitting: boolean;
  error: string;
};

type ResetReconcileModalState = {
  open: boolean;
  confirmText: string;
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

const ALL_ACCOUNTS_OPTION = "All";
const RECONCILE_STORAGE_KEY = "reconcile-page-state-v3";

// Built-in CSV parsers (BANK_PROFILES) that work without a saved csv_format. These
// match the legacy hard-coded account names; new accounts configure their own mapping.
const LEGACY_PARSER_READY_ACCOUNTS = new Set<string>([
  "WF Checking",
  "WF Savings",
  "Venmo - Daniel",
  "Venmo - Katie",
  "Capital One",
]);

function claimKey(sheetName: string, rowId: string): string {
  return `${sheetName}:${rowId}`;
}

/** Extracts the raw sheet row ID from an entry id like `"Expenses:uuid"` → `"uuid"`. */
function rowIdFromEntryId(entryId: string): string {
  const parsed = parseSheetDismissKeyFromEntryId(entryId);
  return parsed?.sheetRowId ?? "";
}

/** For dismiss/claim APIs: real sheet row only (not `Expenses:missing:0`). */
function parseSheetDismissKeyFromEntryId(
  entryId: string,
): { sheetName: "Expenses" | "Transfers"; sheetRowId: string } | null {
  const firstColon = entryId.indexOf(":");
  if (firstColon === -1) return null;
  const sheetPrefix = entryId.slice(0, firstColon);
  if (sheetPrefix !== "Expenses" && sheetPrefix !== "Transfers") return null;
  const rest = entryId.slice(firstColon + 1);
  if (rest.startsWith("missing:")) return null;
  return { sheetName: sheetPrefix, sheetRowId: rest };
}

function idForTx(tx: BankTransaction): string {
  return `${tx.accountName}|${tx.hash}`;
}

/** Legacy bucket: CSV used BANK_PROFILES key "Wells Fargo"; UI accounts are WF Checking / WF Savings only. */
const LEGACY_WF_PROFILE_BUCKET = "Wells Fargo";

function mergeWellsFargoBucketIntoChecking(
  prev: Record<string, MatchResult[]>,
): Record<string, MatchResult[]> {
  const legacy = prev[LEGACY_WF_PROFILE_BUCKET];
  if (legacy === undefined) return prev;
  if (!legacy.length) {
    const next = { ...prev };
    delete next[LEGACY_WF_PROFILE_BUCKET];
    return next;
  }

  const checkingKey: AccountOption = "WF Checking";
  const retagged = legacy.map((m) => ({
    ...m,
    bankTransaction: {
      ...m.bankTransaction,
      accountName: checkingKey,
    },
  }));

  const existing = prev[checkingKey] ?? [];
  const byHash = new Map<string, MatchResult>();
  for (const row of existing) {
    byHash.set(row.bankTransaction.hash, row);
  }
  for (const row of retagged) {
    if (!byHash.has(row.bankTransaction.hash)) {
      byHash.set(row.bankTransaction.hash, row);
    }
  }

  const next: Record<string, MatchResult[]> = { ...prev };
  delete next[LEGACY_WF_PROFILE_BUCKET];
  next[checkingKey] = Array.from(byHash.values());
  return next;
}

/** Merge match arrays by hash; incoming rows replace older versions of same hash. */
function mergeMatchArrays(existing: MatchResult[] | undefined, incoming: MatchResult[]): MatchResult[] {
  const byHash = new Map<string, MatchResult>();
  for (const row of existing ?? []) {
    byHash.set(row.bankTransaction.hash, row);
  }
  for (const row of incoming) {
    byHash.set(row.bankTransaction.hash, row);
  }
  return Array.from(byHash.values());
}

function parseStoredStatementCsvRows(raw: unknown): Record<string, string[][]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next: Record<string, string[][]> = {};
  for (const [accountName, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const normalizedRows = rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => row.map((cell) => String(cell ?? "")));
    if (normalizedRows.length > 0) {
      next[accountName] = normalizedRows;
    }
  }
  return next;
}

function fmtMoney(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(raw?: string): string {
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-US");
}

function sortByNewestDate<T>(rows: T[], getDate: (row: T) => string | undefined): T[] {
  return [...rows].sort((a, b) => {
    const aTime = Date.parse(getDate(a) ?? "");
    const bTime = Date.parse(getDate(b) ?? "");
    const safeATime = Number.isFinite(aTime) ? aTime : 0;
    const safeBTime = Number.isFinite(bTime) ? bTime : 0;
    return safeBTime - safeATime;
  });
}

function isStatementManualReview(match: MatchResult): boolean {
  return (
    match.matchType === "unmatched" ||
    match.matchType === "questionable_match_fuzzy" ||
    match.matchType === "suggested_match" ||
    match.matchType === "transfer"
  );
}

function hasLinkedUserInputtedEntry(match: MatchResult): boolean {
  return Boolean(match.matchedSheetExpense || match.matchedSheetTransfer);
}

function hasLinkedOrClaimedEntry(
  match: MatchResult,
  bankHashesWithNeonClaim: Set<string>,
): boolean {
  return hasLinkedUserInputtedEntry(match) || bankHashesWithNeonClaim.has(match.bankTransaction.hash);
}

/** Processed in Neon but no row in claim tables — should show in review, not "closed without sheet". */
function isProcessedWithoutNeonClaim(
  match: MatchResult,
  processedHashes: Set<string>,
  dismissalNotesById: Record<string, string>,
  bankHashesWithNeonClaim: Set<string>,
): boolean {
  const id = idForTx(match.bankTransaction);
  const hash = match.bankTransaction.hash;
  return (
    processedHashes.has(hash) &&
    !dismissalNotesById[id] &&
    !bankHashesWithNeonClaim.has(hash)
  );
}


function normalizeDateOnly(raw?: string): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeText(raw?: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildExpenseSignature(amount: number, dateRaw?: string, description?: string): string {
  return `${toCents(Math.abs(Number(amount) || 0))}|${normalizeDateOnly(dateRaw)}|${normalizeText(description)}`;
}

function buildTransferSignature(
  amount: number,
  dateRaw?: string,
  transferFrom?: string,
  transferTo?: string,
): string {
  return `${toCents(Math.abs(Number(amount) || 0))}|${normalizeDateOnly(dateRaw)}|${normalizeText(
    transferFrom,
  )}|${normalizeText(transferTo)}`;
}

/** Same date field order as `findMatches` / matched sheet payloads: timestamp, then date. */
function sheetExpenseDateRaw(row: Pick<SheetRow, "timestamp" | "date">): string {
  return String(row.timestamp ?? row.date ?? "").trim();
}

function buildSheetExpenseSignatureFromRow(row: {
  amount?: number;
  timestamp?: string;
  date?: string;
  description?: string;
}): string {
  const dr = sheetExpenseDateRaw(row);
  return buildExpenseSignature(Number(row.amount ?? 0), dr || undefined, row.description);
}

function sheetTransferDateRaw(row: Pick<TransferRow, "timestamp" | "date">): string {
  return String(row.timestamp ?? row.date ?? "").trim();
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function parseExpenseRowIdFromEntryId(id: string): string | null {
  if (!id.startsWith("Expenses:")) return null;
  const rest = id.slice("Expenses:".length);
  if (rest.startsWith("missing:")) return null;
  return rest || null;
}

function parseTransferRowIdFromEntryId(id: string): string | null {
  if (!id.startsWith("Transfers:")) return null;
  const rest = id.slice("Transfers:".length);
  if (rest.startsWith("missing:")) return null;
  return rest || null;
}

function dateDistanceInDaysSafe(a: string, b: string): number {
  const na = normalizeDateOnly(a);
  const nb = normalizeDateOnly(b);
  if (!na || !nb) return 9999;
  const da = Date.parse(na);
  const db = Date.parse(nb);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 9999;
  return Math.abs(Math.round((db - da) / (86400 * 1000)));
}

function findBestStatementMatchForUserEntry(
  entry: UserInputtedEntry,
  reviewMatches: MatchResult[],
): MatchResult | null {
  const absAmt = Math.abs(entry.amount);
  const centsUser = toCents(absAmt);

  if (entry.source === "Expenses") {
    const rowId = parseExpenseRowIdFromEntryId(entry.id);
    if (rowId) {
      const direct = reviewMatches.find(
        (m) => String(m.matchedSheetExpense?.rowId ?? "").trim() === rowId,
      );
      if (direct) return direct;
    }
    const candidates = reviewMatches.filter(
      (m) => toCents(Math.abs(m.bankTransaction.amount)) === centsUser,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort(
      (a, b) =>
        dateDistanceInDaysSafe(a.bankTransaction.date, entry.dateValue) -
        dateDistanceInDaysSafe(b.bankTransaction.date, entry.dateValue),
    )[0];
  }

  if (entry.source === "Transfers") {
    const rowId = parseTransferRowIdFromEntryId(entry.id);
    if (rowId) {
      const direct = reviewMatches.find(
        (m) => String(m.matchedSheetTransfer?.transferRowId ?? "").trim() === rowId,
      );
      if (direct) return direct;
    }
    const candidates = reviewMatches.filter(
      (m) => toCents(Math.abs(m.bankTransaction.amount)) === centsUser,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort(
      (a, b) =>
        dateDistanceInDaysSafe(a.bankTransaction.date, entry.dateValue) -
        dateDistanceInDaysSafe(b.bankTransaction.date, entry.dateValue),
    )[0];
  }

  return null;
}

function parseCsvFile(file: File): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete(results) {
        if (results.errors.length > 0) {
          reject(new Error(results.errors[0]?.message || "Failed to parse CSV."));
          return;
        }
        const rows = (results.data ?? []).filter(
          (row): row is string[] => Array.isArray(row) && row.some((cell) => String(cell).trim() !== ""),
        );
        resolve(rows);
      },
      error(error) {
        reject(error);
      },
    });
  });
}

const NEON_SAVE_CHUNK_SIZE = 15;

// Phase 1 loading strategy: rolling 30-day window for completed matches.
// Suggested/unmatched/questionable matches are always returned regardless of date.
// "Load more" extends the watermark backwards in 30-day jumps.
const MATCH_CACHE_DEFAULT_DAYS = 30;
const MATCH_CACHE_LOAD_MORE_DAYS = 30;

function filterMatchForBulk(
  match: MatchResult,
  filter: "all" | "high_confidence" | "suggested" | "transfers",
): boolean {
  if (filter === "all") return true;
  if (filter === "high_confidence") {
    return (
      match.matchType === "suggested_match" &&
      Boolean(match.matchedSheetExpense?.rowId) &&
      (match.confidenceScore ?? 0) >= 1.0
    );
  }
  if (filter === "suggested") return match.matchType === "suggested_match";
  if (filter === "transfers") {
    return (
      match.matchType === "transfer" ||
      (match.matchType === "questionable_match_fuzzy" && Boolean(match.matchedSheetTransfer))
    );
  }
  return true;
}

function summarizeActivityPayload(actionType: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, any>;
  switch (actionType) {
    case "claim_create":
    case "quick_log": {
      const links = Array.isArray(p.links) ? p.links : [];
      const linkSummary = links
        .map((l: any) => `${l.sheetName ?? "?"}:${l.sheetRowId ?? "?"} ($${((l.amountCents ?? 0) / 100).toFixed(2)})`)
        .join(", ");
      return `${p.accountName ?? "—"} • $${(p.bankAmount ?? 0).toFixed?.(2) ?? p.bankAmount} • ${p.bankDate ?? ""}\n${p.bankDescription ?? ""}\n→ ${linkSummary}`;
    }
    case "claim_delete":
      return `Removed claims for hash ${String(p.bankHash ?? "").slice(0, 12)}…`;
    case "transfer_claim_create":
      return `Transfer leg: row ${p.transferRowId ?? "?"} • $${((p.bankAmountCents ?? 0) / 100).toFixed(2)} • ${p.bankAccountName ?? "—"}`;
    case "transfer_claim_delete":
      return `Removed transfer claim for hash ${String(p.bankHash ?? "").slice(0, 12)}…`;
    case "dismiss_create":
      return `Dismissed ${p.accountName ?? "—"}: ${p.note ?? ""}`;
    case "dismiss_delete":
      return `Removed dismissal for hash ${String(p.hash ?? "").slice(0, 12)}…`;
    case "user_dismiss_create":
      return `Dismissed sheet row ${p.sheetName}:${p.sheetRowId} — ${p.note ?? ""}`;
    case "user_dismiss_delete":
      return `Restored sheet row ${p.sheetName}:${p.sheetRowId}`;
    case "processed_mark":
      return `Marked processed: ${String(p.hash ?? "").slice(0, 12)}…`;
    case "processed_unmark":
      return `Unmarked processed: ${String(p.hash ?? "").slice(0, 12)}…`;
    default:
      return JSON.stringify(p, null, 2).slice(0, 240);
  }
}

function formatSinceDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function saveMatchCacheToNeon(
  accountName: string,
  matches: MatchResult[],
  replace = false,
): Promise<void> {
  if (matches.length <= NEON_SAVE_CHUNK_SIZE) {
    const res = await fetch("/api/reconciliation/match-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountName, matches, replace }),
    });
    if (!res.ok) throw new Error(`match-cache save failed (${res.status})`);
    return;
  }
  for (let i = 0; i < matches.length; i += NEON_SAVE_CHUNK_SIZE) {
    const chunk = matches.slice(i, i + NEON_SAVE_CHUNK_SIZE);
    const isFirst = i === 0;
    const res = await fetch("/api/reconciliation/match-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountName, matches: chunk, replace: replace && isFirst }),
    });
    if (!res.ok) throw new Error(`match-cache save failed (${res.status})`);
  }
}

async function saveCsvRowsToNeon(accountName: string, rows: string[][]): Promise<void> {
  if (rows.length <= NEON_SAVE_CHUNK_SIZE) {
    const res = await fetch("/api/reconciliation/csv-rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountName, rows }),
    });
    if (!res.ok) throw new Error(`csv-rows save failed (${res.status})`);
    return;
  }
  for (let i = 0; i < rows.length; i += NEON_SAVE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + NEON_SAVE_CHUNK_SIZE);
    const res = await fetch("/api/reconciliation/csv-rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountName, rows: chunk }),
    });
    if (!res.ok) throw new Error(`csv-rows save failed (${res.status})`);
  }
}

export default function ReconcilePage() {
  const { accounts, reconcileAccountNames, refresh: refreshAccounts } = useAccounts();
  const ACCOUNT_OPTIONS = reconcileAccountNames;
  const ACCOUNT_DROPDOWN_OPTIONS: GlassDropdownOption[] = useMemo(
    () => [
      { value: ALL_ACCOUNTS_OPTION, label: ALL_ACCOUNTS_OPTION },
      ...reconcileAccountNames.map((a) => ({ value: a, label: a })),
    ],
    [reconcileAccountNames],
  );
  /** A CSV parser is "configured" for known built-in banks (legacy names) or any account with a saved csv_format. */
  const accountHasConfiguredParser = useCallback(
    (account: string): boolean => {
      const acct = accounts.find((a) => a.name === account);
      if (acct?.csvFormat && (acct.csvFormat as { configured?: boolean }).configured) return true;
      return LEGACY_PARSER_READY_ACCOUNTS.has(account);
    },
    [accounts],
  );
  const accountSeeds = useMemo(
    () =>
      accounts.map((a) => ({
        name: a.name,
        openingBalance: a.openingBalance,
        openingBalanceDate: a.openingBalanceDate,
      })),
    [accounts],
  );

  const [selectedAccount, setSelectedAccount] = useState<AccountOption>("");
  const [isUploading, setIsUploading] = useState(false);
  const [removingDuplicates, setRemovingDuplicates] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const matchedSectionRef = useRef<HTMLElement | null>(null);
  const [matchesByAccount, setMatchesByAccount] = useState<Record<string, MatchResult[]>>({});
  const [activeTab, setActiveTab] = useState<string>("");
  const [viewMode, setViewMode] = useState<ReconcileViewMode>("home");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accountParam = params.get("account");
    if (accountParam && reconcileAccountNames.includes(accountParam)) {
      setSelectedAccount(accountParam);
      setActiveTab(accountParam);
      setViewMode("accountDetail");
    }
  }, [reconcileAccountNames]);

  // Default the selected account to the first reconcilable account once accounts load.
  useEffect(() => {
    if (!selectedAccount && reconcileAccountNames.length > 0) {
      setSelectedAccount(reconcileAccountNames[0]);
      setActiveTab((prev) => prev || reconcileAccountNames[0]);
    }
  }, [reconcileAccountNames, selectedAccount]);
  const [dismissalNotesById, setDismissalNotesById] = useState<Record<string, string>>({});
  const [userDismissedRowKeys, setUserDismissedRowKeys] = useState<Set<string>>(new Set());
  const [userDismissalNotesByEntryId, setUserDismissalNotesByEntryId] = useState<Record<string, string>>(
    {},
  );
  const [processedHashes, setProcessedHashes] = useState<Set<string>>(new Set());
  const [disconnectedIds, setDisconnectedIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState("");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [sheetExpenses, setSheetExpenses] = useState<SheetRow[]>([]);
  const [sheetTransfers, setSheetTransfers] = useState<TransferRow[]>([]);
  const [uploadedFilesByAccount, setUploadedFilesByAccount] = useState<Record<string, string[]>>({});
  const [claimedRowKeys, setClaimedRowKeys] = useState<Set<string>>(new Set());
  /** Bank tx hashes that have a row in reconciliation_claim_links or reconciliation_transfer_claim_links. */
  const [bankHashesWithNeonClaim, setBankHashesWithNeonClaim] = useState<Set<string>>(new Set());
  const [transferClaimStatusByRowId, setTransferClaimStatusByRowId] =
    useState<TransferClaimStatusByRowId>({});
  /** Merged raw CSV rows per account — used to re-run /match for every account after a transfer leg claim. */
  const statementCsvRowsByAccountRef = useRef<Record<string, string[][]>>({});
  const [quickAdd, setQuickAdd] = useState<QuickAddState>({
    open: false,
    rowId: null,
    expenseType: "Misc.",
    amount: "",
    description: "",
    submitting: false,
    error: "",
  });
  const [splitModal, setSplitModal] = useState<SplitModalState>({
    open: false,
    rowId: null,
    selectedKeys: [],
    candidates: [],
    transferExpectedLegs: 2,
    submitting: false,
    error: "",
  });
  const [splitSearchQuery, setSplitSearchQuery] = useState("");
  const [homeSearchQuery, setHomeSearchQuery] = useState("");
  const [homeAccountFilter, setHomeAccountFilter] = useState<AccountOption | typeof ALL_ACCOUNTS_OPTION>(
    ALL_ACCOUNTS_OPTION,
  );
  const [userStatementClaimModal, setUserStatementClaimModal] = useState<UserStatementClaimModalState>({
    open: false,
    entry: null,
    selectedBankRowId: null,
    searchQuery: "",
    accountFilter: ALL_ACCOUNTS_OPTION,
    transferExpectedLegs: 2,
    submitting: false,
    error: "",
  });
  const [transferClaimModal, setTransferClaimModal] = useState<TransferClaimModalState>({
    open: false,
    rowId: null,
    expectedLegs: 2,
    submitting: false,
    error: "",
    pendingClaimSource: null,
  });
  const [anchorModal, setAnchorModal] = useState<AnchorModalState>({
    open: false,
    date: new Date().toISOString().slice(0, 10),
    balance: "",
    loading: false,
    saving: false,
    error: "",
  });
  const [csvMappingModal, setCsvMappingModal] = useState<{
    open: boolean;
    file: File | null;
    rows: string[][];
    saving: boolean;
    error: string;
  }>({ open: false, file: null, rows: [], saving: false, error: "" });
  const [dismissModal, setDismissModal] = useState<DismissModalState>({
    open: false,
    match: null,
    note: "",
    submitting: false,
    error: "",
  });
  const [userDismissModal, setUserDismissModal] = useState<UserDismissModalState>({
    open: false,
    entry: null,
    note: "",
    submitting: false,
    error: "",
  });
  const [editEntryModal, setEditEntryModal] = useState<EditEntryModalState>({
    open: false,
    entry: null,
    rowId: "",
    date: "",
    submitting: false,
    error: "",
  });
  const [resetReconcileModal, setResetReconcileModal] = useState<ResetReconcileModalState>({
    open: false,
    confirmText: "",
    submitting: false,
    error: "",
  });
  const [neonStateLoading, setNeonStateLoading] = useState(true);
  // Watermark: any completed match with updated_at >= this date has been loaded.
  // Suggested/unmatched/questionable matches are always loaded regardless of date.
  const [matchCacheSinceDate, setMatchCacheSinceDate] = useState<string>(() =>
    formatSinceDate(MATCH_CACHE_DEFAULT_DAYS),
  );
  const [loadingOlderMatches, setLoadingOlderMatches] = useState(false);

  // Bulk Approve state — Phase 6. Multi-select for the standing review queue.
  type BulkFilter = "all" | "high_confidence" | "transfers" | "suggested";
  const [bulkFilter, setBulkFilter] = useState<BulkFilter>("all");
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkError, setBulkError] = useState("");

  // Merchant Memory state — Phase 4.
  type MemoryEntry = {
    fingerprint: string;
    bankAccountName: string;
    sheetCategory: string | null;
    sheetAccount: string | null;
    confirmedCount: number;
    lastConfirmedAt: string;
  };
  const [memoryModal, setMemoryModal] = useState<{
    open: boolean;
    loading: boolean;
    entries: MemoryEntry[];
    error: string;
    forgettingKey: string | null;
  }>({
    open: false,
    loading: false,
    entries: [],
    error: "",
    forgettingKey: null,
  });

  // Activity Log state — Phase 3.
  type ActivityEntry = {
    id: string;
    occurredAt: string;
    actionType: string;
    actor: string;
    csvUploadId: string | null;
    bulkActionId: string | null;
    parentActionId: string | null;
    payload: Record<string, unknown>;
    revertedAt: string | null;
    revertedByActionId: string | null;
  };
  const [activityModal, setActivityModal] = useState<{
    open: boolean;
    loading: boolean;
    entries: ActivityEntry[];
    since: string;
    error: string;
    undoingId: string | null;
  }>({
    open: false,
    loading: false,
    entries: [],
    since: formatSinceDate(MATCH_CACHE_DEFAULT_DAYS),
    error: "",
    undoingId: null,
  });

  const loadOlderMatches = useCallback(async () => {
    if (loadingOlderMatches) return;
    setLoadingOlderMatches(true);
    try {
      const current = matchCacheSinceDate;
      const base = /^\d{4}-\d{2}-\d{2}$/.test(current)
        ? new Date(`${current}T00:00:00Z`)
        : new Date();
      base.setUTCDate(base.getUTCDate() - MATCH_CACHE_LOAD_MORE_DAYS);
      const nextSince = base.toISOString().slice(0, 10);

      const res = await fetch(`/api/reconciliation/match-cache?since=${nextSince}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { matchesByAccount?: Record<string, MatchResult[]> };
      const fetched =
        data.matchesByAccount && typeof data.matchesByAccount === "object" && !Array.isArray(data.matchesByAccount)
          ? data.matchesByAccount
          : {};
      setMatchesByAccount(mergeWellsFargoBucketIntoChecking(fetched));
      setMatchCacheSinceDate(nextSince);
    } catch {
      // Non-fatal; user can retry.
    } finally {
      setLoadingOlderMatches(false);
    }
  }, [loadingOlderMatches, matchCacheSinceDate]);

  const loadMemoryEntries = useCallback(async () => {
    setMemoryModal((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/memory", { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Memory fetch failed (${res.status})`);
      }
      const data = (await res.json()) as { entries?: MemoryEntry[] };
      setMemoryModal((prev) => ({
        ...prev,
        loading: false,
        entries: Array.isArray(data.entries) ? data.entries : [],
        error: "",
      }));
    } catch (err) {
      setMemoryModal((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load memory",
      }));
    }
  }, []);

  const openMemoryModal = useCallback(() => {
    setMemoryModal((prev) => ({ ...prev, open: true, error: "", forgettingKey: null }));
    void loadMemoryEntries();
  }, [loadMemoryEntries]);

  const closeMemoryModal = useCallback(() => {
    setMemoryModal((prev) => ({ ...prev, open: false }));
  }, []);

  const handleForgetMemoryEntry = useCallback(
    async (entry: MemoryEntry) => {
      const key = `${entry.fingerprint}|${entry.bankAccountName}`;
      setMemoryModal((prev) => ({ ...prev, forgettingKey: key, error: "" }));
      try {
        const res = await fetch("/api/reconciliation/memory", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fingerprint: entry.fingerprint,
            bankAccountName: entry.bankAccountName,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Forget failed (${res.status})`);
        }
        setMemoryModal((prev) => ({
          ...prev,
          forgettingKey: null,
          entries: prev.entries.filter(
            (e) => !(e.fingerprint === entry.fingerprint && e.bankAccountName === entry.bankAccountName),
          ),
        }));
      } catch (err) {
        setMemoryModal((prev) => ({
          ...prev,
          forgettingKey: null,
          error: err instanceof Error ? err.message : "Failed to forget pattern",
        }));
      }
    },
    [],
  );

  const loadActivityEntries = useCallback(async (since: string) => {
    setActivityModal((prev) => ({ ...prev, loading: true, error: "" }));
    try {
      const res = await fetch(`/api/reconciliation/activity?since=${since}`, { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Activity fetch failed (${res.status})`);
      }
      const data = (await res.json()) as { entries?: ActivityEntry[]; since?: string };
      setActivityModal((prev) => ({
        ...prev,
        loading: false,
        entries: Array.isArray(data.entries) ? data.entries : [],
        since: data.since ?? since,
        error: "",
      }));
    } catch (err) {
      setActivityModal((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load activity",
      }));
    }
  }, []);

  const openActivityModal = useCallback(() => {
    const initialSince = formatSinceDate(MATCH_CACHE_DEFAULT_DAYS);
    setActivityModal((prev) => ({
      ...prev,
      open: true,
      since: initialSince,
      entries: [],
      error: "",
      undoingId: null,
    }));
    void loadActivityEntries(initialSince);
  }, [loadActivityEntries]);

  const closeActivityModal = useCallback(() => {
    setActivityModal((prev) => ({ ...prev, open: false }));
  }, []);

  const loadOlderActivity = useCallback(() => {
    const current = activityModal.since;
    const base = /^\d{4}-\d{2}-\d{2}$/.test(current)
      ? new Date(`${current}T00:00:00Z`)
      : new Date();
    base.setUTCDate(base.getUTCDate() - MATCH_CACHE_LOAD_MORE_DAYS);
    const next = base.toISOString().slice(0, 10);
    void loadActivityEntries(next);
  }, [activityModal.since, loadActivityEntries]);

  const handleUndoActivity = useCallback(
    async (entry: ActivityEntry) => {
      if (entry.revertedAt) return;
      setActivityModal((prev) => ({ ...prev, undoingId: entry.id, error: "" }));
      try {
        const res = await fetch(`/api/reconciliation/activity/${entry.id}/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Undo failed (${res.status})`);
        }
        // Refresh activity list so the UI reflects reverted state.
        await loadActivityEntries(activityModal.since);
      } catch (err) {
        setActivityModal((prev) => ({
          ...prev,
          undoingId: null,
          error: err instanceof Error ? err.message : "Failed to undo",
        }));
        return;
      }
      setActivityModal((prev) => ({ ...prev, undoingId: null }));
    },
    [activityModal.since, loadActivityEntries],
  );

  const isBulkApprovableMatch = useCallback((match: MatchResult): boolean => {
    // Only suggested_match rows with a confident sheet candidate are bulk-approvable.
    // Transfers and questionable matches still require user judgment.
    if (match.matchType !== "suggested_match") return false;
    if (match.matchedSheetTransfer) return false; // Transfers need leg-direction validation.
    if (!match.matchedSheetExpense) return false;
    if (!match.matchedSheetExpense.rowId) return false;
    if ((match.confidenceScore ?? 0) < 1.0) return false;
    return true;
  }, []);

  const handleBulkApprove = useCallback(
    async (matchesToApprove: MatchResult[]) => {
      if (matchesToApprove.length === 0) return;
      setBulkApproving(true);
      setBulkError("");
      const bulkActionId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const results = await Promise.all(
        matchesToApprove.map(async (match) => {
          const tx = match.bankTransaction;
          const sheet = match.matchedSheetExpense;
          const rowId = sheet?.rowId?.trim();
          if (!rowId) return { id: idForTx(tx), ok: false, reason: "Missing row id" };
          try {
            const res = await fetch("/api/reconciliation/claims", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bankTransaction: {
                  hash: tx.hash,
                  accountName: tx.accountName,
                  amount: tx.amount,
                  date: tx.date,
                  description: tx.description,
                },
                links: [
                  { sheetName: "Expenses", sheetRowId: rowId, amount: Math.abs(tx.amount) },
                ],
                actor: "user",
                bulkActionId,
              }),
            });
            if (!res.ok) {
              const data = (await res.json().catch(() => ({}))) as { error?: string };
              return { id: idForTx(tx), ok: false, reason: data.error ?? `HTTP ${res.status}` };
            }
            // Memory increment (inlined to avoid forward-ref of recordMerchantMemory).
            try {
              const fingerprint = generateMerchantFingerprint(tx.description, tx.amount);
              void fetch("/api/reconciliation/memory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  fingerprint,
                  bankAccountName: tx.accountName,
                  sheetCategory: sheet?.expenseType ?? null,
                }),
              });
            } catch {
              // best-effort
            }
            return { id: idForTx(tx), ok: true, rowId, tx, sheet };
          } catch (err) {
            return {
              id: idForTx(tx),
              ok: false,
              reason: err instanceof Error ? err.message : "Network error",
            };
          }
        }),
      );

      const successful = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      if (successful.length > 0) {
        setProcessedHashes((prev) => {
          const next = new Set(prev);
          for (const r of successful) {
            if (r.tx) next.add(r.tx.hash);
          }
          return next;
        });
        setClaimedRowKeys((prev) => {
          const next = new Set(prev);
          for (const r of successful) {
            if (r.rowId) next.add(claimKey("Expenses", r.rowId));
          }
          return next;
        });
        const successIds = new Set(successful.map((r) => r.id));
        setMatchesByAccount((prev) => {
          const next: Record<string, MatchResult[]> = {};
          for (const [account, rows] of Object.entries(prev)) {
            next[account] = rows.map((row) => {
              const id = idForTx(row.bankTransaction);
              if (!successIds.has(id)) return row;
              return {
                ...row,
                matchType: "exact_match",
                reason: "Bulk approved.",
              };
            });
          }
          return next;
        });
        void refreshBankHashesWithNeonClaim();
      }

      setBulkSelected(new Set());
      setBulkApproving(false);
      if (failures.length > 0) {
        setBulkError(
          `Approved ${successful.length} of ${matchesToApprove.length}. ${failures.length} failed: ${failures
            .slice(0, 3)
            .map((f) => f.reason)
            .join("; ")}${failures.length > 3 ? "…" : ""}`,
        );
      }
    },
    [],
  );

  const refreshBankHashesWithNeonClaim = useCallback(async () => {
    try {
      const [claimsRes, transferRes] = await Promise.all([
        fetch("/api/reconciliation/claims", { cache: "no-store" }),
        fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
      ]);
      const next = new Set<string>();
      if (claimsRes.ok) {
        const data = (await claimsRes.json()) as { claims?: Array<{ bankHash?: string }> };
        for (const c of data.claims ?? []) {
          if (c.bankHash) next.add(String(c.bankHash));
        }
      }
      if (transferRes.ok) {
        const data = (await transferRes.json()) as { claims?: Array<{ bankHash?: string }> };
        for (const c of data.claims ?? []) {
          if (c.bankHash) next.add(String(c.bankHash));
        }
      }
      setBankHashesWithNeonClaim(next);
    } catch {
      // Non-fatal; reopen-review logic may be conservative until next refresh.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadFromNeon() {
      try {
        const initialSince = formatSinceDate(MATCH_CACHE_DEFAULT_DAYS);
        const [matchCacheRes, csvRowsRes] = await Promise.all([
          fetch(`/api/reconciliation/match-cache?since=${initialSince}`, { cache: "no-store" }),
          fetch("/api/reconciliation/csv-rows", { cache: "no-store" }),
        ]);
        if (cancelled) return;

        let neonMatches: Record<string, MatchResult[]> = {};
        let neonCsvRows: Record<string, string[][]> = {};

        if (matchCacheRes.ok) {
          const data = (await matchCacheRes.json()) as { matchesByAccount?: Record<string, MatchResult[]> };
          if (data.matchesByAccount && typeof data.matchesByAccount === "object" && !Array.isArray(data.matchesByAccount)) {
            neonMatches = data.matchesByAccount;
          }
        }
        if (csvRowsRes.ok) {
          const data = (await csvRowsRes.json()) as { rowsByAccount?: Record<string, string[][]> };
          if (data.rowsByAccount && typeof data.rowsByAccount === "object" && !Array.isArray(data.rowsByAccount)) {
            neonCsvRows = data.rowsByAccount;
          }
        }

        if (cancelled) return;

        const neonHasData = Object.keys(neonMatches).length > 0;

        if (!neonHasData && typeof window !== "undefined") {
          const raw = window.localStorage.getItem(RECONCILE_STORAGE_KEY);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as {
                selectedAccount?: string;
                activeTab?: string;
                matchesByAccount?: Record<string, MatchResult[]>;
                statementCsvRowsByAccount?: Record<string, unknown>;
              };

              const localMatches =
                parsed.matchesByAccount && typeof parsed.matchesByAccount === "object" && !Array.isArray(parsed.matchesByAccount)
                  ? (parsed.matchesByAccount as Record<string, MatchResult[]>)
                  : {};
              const localCsv = parseStoredStatementCsvRows(parsed.statementCsvRowsByAccount);
              const hasLocalData = Object.values(localMatches).some((arr) => arr.length > 0);

              if (hasLocalData) {
                let allSucceeded = true;
                for (const [accountName, matches] of Object.entries(localMatches)) {
                  if (matches.length > 0) {
                    try {
                      await saveMatchCacheToNeon(accountName, matches);
                    } catch {
                      allSucceeded = false;
                    }
                  }
                }
                for (const [accountName, rows] of Object.entries(localCsv)) {
                  if (rows.length > 0) {
                    try {
                      await saveCsvRowsToNeon(accountName, rows);
                    } catch {
                      allSucceeded = false;
                    }
                  }
                }

                if (cancelled) return;

                if (allSucceeded) {
                  window.localStorage.removeItem(RECONCILE_STORAGE_KEY);
                }

                neonMatches = localMatches;
                neonCsvRows = localCsv;
              }

              if (parsed.selectedAccount && ACCOUNT_OPTIONS.includes(parsed.selectedAccount as AccountOption)) {
                setSelectedAccount(parsed.selectedAccount as AccountOption);
              }
              if (typeof parsed.activeTab === "string" && parsed.activeTab.trim()) {
                setActiveTab(parsed.activeTab);
              }
            } catch {
              // Ignore corrupted localStorage during migration.
            }
          }
        }

        setMatchesByAccount(mergeWellsFargoBucketIntoChecking(neonMatches));
        statementCsvRowsByAccountRef.current = neonCsvRows;
      } catch {
        // Non-fatal; page works with empty state.
      } finally {
        if (!cancelled) setNeonStateLoading(false);
      }
    }

    void loadFromNeon();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setMatchesByAccount((prev) => mergeWellsFargoBucketIntoChecking(prev));
  }, [matchesByAccount[LEGACY_WF_PROFILE_BUCKET]?.length]);

  // localStorage persistence removed — Neon is the source of truth for matchesByAccount and CSV rows.

  useEffect(() => {
    let cancelled = false;

    async function loadProcessedAndDismissals() {
      try {
        const [processedRes, dismissalsRes, userDismissalsRes] = await Promise.all([
          fetch("/api/reconciliation/processed", { cache: "no-store" }),
          fetch("/api/reconciliation/dismissals", { cache: "no-store" }),
          fetch("/api/reconciliation/user-dismissals", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (processedRes.ok) {
          const data = (await processedRes.json()) as { hashes?: string[] };
          setProcessedHashes(new Set((data.hashes ?? []).map((hash) => String(hash))));
        }
        if (dismissalsRes.ok) {
          const data = (await dismissalsRes.json()) as {
            dismissals?: Array<{ hash: string; accountName: string; note: string }>;
          };
          const map: Record<string, string> = {};
          for (const d of data.dismissals ?? []) {
            map[`${d.accountName}|${d.hash}`] = d.note;
          }
          setDismissalNotesById(map);
        }
        if (userDismissalsRes.ok) {
          const data = (await userDismissalsRes.json()) as {
            dismissedKeys?: string[];
            dismissals?: Array<{ sheetName: string; sheetRowId: string; note: string }>;
          };
          const keys = new Set<string>((data.dismissedKeys ?? []).map((k) => String(k)));
          setUserDismissedRowKeys(keys);
          const noteMap: Record<string, string> = {};
          for (const d of data.dismissals ?? []) {
            noteMap[claimKey(d.sheetName, d.sheetRowId)] = d.note;
          }
          setUserDismissalNotesByEntryId(noteMap);
        }
      } catch {
        // Keep in-memory defaults if fetch fails.
      }
    }

    void loadProcessedAndDismissals();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUploadedFilesFromNeon() {
      try {
        const res = await fetch("/api/reconciliation/uploaded-files", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { filesByAccount?: Record<string, string[]> };
        if (cancelled) return;
        setUploadedFilesByAccount(data.filesByAccount ?? {});
      } catch {
        // Non-critical UI history can stay empty if unavailable.
      }
    }

    async function migrateLegacyLocalUploadedFiles() {
      if (typeof window === "undefined") return;
      const migrationKey = "reconcile-uploaded-files-migrated-v1";
      if (window.localStorage.getItem(migrationKey) === "1") return;
      try {
        const raw = window.localStorage.getItem(RECONCILE_STORAGE_KEY);
        if (!raw) {
          window.localStorage.setItem(migrationKey, "1");
          return;
        }
        const parsed = JSON.parse(raw) as { uploadedFilesByAccount?: Record<string, unknown> };
        const legacy = parsed.uploadedFilesByAccount;
        if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
          window.localStorage.setItem(migrationKey, "1");
          return;
        }

        const writes: Promise<Response>[] = [];
        for (const [accountName, files] of Object.entries(legacy)) {
          if (!Array.isArray(files)) continue;
          for (const file of files) {
            const fileName = String(file).trim();
            if (!fileName) continue;
            writes.push(
              fetch("/api/reconciliation/uploaded-files", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountName, fileName }),
              }),
            );
          }
        }
        if (writes.length > 0) {
          await Promise.all(writes);
          await loadUploadedFilesFromNeon();
        }
        window.localStorage.setItem(migrationKey, "1");
      } catch {
        // Retry migration next load if parsing/network fails.
      }
    }

    void loadUploadedFilesFromNeon();
    void migrateLegacyLocalUploadedFiles();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUserInputtedState() {
      try {
        const [rows, transfers, claimsRes, transferClaimsRes] = await Promise.all([
          getExpenses(),
          getTransfers(),
          fetch("/api/reconciliation/claims", { cache: "no-store" }),
          fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
        ]);
        if (!claimsRes.ok || !transferClaimsRes.ok) return;

        const claimsData = (await claimsRes.json()) as {
          claimedRowIds?: string[];
          claims?: Array<{ bankHash?: string }>;
        };
        const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));
        const transferClaimsData = (await transferClaimsRes.json()) as {
          statusByRowId?: TransferClaimStatusByRowId;
          claims?: Array<{ bankHash?: string }>;
        };
        const bankHashSet = new Set<string>();
        for (const c of claimsData.claims ?? []) {
          if (c.bankHash) bankHashSet.add(String(c.bankHash));
        }
        for (const c of transferClaimsData.claims ?? []) {
          if (c.bankHash) bankHashSet.add(String(c.bankHash));
        }
        if (cancelled) return;
        setSheetExpenses(rows);
        setSheetTransfers(transfers);
        setClaimedRowKeys(claimedRows);
        setBankHashesWithNeonClaim(bankHashSet);
        setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
      } catch {
        // Home view still works with partial/no user-inputted reconciliation data.
      }
    }

    void loadUserInputtedState();
    return () => {
      cancelled = true;
    };
  }, []);

  const allMatches = useMemo(() => Object.values(matchesByAccount).flat(), [matchesByAccount]);

  const tabAccounts = useMemo(() => {
    const uploaded = Object.keys(matchesByAccount).filter((a) => a !== LEGACY_WF_PROFILE_BUCKET);
    const merged = [...ACCOUNT_OPTIONS];
    for (const account of uploaded) {
      if (!merged.includes(account as AccountOption)) merged.push(account as AccountOption);
    }
    return merged;
  }, [matchesByAccount]);

  useEffect(() => {
    if (activeTab === LEGACY_WF_PROFILE_BUCKET) {
      setActiveTab("WF Checking");
    }
  }, [activeTab]);

  const statementRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = sortByNewestDate(
        (matchesByAccount[account] ?? []).filter(
          (row) => row.bankTransaction.accountName === account,
        ),
        (row) => row.bankTransaction.date,
      );
    });
    return byAccount;
  }, [matchesByAccount, tabAccounts]);

  const statementReviewRowsByAccount = useMemo(() => {
    // A re-imported statement that overlaps a prior upload produces a second copy
    // of a transaction whenever a non-identifying column differs (e.g. the running
    // balance). The copies share a date/amount/description, so they collapse to the
    // same base hash but get distinct "-2"/"-3" disambiguation suffixes. The original
    // copy is claimed/processed (and shows in the matched section); the suffixed copy
    // is unclaimed and would otherwise reappear here as unmatched — the same bank
    // transaction showing up in both sections. Strip the suffix to compare identity.
    const baseHash = (hash: string) => hash.replace(/-\d+$/, "");
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      const rows = statementRowsByAccount[account];

      // Count how many times each transaction identity is already represented as a
      // matched or closed row for this account.
      const resolvedBaseCount = new Map<string, number>();
      for (const match of rows) {
        const id = idForTx(match.bankTransaction);
        const hash = match.bankTransaction.hash;
        if (disconnectedIds.has(id)) continue;
        if (
          isProcessedWithoutNeonClaim(
            match,
            processedHashes,
            dismissalNotesById,
            bankHashesWithNeonClaim,
          )
        ) {
          continue;
        }
        const isResolved =
          processedHashes.has(hash) ||
          (match.matchType === "exact_match" && hasLinkedUserInputtedEntry(match)) ||
          hasLinkedOrClaimedEntry(match, bankHashesWithNeonClaim);
        if (!isResolved) continue;
        const b = baseHash(hash);
        resolvedBaseCount.set(b, (resolvedBaseCount.get(b) ?? 0) + 1);
      }

      // Suppress pending rows that duplicate a resolved row, but only up to the
      // number of resolved copies — so genuine duplicate purchases that both still
      // need matching are preserved.
      const consumed = new Map<string, number>();
      byAccount[account] = rows.filter((match) => {
        const id = idForTx(match.bankTransaction);
        const hash = match.bankTransaction.hash;
        if (disconnectedIds.has(id)) return true;
        if (
          isProcessedWithoutNeonClaim(
            match,
            processedHashes,
            dismissalNotesById,
            bankHashesWithNeonClaim,
          )
        ) {
          return true;
        }
        if (processedHashes.has(hash)) return false;
        if (!isStatementManualReview(match)) return false;

        const b = baseHash(hash);
        const available = resolvedBaseCount.get(b) ?? 0;
        const used = consumed.get(b) ?? 0;
        if (used < available) {
          consumed.set(b, used + 1);
          return false;
        }
        return true;
      });
    });
    return byAccount;
  }, [
    bankHashesWithNeonClaim,
    disconnectedIds,
    dismissalNotesById,
    processedHashes,
    statementRowsByAccount,
    tabAccounts,
  ]);

  const statementCompletedRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = statementRowsByAccount[account].filter((match) => {
        const id = idForTx(match.bankTransaction);
        if (disconnectedIds.has(id)) return false;
        if (
          isProcessedWithoutNeonClaim(
            match,
            processedHashes,
            dismissalNotesById,
            bankHashesWithNeonClaim,
          )
        ) {
          return false;
        }
        if (!processedHashes.has(match.bankTransaction.hash)) return false;
        const dismissed = Boolean(dismissalNotesById[id]);
        const linkedOrClaimed = hasLinkedOrClaimedEntry(match, bankHashesWithNeonClaim);
        const completedWithoutExactSheet =
          match.matchType !== "exact_match" || !linkedOrClaimed;
        return completedWithoutExactSheet || dismissed;
      });
    });
    return byAccount;
  }, [
    bankHashesWithNeonClaim,
    dismissalNotesById,
    processedHashes,
    disconnectedIds,
    statementRowsByAccount,
    tabAccounts,
  ]);

  const statementAutoMatchedRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = statementRowsByAccount[account].filter((match) => {
        const id = idForTx(match.bankTransaction);
        if (disconnectedIds.has(id)) return false;
        if (dismissalNotesById[id]) return false;
        return match.matchType === "exact_match" && hasLinkedUserInputtedEntry(match);
      });
    });
    return byAccount;
  }, [dismissalNotesById, disconnectedIds, statementRowsByAccount, tabAccounts]);

  const autoCompletedExpenseSignatures = useMemo(() => {
    const signatures = new Set<string>();
    for (const match of allMatches) {
      const isCompleted =
        match.matchType === "exact_match" || processedHashes.has(match.bankTransaction.hash);
      if (!isCompleted || !match.matchedSheetExpense) continue;
      signatures.add(buildSheetExpenseSignatureFromRow(match.matchedSheetExpense));
    }
    return signatures;
  }, [allMatches, processedHashes]);

  const expenseRowIdsLinkedByExactMatch = useMemo(() => {
    const ids = new Set<string>();
    for (const match of allMatches) {
      if (match.matchType !== "exact_match" || !match.matchedSheetExpense) continue;
      const id = String(match.matchedSheetExpense.rowId ?? "").trim();
      if (id) ids.add(id);
    }
    return ids;
  }, [allMatches]);

  const autoCompletedTransferSignatures = useMemo(() => {
    const signatures = new Set<string>();
    for (const match of allMatches) {
      if (!match.matchedSheetTransfer) continue;
      const rowId = String(match.matchedSheetTransfer.transferRowId ?? "").trim();
      if (rowId) {
        const status = transferClaimStatusByRowId[rowId];
        if (!status?.isComplete) continue;
      } else {
        const isCompleted =
          match.matchType === "exact_match" || processedHashes.has(match.bankTransaction.hash);
        if (!isCompleted) continue;
      }
      signatures.add(
        buildTransferSignature(
          Number(match.matchedSheetTransfer.amount ?? 0),
          match.matchedSheetTransfer.timestamp ?? match.matchedSheetTransfer.date,
          match.matchedSheetTransfer.transferFrom,
          match.matchedSheetTransfer.transferTo,
        ),
      );
    }
    return signatures;
  }, [allMatches, processedHashes, transferClaimStatusByRowId]);

  const userInputtedEntries = useMemo(() => {
    const expenseEntries: UserInputtedEntry[] = sheetExpenses.map((row, index) => {
      const rowId = (row.rowId ?? "").trim();
      const key = rowId ? claimKey("Expenses", rowId) : `Expenses:missing:${index}`;
      const claimed = rowId ? claimedRowKeys.has(claimKey("Expenses", rowId)) : false;
      const dateValue = sheetExpenseDateRaw(row);
      const tiedByExactMatch = Boolean(rowId && expenseRowIdsLinkedByExactMatch.has(rowId));
      const autoCompleted = autoCompletedExpenseSignatures.has(buildSheetExpenseSignatureFromRow(row));
      const userDismissed = userDismissedRowKeys.has(key);
      return {
        id: key,
        source: "Expenses",
        dateValue,
        title: row.description || row.expenseType || "Expense row",
        subtitle: `${row.account ?? "No account"} • ${fmtDate(dateValue)}`,
        amount: Number(row.amount ?? 0),
        isCompleted: claimed || tiedByExactMatch || autoCompleted || userDismissed,
        expenseAccount: row.account?.trim() || undefined,
      };
    });

    const transferEntries: UserInputtedEntry[] = sheetTransfers.map((row, index) => {
      const rowId = (row.transferRowId ?? "").trim();
      const status = rowId ? transferClaimStatusByRowId[rowId] : undefined;
      const claimed = rowId ? claimedRowKeys.has(claimKey("Transfers", rowId)) : false;
      const dateValue = sheetTransferDateRaw(row);
      const title = `${row.transferFrom || "—"} → ${row.transferTo || "—"}`;
      const autoCompleted = autoCompletedTransferSignatures.has(
        buildTransferSignature(
          Number(row.amount ?? 0),
          dateValue || undefined,
          row.transferFrom,
          row.transferTo,
        ),
      );
      const tid = rowId ? `Transfers:${rowId}` : `Transfers:missing:${index}`;
      const userDismissed = userDismissedRowKeys.has(tid);
      return {
        id: tid,
        source: "Transfers",
        dateValue,
        title,
        subtitle: `Transfer • ${fmtDate(dateValue)}`,
        amount: Number(row.amount ?? 0),
        isCompleted: claimed || Boolean(status?.isComplete) || autoCompleted || userDismissed,
        transferFrom: row.transferFrom,
        transferTo: row.transferTo,
      };
    });

    return sortByNewestDate([...expenseEntries, ...transferEntries], (entry) => entry.dateValue);
  }, [
    autoCompletedExpenseSignatures,
    autoCompletedTransferSignatures,
    claimedRowKeys,
    expenseRowIdsLinkedByExactMatch,
    sheetExpenses,
    sheetTransfers,
    transferClaimStatusByRowId,
    userDismissedRowKeys,
  ]);

  /** Unprocessed bank lines across accounts — includes exact_match etc., not only manual-review rows.
   *  Also includes "processed without claim" rows (hash in processedHashes but no claim link) because
   *  those show in the review queue and should be selectable for re-linking. */
  const allUnprocessedStatementMatchesForClaim = useMemo(() => {
    const list: MatchResult[] = [];
    for (const account of tabAccounts) {
      for (const m of statementRowsByAccount[account] ?? []) {
        if (processedHashes.has(m.bankTransaction.hash)) {
          if (!isProcessedWithoutNeonClaim(m, processedHashes, dismissalNotesById, bankHashesWithNeonClaim)) continue;
        }
        list.push(m);
      }
    }
    return sortByNewestDate(list, (match) => match.bankTransaction.date);
  }, [bankHashesWithNeonClaim, dismissalNotesById, processedHashes, statementRowsByAccount, tabAccounts]);

  const userInputtedReviewRows = useMemo(
    () => userInputtedEntries.filter((e) => !e.isCompleted),
    [userInputtedEntries],
  );

  const homeRowsWithSuggestedBank = useMemo(
    () =>
      userInputtedReviewRows.map((entry) => ({
        entry,
        suggestedBank: findBestStatementMatchForUserEntry(entry, allUnprocessedStatementMatchesForClaim),
      })),
    [allUnprocessedStatementMatchesForClaim, userInputtedReviewRows],
  );

  const homeFilteredIncompleteRows = useMemo(() => {
    let rows = homeRowsWithSuggestedBank;
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter(({ entry, suggestedBank }) => {
        const tx = suggestedBank?.bankTransaction;
        const hay = [
          entry.title,
          entry.subtitle,
          entry.source,
          entry.expenseAccount,
          entry.transferFrom,
          entry.transferTo,
          tx?.description,
          tx?.accountName,
          tx?.date,
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter(({ entry, suggestedBank }) => {
        if (suggestedBank?.bankTransaction.accountName === homeAccountFilter) return true;
        if (entry.source === "Expenses" && entry.expenseAccount === homeAccountFilter) return true;
        if (entry.source === "Transfers") {
          return (
            entry.transferFrom === homeAccountFilter || entry.transferTo === homeAccountFilter
          );
        }
        return false;
      });
    }
    return rows;
  }, [homeAccountFilter, homeRowsWithSuggestedBank, homeSearchQuery]);

  const allHomeMatchedMatches = useMemo(() => {
    const list: MatchResult[] = [];
    for (const account of tabAccounts) {
      list.push(...(statementAutoMatchedRowsByAccount[account] ?? []));
      list.push(...(statementCompletedRowsByAccount[account] ?? []));
    }
    return sortByNewestDate(list, (m) => m.bankTransaction.date);
  }, [statementAutoMatchedRowsByAccount, statementCompletedRowsByAccount, tabAccounts]);

  /** Real sheet ↔ bank pairs only (excludes “approve checkmark” / dismiss with no expense or transfer row). */
  const allHomeUserLinkedMatchedMatches = useMemo(
    () => allHomeMatchedMatches.filter((m) => hasLinkedOrClaimedEntry(m, bankHashesWithNeonClaim)),
    [allHomeMatchedMatches, bankHashesWithNeonClaim],
  );

  const allHomeStatementClosedOnlyMatches = useMemo(
    () => allHomeMatchedMatches.filter((m) => !hasLinkedOrClaimedEntry(m, bankHashesWithNeonClaim)),
    [allHomeMatchedMatches, bankHashesWithNeonClaim],
  );

  const homeFilteredMatchedRows = useMemo(() => {
    let rows = allHomeUserLinkedMatchedMatches;
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter((match) => {
        const tx = match.bankTransaction;
        const exp = match.matchedSheetExpense;
        const tr = match.matchedSheetTransfer;
        const hay = [
          tx.description,
          tx.accountName,
          tx.date,
          exp?.description,
          exp?.expenseType,
          exp?.account,
          tr?.transferFrom,
          tr?.transferTo,
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter((match) => {
        if (match.bankTransaction.accountName === homeAccountFilter) return true;
        if (match.matchedSheetExpense?.account === homeAccountFilter) return true;
        if (match.matchedSheetTransfer) {
          return (
            match.matchedSheetTransfer.transferFrom === homeAccountFilter ||
            match.matchedSheetTransfer.transferTo === homeAccountFilter
          );
        }
        return false;
      });
    }
    return rows;
  }, [allHomeUserLinkedMatchedMatches, homeAccountFilter, homeSearchQuery]);

  const homeFilteredStatementClosedRows = useMemo(() => {
    let rows = allHomeStatementClosedOnlyMatches;
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter((match) => {
        const tx = match.bankTransaction;
        const tid = idForTx(tx);
        const note = dismissalNotesById[tid];
        const hay = [
          tx.description,
          tx.accountName,
          tx.date,
          note,
          match.matchType,
          match.reason,
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter((match) => match.bankTransaction.accountName === homeAccountFilter);
    }
    return rows;
  }, [
    allHomeStatementClosedOnlyMatches,
    dismissalNotesById,
    homeAccountFilter,
    homeSearchQuery,
  ]);

  const homeFilteredUserDismissedRows = useMemo(() => {
    let rows = userInputtedEntries.filter((e) => userDismissedRowKeys.has(e.id));
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter((entry) => {
        const hay = [
          entry.title,
          entry.subtitle,
          entry.source,
          entry.expenseAccount,
          entry.transferFrom,
          entry.transferTo,
          userDismissalNotesByEntryId[entry.id],
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter((entry) => {
        if (entry.source === "Expenses" && entry.expenseAccount === homeAccountFilter) return true;
        if (entry.source === "Transfers") {
          return (
            entry.transferFrom === homeAccountFilter || entry.transferTo === homeAccountFilter
          );
        }
        return false;
      });
    }
    return sortByNewestDate(rows, (entry) => entry.dateValue);
  }, [
    homeAccountFilter,
    homeSearchQuery,
    userDismissalNotesByEntryId,
    userDismissedRowKeys,
    userInputtedEntries,
  ]);

  const userClaimFilteredStatementLines = useMemo(() => {
    if (!userStatementClaimModal.open || !userStatementClaimModal.entry) return [];
    const entry = userStatementClaimModal.entry;
    const userCents = toCents(Math.abs(entry.amount));
    let list = allUnprocessedStatementMatchesForClaim.filter(
      (m) => toCents(Math.abs(m.bankTransaction.amount)) === userCents,
    );
    if (userStatementClaimModal.accountFilter !== ALL_ACCOUNTS_OPTION) {
      list = list.filter(
        (m) => m.bankTransaction.accountName === userStatementClaimModal.accountFilter,
      );
    }
    const q = normalizeText(userStatementClaimModal.searchQuery);
    if (q) {
      list = list.filter((m) => {
        const tx = m.bankTransaction;
        return [tx.description, tx.accountName, tx.date, String(tx.amount)]
          .map((v) => normalizeText(v))
          .join(" ")
          .includes(q);
      });
    }
    return list;
  }, [allUnprocessedStatementMatchesForClaim, userStatementClaimModal]);

  const openQuickAdd = useCallback((match: MatchResult) => {
    const tx = match.bankTransaction;
    setQuickAdd({
      open: true,
      rowId: idForTx(tx),
      expenseType: tx.amount < 0 ? "Misc." : "Income",
      amount: String(Math.abs(tx.amount).toFixed(2)),
      description: tx.description,
      submitting: false,
      error: "",
    });
  }, []);

  const closeQuickAdd = useCallback(() => {
    setQuickAdd((prev) => ({ ...prev, open: false, rowId: null, error: "", submitting: false }));
  }, []);

  const openSplitModal = useCallback(async (match: MatchResult) => {
    const tx = match.bankTransaction;
    setActionError("");
    try {
      const [freshSheetRows, freshTransfers, claimsRes] = await Promise.all([
        getExpenses(),
        getTransfers(),
        fetch("/api/reconciliation/claims", { cache: "no-store" }),
      ]);
      if (!claimsRes.ok) {
        const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
        throw new Error(err.error || "Failed to load claimed sheet rows.");
      }
      const claimsData = (await claimsRes.json()) as {
        claimedRowIds?: string[];
        claims?: Array<{ bankHash?: string }>;
      };
      const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));

      setSheetExpenses(freshSheetRows);
      setSheetTransfers(freshTransfers);
      setClaimedRowKeys(claimedRows);
      void refreshBankHashesWithNeonClaim();

      const expenseCandidates: SplitDraftLine[] = freshSheetRows
        .filter((row) => {
          const rowId = (row.rowId ?? "").trim();
          if (!rowId) return false;
          return !claimedRows.has(claimKey("Expenses", rowId));
        })
        .map((row) => {
          const rowId = (row.rowId ?? "").trim();
          return {
            key: claimKey("Expenses", rowId),
            sheetName: "Expenses" as const,
            rowId,
            amount: Math.abs(Number(row.amount)),
            expenseType: row.expenseType,
            description: row.description,
            timestamp: row.timestamp,
            date: row.date,
            account: row.account,
          };
        });

      const transferCandidates: SplitDraftLine[] = freshTransfers
        .filter((row) => {
          const rowId = (row.transferRowId ?? "").trim();
          if (!rowId) return false;
          return !claimedRows.has(claimKey("Transfers", rowId));
        })
        .map((row) => {
          const rowId = (row.transferRowId ?? "").trim();
          const from = row.transferFrom?.trim() || "—";
          const to = row.transferTo?.trim() || row.description?.trim() || "—";
          return {
            key: claimKey("Transfers", rowId),
            sheetName: "Transfers" as const,
            rowId,
            amount: Math.abs(Number(row.amount)),
            expenseType: "Transfer",
            description: `${from} → ${to}`,
            timestamp: row.timestamp,
            date: row.date,
            account: undefined,
            transferFrom: row.transferFrom,
            transferTo: row.transferTo,
          };
        });

      const availableCandidates = sortByNewestDate(
        [...expenseCandidates, ...transferCandidates],
        (r) => r.timestamp,
      );

      setSplitModal({
        open: true,
        rowId: idForTx(tx),
        selectedKeys: [],
        candidates: availableCandidates,
        transferExpectedLegs: 2,
        submitting: false,
        error: "",
      });
      setSplitSearchQuery("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to open claim modal.");
    }
  }, [refreshBankHashesWithNeonClaim]);

  const closeSplitModal = useCallback(() => {
    setSplitModal({
      open: false,
      rowId: null,
      selectedKeys: [],
      candidates: [],
      transferExpectedLegs: 2,
      submitting: false,
      error: "",
    });
    setSplitSearchQuery("");
  }, []);

  const openUserStatementClaimModal = useCallback((entry: UserInputtedEntry) => {
    setUserStatementClaimModal({
      open: true,
      entry,
      selectedBankRowId: null,
      searchQuery: "",
      accountFilter: ALL_ACCOUNTS_OPTION,
      transferExpectedLegs: 2,
      submitting: false,
      error: "",
    });
  }, []);

  const closeUserStatementClaimModal = useCallback(() => {
    setUserStatementClaimModal({
      open: false,
      entry: null,
      selectedBankRowId: null,
      searchQuery: "",
      accountFilter: ALL_ACCOUNTS_OPTION,
      transferExpectedLegs: 2,
      submitting: false,
      error: "",
    });
  }, []);

  const openTransferClaimModal = useCallback((match: MatchResult) => {
    const tx = match.bankTransaction;
    const rowId = String(match.matchedSheetTransfer?.transferRowId ?? "").trim();
    const status = rowId ? transferClaimStatusByRowId[rowId] : undefined;
    const expectedLegs = status?.expectedLegs === 1 ? 1 : 2;
    setTransferClaimModal({
      open: true,
      rowId: idForTx(tx),
      expectedLegs,
      submitting: false,
      error: "",
      pendingClaimSource: null,
    });
  }, [transferClaimStatusByRowId]);

  const closeTransferClaimModal = useCallback(() => {
    setTransferClaimModal({
      open: false,
      rowId: null,
      expectedLegs: 2,
      submitting: false,
      error: "",
      pendingClaimSource: null,
    });
  }, []);

  const openAnchorModal = useCallback(async () => {
    setAnchorModal({
      open: true,
      date: new Date().toISOString().slice(0, 10),
      balance: "",
      loading: true,
      saving: false,
      error: "",
    });
    try {
      const [rows, transfers, anchors] = await Promise.all([
        getExpenses(),
        getTransfers(),
        getAccountAnchors(),
      ]);
      const balances = computeAccountBalances(accountSeeds, rows, transfers, anchors);
      const balance = balances[selectedAccount];
      if (!Number.isFinite(balance)) {
        throw new Error(`Could not determine current balance for ${selectedAccount}.`);
      }
      setAnchorModal((prev) => ({
        ...prev,
        loading: false,
        balance: Number(balance).toFixed(2),
      }));
    } catch (err) {
      setAnchorModal((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load current balance.",
      }));
    }
  }, [selectedAccount, accountSeeds]);

  const closeAnchorModal = useCallback(() => {
    setAnchorModal((prev) => ({
      ...prev,
      open: false,
      loading: false,
      saving: false,
      error: "",
    }));
  }, []);

  const handleSaveAnchor = useCallback(async () => {
    const confirmedBalance = Number(anchorModal.balance);
    if (!Number.isFinite(confirmedBalance)) {
      setAnchorModal((prev) => ({ ...prev, error: "Enter a valid balance." }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorModal.date)) {
      setAnchorModal((prev) => ({ ...prev, error: "Select a valid statement date." }));
      return;
    }

    setAnchorModal((prev) => ({ ...prev, saving: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/anchors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName: selectedAccount,
          confirmedBalance,
          asOfDate: anchorModal.date,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save statement balance (${res.status})`);
      }
      closeAnchorModal();
    } catch (err) {
      setAnchorModal((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : "Failed to save statement ending balance.",
      }));
    }
  }, [anchorModal.balance, anchorModal.date, closeAnchorModal, selectedAccount]);

  const recordMerchantMemory = useCallback(async (tx: BankTransaction, sheetCategory?: string | null) => {
    try {
      const fingerprint = generateMerchantFingerprint(tx.description, tx.amount);
      await fetch("/api/reconciliation/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint,
          bankAccountName: tx.accountName,
          sheetCategory: sheetCategory ?? null,
        }),
      });
    } catch {
      // Memory recording is non-fatal — don't block the user's claim flow.
    }
  }, []);

  const persistProcessedHash = useCallback(
    async (
      tx: BankTransaction,
      meta?: { csvUploadId?: string | null; actor?: "user" | "auto_match" | "memory_match" },
    ) => {
      const res = await fetch("/api/reconciliation/processed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hash: tx.hash,
          accountName: tx.accountName,
          csvUploadId: meta?.csvUploadId ?? null,
          actor: meta?.actor ?? "user",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save hash (${res.status})`);
      }
      // Fire-and-forget memory increment. Runs after success only.
      void recordMerchantMemory(tx);
    },
    [recordMerchantMemory],
  );

  // Auto-approve an exact_match by persisting its claim link (not just the
  // processed hash). Without the claim link the transaction becomes "processed
  // but unclaimed" — on the next reload/re-match the matcher short-circuits it to
  // "processed" and stops suggesting the sheet row, so it resurfaces as
  // "No candidate match". Mirrors the claim creation in handleApprove.
  // Returns the claim key (`"Expenses:rowId"`) when a link was created, else null.
  const persistAutoClaim = useCallback(
    async (
      match: MatchResult,
      meta?: { csvUploadId?: string | null },
    ): Promise<string | null> => {
      const tx = match.bankTransaction;
      const expenseRowId = String(match.matchedSheetExpense?.rowId ?? "").trim();

      // Only expense matches carry a Row ID here. Transfer/restored matches keep
      // the prior behaviour (mark processed only — they already have claim links).
      if (!expenseRowId) {
        await persistProcessedHash(tx, { csvUploadId: meta?.csvUploadId, actor: "auto_match" });
        return null;
      }

      const res = await fetch("/api/reconciliation/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransaction: {
            hash: tx.hash,
            accountName: tx.accountName,
            amount: tx.amount,
            date: tx.date,
            description: tx.description,
          },
          links: [
            {
              sheetName: "Expenses",
              sheetRowId: expenseRowId,
              amount: Math.abs(tx.amount),
            },
          ],
          actor: "auto_match",
          csvUploadId: meta?.csvUploadId ?? null,
        }),
      });
      if (!res.ok) {
        // 409 = sheet row already claimed by another bank hash. Callers already
        // skip hashes with existing claims, so this is a genuine conflict worth
        // surfacing rather than silently marking the row resolved.
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to auto-claim sheet link (${res.status})`);
      }
      // The /claims route inserts the processed hash in the same transaction, but
      // mirror handleApprove (also records merchant memory) for parity.
      await persistProcessedHash(tx, { csvUploadId: meta?.csvUploadId, actor: "auto_match" });
      return claimKey("Expenses", expenseRowId);
    },
    [persistProcessedHash],
  );

  const handleUserStatementClaimSubmit = useCallback(async (overrideLegs?: 1 | 2) => {
    const { entry, selectedBankRowId } = userStatementClaimModal;
    const transferExpectedLegs = overrideLegs ?? userStatementClaimModal.transferExpectedLegs;
    if (!entry || !selectedBankRowId) {
      setUserStatementClaimModal((prev) => ({ ...prev, error: "Select a statement line." }));
      return;
    }
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === selectedBankRowId);
    if (!selected) {
      setUserStatementClaimModal((prev) => ({
        ...prev,
        error: "Statement line no longer available.",
      }));
      return;
    }

    let sheetName: "Expenses" | "Transfers";
    let rowId: string;
    if (entry.source === "Expenses") {
      const id = parseExpenseRowIdFromEntryId(entry.id);
      if (!id) {
        setUserStatementClaimModal((prev) => ({
          ...prev,
          error: "Expense row is missing a Row ID.",
        }));
        return;
      }
      sheetName = "Expenses";
      rowId = id;
    } else {
      const id = parseTransferRowIdFromEntryId(entry.id);
      if (!id) {
        setUserStatementClaimModal((prev) => ({
          ...prev,
          error: "Transfer row is missing a Transfer Row ID.",
        }));
        return;
      }
      sheetName = "Transfers";
      rowId = id;
    }

    const targetCents = toCents(Math.abs(selected.bankTransaction.amount));
    const linkCents = toCents(Math.abs(entry.amount));
    if (targetCents !== linkCents) {
      setUserStatementClaimModal((prev) => ({
        ...prev,
        error: "Selected statement amount must match the user-inputted amount.",
      }));
      return;
    }

    setUserStatementClaimModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransaction: {
            hash: selected.bankTransaction.hash,
            accountName: selected.bankTransaction.accountName,
            amount: selected.bankTransaction.amount,
            date: selected.bankTransaction.date,
            description: selected.bankTransaction.description,
          },
          links: [
            {
              sheetName,
              sheetRowId: rowId,
              amount: Math.abs(entry.amount),
            },
          ],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to claim (${res.status})`);
      }

      if (sheetName === "Transfers") {
        const tRes = await fetch("/api/reconciliation/transfer-claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transferRowId: rowId,
            expectedLegs: transferExpectedLegs,
            bankTransaction: {
              hash: selected.bankTransaction.hash,
              accountName: selected.bankTransaction.accountName,
              amount: selected.bankTransaction.amount,
            },
          }),
        });
        if (!tRes.ok) {
          const err = await tRes.json().catch(() => ({ error: tRes.statusText }));
          throw new Error(
            err.error ||
              `Saved sheet link but transfer leg tracking failed (${tRes.status}). Try again.`,
          );
        }
        const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
        if (tClaimsGet.ok) {
          const transferClaimsData = (await tClaimsGet.json()) as {
            statusByRowId?: TransferClaimStatusByRowId;
          };
          setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
        }
      }

      await persistProcessedHash(selected.bankTransaction);
      setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      setClaimedRowKeys((prev) => {
        const next = new Set(prev);
        next.add(claimKey(sheetName, rowId));
        return next;
      });

      const bankRowId = idForTx(selected.bankTransaction);
      setMatchesByAccount((prev) => {
        const next: Record<string, MatchResult[]> = {};
        for (const [account, rows] of Object.entries(prev)) {
          next[account] = rows.map((row) => {
            if (idForTx(row.bankTransaction) !== bankRowId) return row;
            if (sheetName === "Transfers") {
              const tr = sheetTransfers.find((t) => (t.transferRowId ?? "").trim() === rowId);
              if (!tr) return row;
              const amountSignedForTransfer =
                selected.bankTransaction.amount < 0
                  ? -Math.abs(Number(tr.amount ?? 0))
                  : Math.abs(Number(tr.amount ?? 0));
              return {
                ...row,
                matchType: "exact_match",
                reason: "Claimed transfer sheet row and marked processed.",
                matchedSheetTransfer: {
                  amount: amountSignedForTransfer,
                  transferRowId: rowId,
                  transferFrom: tr.transferFrom,
                  transferTo: tr.transferTo,
                  timestamp: tr.timestamp,
                  date: tr.date,
                },
                matchedSheetTransferIndex: undefined,
                matchedSheetExpense: undefined,
                matchedSheetIndex: undefined,
              };
            }
            const exp = sheetExpenses.find((e) => (e.rowId ?? "").trim() === rowId);
            if (!exp) return row;
            return {
              ...row,
              matchType: "exact_match",
              reason: "Claimed existing sheet row and marked processed.",
              matchedSheetExpense: {
                amount: Math.abs(Number(exp.amount)),
                timestamp: exp.timestamp ?? selected.bankTransaction.date,
                description: exp.description ?? "",
                expenseType: exp.expenseType ?? "—",
                account: exp.account ?? selected.bankTransaction.accountName,
                rowId: exp.rowId,
                date: exp.date,
              },
              matchedSheetIndex: undefined,
              matchedSheetTransfer: undefined,
              matchedSheetTransferIndex: undefined,
            };
          });
        }
        return next;
      });
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(bankRowId);
        return next;
      });
      void refreshBankHashesWithNeonClaim();
      closeUserStatementClaimModal();
    } catch (err) {
      setUserStatementClaimModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim statement line.",
      }));
    }
  }, [
    allMatches,
    closeUserStatementClaimModal,
    persistProcessedHash,
    refreshBankHashesWithNeonClaim,
    sheetExpenses,
    sheetTransfers,
    userStatementClaimModal,
  ]);

  const handleUserStatementClaimSaveClick = useCallback(() => {
    if (userStatementClaimModal.entry?.source === "Transfers") {
      const existingLegs = userStatementClaimModal.transferExpectedLegs;
      setTransferClaimModal({
        open: true,
        rowId: null,
        expectedLegs: existingLegs,
        submitting: false,
        error: "",
        pendingClaimSource: "manual",
      });
    } else {
      void handleUserStatementClaimSubmit();
    }
  }, [handleUserStatementClaimSubmit, userStatementClaimModal]);

  const rematchAllStoredAccounts = useCallback(async () => {
    const accounts = Object.keys(statementCsvRowsByAccountRef.current);
    if (accounts.length === 0) return;

    const [
      sheetRows,
      sheetTransfers,
      processedHashesRes,
      dismissalsRes,
      userDismissalsRes,
      claimsRes,
      transferClaimsRes,
    ] = await Promise.all([
      getExpenses(),
      getTransfers(),
      fetch("/api/reconciliation/processed", { cache: "no-store" }),
      fetch("/api/reconciliation/dismissals", { cache: "no-store" }),
      fetch("/api/reconciliation/user-dismissals", { cache: "no-store" }),
      fetch("/api/reconciliation/claims", { cache: "no-store" }),
      fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
    ]);

    if (!processedHashesRes.ok) {
      const err = await processedHashesRes.json().catch(() => ({ error: processedHashesRes.statusText }));
      throw new Error(err.error || "Failed to load processed hashes.");
    }
    if (!dismissalsRes.ok) {
      const err = await dismissalsRes.json().catch(() => ({ error: dismissalsRes.statusText }));
      throw new Error(err.error || "Failed to load dismissals.");
    }
    if (!userDismissalsRes.ok) {
      const err = await userDismissalsRes.json().catch(() => ({ error: userDismissalsRes.statusText }));
      throw new Error(err.error || "Failed to load user dismissals.");
    }
    if (!claimsRes.ok) {
      const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
      throw new Error(err.error || "Failed to load claimed sheet rows.");
    }
    if (!transferClaimsRes.ok) {
      const err = await transferClaimsRes.json().catch(() => ({ error: transferClaimsRes.statusText }));
      throw new Error(err.error || "Failed to load transfer claims.");
    }

    const processedHashesData = (await processedHashesRes.json()) as { hashes?: string[] };
    let processedList = [...(processedHashesData.hashes ?? [])];
    const dismissalsData = (await dismissalsRes.json()) as {
      dismissals?: Array<{ hash: string; accountName: string; note: string }>;
    };
    const dismissalMap: Record<string, string> = {};
    for (const d of dismissalsData.dismissals ?? []) {
      dismissalMap[`${d.accountName}|${d.hash}`] = d.note;
    }
    setDismissalNotesById(dismissalMap);
    const userDismissalsData = (await userDismissalsRes.json()) as {
      dismissedKeys?: string[];
      dismissals?: Array<{ sheetName: string; sheetRowId: string; note: string }>;
    };
    setUserDismissedRowKeys(
      new Set<string>((userDismissalsData.dismissedKeys ?? []).map((k) => String(k))),
    );
    const userNoteMap: Record<string, string> = {};
    for (const d of userDismissalsData.dismissals ?? []) {
      userNoteMap[claimKey(d.sheetName, d.sheetRowId)] = d.note;
    }
    setUserDismissalNotesByEntryId(userNoteMap);
    const claimsData = (await claimsRes.json()) as {
      claimedRowIds?: string[];
      claims?: Array<{ bankHash?: string }>;
    };
    const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));
    const transferClaimsData = (await transferClaimsRes.json()) as {
      statusByRowId?: TransferClaimStatusByRowId;
      claims?: Array<{ bankHash?: string }>;
    };
    const bankHashSetRematch = new Set<string>();
    for (const c of claimsData.claims ?? []) {
      if (c.bankHash) bankHashSetRematch.add(String(c.bankHash));
    }
    for (const c of transferClaimsData.claims ?? []) {
      if (c.bankHash) bankHashSetRematch.add(String(c.bankHash));
    }
    setSheetExpenses(sheetRows);
    setSheetTransfers(sheetTransfers);
    setClaimedRowKeys(claimedRows);
    setBankHashesWithNeonClaim(bankHashSetRematch);
    setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});

    const nextMatches: Record<string, MatchResult[]> = {};
    const autoApprovalErrors: string[] = [];
    const autoClaimedHashes: string[] = [];
    const autoClaimedRowKeys: string[] = [];

    for (const accountName of accounts) {
      const rows = statementCsvRowsByAccountRef.current[accountName];
      if (!rows?.length) continue;

      const res = await fetch("/api/reconciliation/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName,
          rows,
          sheetExpenses: sheetRows,
          sheetTransfers,
          processedHashes: processedList,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to match ${accountName} (${res.status})`);
      }
      const data = (await res.json()) as MatchResponse;
      nextMatches[accountName] = data.matches;

      const autoApprovable = data.matches.filter(
        (match) =>
          match.matchType === "exact_match" &&
          hasLinkedUserInputtedEntry(match) &&
          // Skip rows restored from existing claim links — already claimed.
          !bankHashSetRematch.has(match.bankTransaction.hash),
      );
      const newAutoHashes: string[] = [];
      await Promise.all(
        autoApprovable.map(async (match) => {
          try {
            const claimedKey = await persistAutoClaim(match);
            newAutoHashes.push(match.bankTransaction.hash);
            if (claimedKey) {
              autoClaimedHashes.push(match.bankTransaction.hash);
              autoClaimedRowKeys.push(claimedKey);
            }
          } catch (err) {
            autoApprovalErrors.push(
              err instanceof Error
                ? err.message
                : `Failed to auto-approve ${match.bankTransaction.description || "transaction"}.`,
            );
          }
        }),
      );
      if (newAutoHashes.length > 0) {
        const merged = new Set(processedList);
        newAutoHashes.forEach((h) => merged.add(h));
        processedList = Array.from(merged);
      }
    }

    setProcessedHashes(new Set(processedList.map((h) => String(h))));
    if (autoClaimedHashes.length > 0) {
      setBankHashesWithNeonClaim((prev) => {
        const next = new Set(prev);
        autoClaimedHashes.forEach((hash) => next.add(hash));
        return next;
      });
    }
    if (autoClaimedRowKeys.length > 0) {
      setClaimedRowKeys((prev) => {
        const next = new Set(prev);
        autoClaimedRowKeys.forEach((key) => next.add(key));
        return next;
      });
    }
    setMatchesByAccount((prev) => mergeWellsFargoBucketIntoChecking({ ...prev, ...nextMatches }));

    // Persist updated match results to Neon (replace mode per account).
    const rematchErrors: string[] = [];
    for (const [accountName, matches] of Object.entries(nextMatches)) {
      try {
        await saveMatchCacheToNeon(accountName, matches, true);
      } catch (e) {
        rematchErrors.push(`${accountName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (rematchErrors.length > 0) {
      setActionError(`Re-match data failed to save to cloud: ${rematchErrors.join("; ")}`);
    }

    if (autoApprovalErrors.length > 0) {
      setActionError(autoApprovalErrors[0]);
    }
  }, [persistAutoClaim]);

  const handleApprove = useCallback(
    async (match: MatchResult, userEntry?: UserInputtedEntry) => {
      const tx = match.bankTransaction;
      const id = idForTx(tx);
      const bankAbs = Math.abs(tx.amount);
      const bankCents = toCents(bankAbs);

      if (userEntry) {
        if (userEntry.source === "Expenses") {
          const expenseRowIdFromEntry = parseExpenseRowIdFromEntryId(userEntry.id);
          if (!expenseRowIdFromEntry) {
            setActionError("This expense row is missing a Row ID. Use Claim to choose a sheet row.");
            return;
          }
          if (toCents(Math.abs(userEntry.amount)) !== bankCents) {
            setActionError("User-inputted amount does not match this bank line; use Claim.");
            return;
          }
          setActionError("");
          setProcessingId(id);
          try {
            const res = await fetch("/api/reconciliation/claims", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                bankTransaction: {
                  hash: tx.hash,
                  accountName: tx.accountName,
                  amount: tx.amount,
                  date: tx.date,
                  description: tx.description,
                },
                links: [
                  {
                    sheetName: "Expenses",
                    sheetRowId: expenseRowIdFromEntry,
                    amount: bankAbs,
                  },
                ],
              }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: res.statusText }));
              throw new Error(err.error || `Failed to save sheet link (${res.status})`);
            }
            await persistProcessedHash(tx);
            setProcessedHashes((prev) => new Set(prev).add(tx.hash));
            setClaimedRowKeys((prev) => {
              const next = new Set(prev);
              next.add(claimKey("Expenses", expenseRowIdFromEntry));
              return next;
            });
            setMatchesByAccount((prev) => {
              const next: Record<string, MatchResult[]> = {};
              for (const [account, rows] of Object.entries(prev)) {
                next[account] = rows.map((row) => {
                  if (idForTx(row.bankTransaction) !== id) return row;
                  const exp = sheetExpenses.find((e) => (e.rowId ?? "").trim() === expenseRowIdFromEntry);
                  return {
                    ...row,
                    matchType: "exact_match",
                    reason: "Linked user-inputted expense row and marked processed.",
                    matchedSheetExpense: exp
                      ? {
                          amount: Math.abs(Number(exp.amount)),
                          timestamp: exp.timestamp ?? tx.date,
                          description: exp.description ?? "",
                          expenseType: exp.expenseType ?? "—",
                          account: exp.account ?? tx.accountName,
                          rowId: exp.rowId,
                          date: exp.date,
                        }
                      : {
                          amount: Math.abs(userEntry.amount),
                          timestamp: userEntry.dateValue || tx.date,
                          description: userEntry.title,
                          expenseType: "—",
                          account: tx.accountName,
                          rowId: expenseRowIdFromEntry,
                          date: userEntry.dateValue || tx.date,
                        },
                    matchedSheetIndex: undefined,
                    matchedSheetTransfer: undefined,
                    matchedSheetTransferIndex: undefined,
                  };
                });
              }
              return next;
            });
            setDisconnectedIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            void refreshBankHashesWithNeonClaim();
          } catch (err) {
            setActionError(err instanceof Error ? err.message : "Failed to approve and link.");
          } finally {
            setProcessingId(null);
          }
          return;
        }

        const transferRowIdFromEntry = parseTransferRowIdFromEntryId(userEntry.id);
        if (!transferRowIdFromEntry) {
          setActionError("This transfer row is missing a Transfer Row ID. Use Claim to choose a sheet row.");
          return;
        }
        if (toCents(Math.abs(userEntry.amount)) !== bankCents) {
          setActionError("User-inputted amount does not match this bank line; use Claim.");
          return;
        }
        setActionError("");
        setProcessingId(id);
        try {
          const res = await fetch("/api/reconciliation/claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
                date: tx.date,
                description: tx.description,
              },
              links: [
                {
                  sheetName: "Transfers",
                  sheetRowId: transferRowIdFromEntry,
                  amount: bankAbs,
                },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Failed to save transfer link (${res.status})`);
          }
          const tRes = await fetch("/api/reconciliation/transfer-claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transferRowId: transferRowIdFromEntry,
              expectedLegs: 2,
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
              },
            }),
          });
          if (!tRes.ok) {
            const err = await tRes.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Saved link but transfer tracking failed (${tRes.status}).`);
          }
          const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
          if (tClaimsGet.ok) {
            const transferClaimsData = (await tClaimsGet.json()) as {
              statusByRowId?: TransferClaimStatusByRowId;
            };
            setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
          }
          await persistProcessedHash(tx);
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            next.add(claimKey("Transfers", transferRowIdFromEntry));
            return next;
          });
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [account, rows] of Object.entries(prev)) {
              next[account] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== id) return row;
                const tr = sheetTransfers.find(
                  (t) => (t.transferRowId ?? "").trim() === transferRowIdFromEntry,
                );
                const amountSignedForTransfer = tr
                  ? tx.amount < 0
                    ? -Math.abs(Number(tr.amount ?? 0))
                    : Math.abs(Number(tr.amount ?? 0))
                  : tx.amount;
                return {
                  ...row,
                  matchType: "exact_match",
                  reason: "Linked user-inputted transfer row and marked processed.",
                  matchedSheetTransfer: {
                    amount: amountSignedForTransfer,
                    transferRowId: transferRowIdFromEntry,
                    transferFrom: tr?.transferFrom ?? userEntry.transferFrom ?? "—",
                    transferTo: tr?.transferTo ?? userEntry.transferTo ?? "—",
                    timestamp: tr?.timestamp ?? userEntry.dateValue ?? tx.date,
                    date: tr?.date ?? userEntry.dateValue ?? tx.date,
                  },
                  matchedSheetTransferIndex: undefined,
                  matchedSheetExpense: undefined,
                  matchedSheetIndex: undefined,
                };
              });
            }
            return next;
          });
          setDisconnectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          void refreshBankHashesWithNeonClaim();
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "Failed to approve transfer.");
        } finally {
          setProcessingId(null);
        }
        return;
      }

      const transferRowId = String(match.matchedSheetTransfer?.transferRowId ?? "").trim();
      if (
        match.matchedSheetTransfer &&
        transferRowId &&
        (match.matchType === "transfer" || match.matchType === "questionable_match_fuzzy" || match.matchType === "suggested_match")
      ) {
        openTransferClaimModal(match);
        return;
      }
      const expenseRowId = String(match.matchedSheetExpense?.rowId ?? "").trim();

      if (match.matchedSheetExpense && expenseRowId) {
        const expCents = toCents(Math.abs(Number(match.matchedSheetExpense.amount ?? 0)));
        if (expCents !== bankCents) {
          setActionError("Sheet amount does not match this bank line; use Claim to pick a different row.");
          return;
        }
        setActionError("");
        setProcessingId(id);
        try {
          const res = await fetch("/api/reconciliation/claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
                date: tx.date,
                description: tx.description,
              },
              links: [
                {
                  sheetName: "Expenses",
                  sheetRowId: expenseRowId,
                  amount: bankAbs,
                },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Failed to save sheet link (${res.status})`);
          }
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            next.add(claimKey("Expenses", expenseRowId));
            return next;
          });
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [account, rows] of Object.entries(prev)) {
              next[account] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== id) return row;
                const exp = sheetExpenses.find((e) => (e.rowId ?? "").trim() === expenseRowId);
                if (!exp) return row;
                return {
                  ...row,
                  matchType: "exact_match",
                  reason: "Linked sheet row and marked processed.",
                  matchedSheetExpense: {
                    amount: Math.abs(Number(exp.amount)),
                    timestamp: exp.timestamp ?? tx.date,
                    description: exp.description ?? "",
                    expenseType: exp.expenseType ?? "—",
                    account: exp.account ?? tx.accountName,
                    rowId: exp.rowId,
                    date: exp.date,
                  },
                  matchedSheetIndex: undefined,
                  matchedSheetTransfer: undefined,
                  matchedSheetTransferIndex: undefined,
                };
              });
            }
            return next;
          });
          setDisconnectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          void refreshBankHashesWithNeonClaim();
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "Failed to approve and link.");
        } finally {
          setProcessingId(null);
        }
        return;
      }

      if (match.matchedSheetTransfer && transferRowId && match.matchType === "exact_match") {
        setActionError("");
        setProcessingId(id);
        try {
          const res = await fetch("/api/reconciliation/claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
                date: tx.date,
                description: tx.description,
              },
              links: [
                {
                  sheetName: "Transfers",
                  sheetRowId: transferRowId,
                  amount: bankAbs,
                },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Failed to save transfer link (${res.status})`);
          }
          const tRes = await fetch("/api/reconciliation/transfer-claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transferRowId,
              expectedLegs: 2,
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
              },
            }),
          });
          if (!tRes.ok) {
            const err = await tRes.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Saved link but transfer tracking failed (${tRes.status}).`);
          }
          const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
          if (tClaimsGet.ok) {
            const transferClaimsData = (await tClaimsGet.json()) as {
              statusByRowId?: TransferClaimStatusByRowId;
            };
            setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
          }
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            next.add(claimKey("Transfers", transferRowId));
            return next;
          });
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [account, rows] of Object.entries(prev)) {
              next[account] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== id) return row;
                const tr = sheetTransfers.find((t) => (t.transferRowId ?? "").trim() === transferRowId);
                if (!tr) return row;
                const amountSignedForTransfer =
                  tx.amount < 0 ? -Math.abs(Number(tr.amount ?? 0)) : Math.abs(Number(tr.amount ?? 0));
                return {
                  ...row,
                  matchType: "exact_match",
                  reason: "Linked transfer row and marked processed.",
                  matchedSheetTransfer: {
                    amount: amountSignedForTransfer,
                    transferRowId,
                    transferFrom: tr.transferFrom,
                    transferTo: tr.transferTo,
                    timestamp: tr.timestamp,
                    date: tr.date,
                  },
                  matchedSheetTransferIndex: undefined,
                  matchedSheetExpense: undefined,
                  matchedSheetIndex: undefined,
                };
              });
            }
            return next;
          });
          setDisconnectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          void refreshBankHashesWithNeonClaim();
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "Failed to approve transfer.");
        } finally {
          setProcessingId(null);
        }
        return;
      }

      setActionError("");
      setProcessingId(id);
      try {
        await persistProcessedHash(tx);
        setProcessedHashes((prev) => new Set(prev).add(tx.hash));
        setDisconnectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to approve transaction.");
      } finally {
        setProcessingId(null);
      }
    },
    [openTransferClaimModal, persistProcessedHash, refreshBankHashesWithNeonClaim, sheetExpenses, sheetTransfers],
  );

  const handleClearFile = useCallback(
    async (accountName: string, fileName: string) => {
      if (!window.confirm(`Clear all reconciliation data for "${fileName}"? This removes all claim links and processed markers for transactions from this file so you can re-upload and re-reconcile them.`)) return;
      try {
        const res = await fetch("/api/reconciliation/uploaded-files", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountName, fileName }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          setActionError(err.error || `Failed to clear file (${res.status})`);
          return;
        }
        const { clearedHashes } = (await res.json()) as { clearedHashes: string[] };
        const clearedSet = new Set(clearedHashes ?? []);

        // Remove cleared hashes from processed state.
        if (clearedSet.size > 0) {
          setProcessedHashes((prev) => {
            const next = new Set(prev);
            for (const h of clearedSet) next.delete(h);
            return next;
          });
          // Remove cleared transactions from match state so they drop out of the UI.
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [acct, rows] of Object.entries(prev)) {
              next[acct] = rows.filter((m) => !clearedSet.has(m.bankTransaction.hash));
            }
            return next;
          });
          setBankHashesWithNeonClaim((prev) => {
            const next = new Set(prev);
            for (const h of clearedSet) next.delete(h);
            return next;
          });
        }

        // Remove the file from the list.
        setUploadedFilesByAccount((prev) => ({
          ...prev,
          [accountName]: (prev[accountName] ?? []).filter((f) => f !== fileName),
        }));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to clear file.");
      }
    },
    [],
  );

  const handleRemoveDuplicateRows = useCallback(
    async (accountName: string) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(
          `Remove already-reconciled duplicate statement rows for "${accountName}"?\n\nThis deletes redundant copies of transactions that are already matched or processed — the leftovers from re-importing overlapping statements. Your matches, claims, and genuinely-unmatched transactions are not affected.`,
        );
        if (!ok) return;
      }
      setRemovingDuplicates(true);
      setActionError("");
      try {
        const res = await fetch("/api/reconciliation/dedupe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountName }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          setActionError(err.error || `Failed to remove duplicates (${res.status})`);
          return;
        }
        const data = (await res.json()) as {
          removedHashes?: string[];
          removedCount?: number;
          rows?: string[][];
        };
        const removedSet = new Set(data.removedHashes ?? []);
        statementCsvRowsByAccountRef.current = {
          ...statementCsvRowsByAccountRef.current,
          [accountName]: Array.isArray(data.rows)
            ? data.rows
            : statementCsvRowsByAccountRef.current[accountName] ?? [],
        };
        if (removedSet.size > 0) {
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [acct, rows] of Object.entries(prev)) {
              next[acct] = rows.filter((m) => !removedSet.has(m.bankTransaction.hash));
            }
            return mergeWellsFargoBucketIntoChecking(next);
          });
        }
        if (typeof window !== "undefined") {
          const count = data.removedCount ?? 0;
          window.alert(
            count > 0
              ? `Removed ${count} duplicate row${count === 1 ? "" : "s"} from ${accountName}.`
              : `No already-reconciled duplicate rows were found for ${accountName}.`,
          );
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to remove duplicates.");
      } finally {
        setRemovingDuplicates(false);
      }
    },
    [],
  );

  const handleRematchFromSheet = useCallback(async () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Re-match all uploaded statements against your current Google Sheet?\n\nThis links bank transactions to expenses you've added since the last upload. Exact matches move to \"Matched\"; the rest become suggested matches you can bulk-approve. Nothing is removed.",
      );
      if (!ok) return;
    }
    setRematching(true);
    setActionError("");
    try {
      await rematchAllStoredAccounts();
      if (typeof window !== "undefined") {
        window.alert(
          "Re-match complete. Exact matches moved to \"Matched to sheet\". Review the remaining suggested matches and use Bulk Approve to confirm them.",
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Re-match failed.");
    } finally {
      setRematching(false);
    }
  }, [rematchAllStoredAccounts]);

  const handleDisconnectSheetLink = useCallback(
    async (match: MatchResult) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(
          "Remove the Neon link between this bank line and the sheet row, unmark it processed, and put it back in review? You can link again with Claim or the checkmark.",
        );
        if (!ok) return;
      }
      const tx = match.bankTransaction;
      const bid = idForTx(tx);
      setActionError("");
      setProcessingId(bid);
      try {
        const bankBody = JSON.stringify({
          bankTransaction: { hash: tx.hash, accountName: tx.accountName },
        });
        const procBody = JSON.stringify({ hash: tx.hash, accountName: tx.accountName });
        const [claimsDel, transferDel, procDel] = await Promise.all([
          fetch("/api/reconciliation/claims", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: bankBody,
          }),
          fetch("/api/reconciliation/transfer-claims", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: bankBody,
          }),
          fetch("/api/reconciliation/processed", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: procBody,
          }),
        ]);
        if (!procDel.ok) {
          const err = await procDel.json().catch(() => ({ error: procDel.statusText }));
          throw new Error(err.error || `Could not unmark processed (${procDel.status})`);
        }
        if (!claimsDel.ok) {
          const err = await claimsDel.json().catch(() => ({ error: claimsDel.statusText }));
          throw new Error(err.error || `Could not remove claim (${claimsDel.status})`);
        }
        if (!transferDel.ok) {
          const err = await transferDel.json().catch(() => ({ error: transferDel.statusText }));
          throw new Error(err.error || `Could not remove transfer claim (${transferDel.status})`);
        }

        setProcessedHashes((prev) => {
          const next = new Set(prev);
          next.delete(tx.hash);
          return next;
        });

        const claimsGet = await fetch("/api/reconciliation/claims", { cache: "no-store" });
        if (claimsGet.ok) {
          const data = (await claimsGet.json()) as { claimedRowIds?: string[] };
          setClaimedRowKeys(new Set((data.claimedRowIds ?? []).map((x) => String(x))));
        }

        const tGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
        if (tGet.ok) {
          const data = (await tGet.json()) as { statusByRowId?: TransferClaimStatusByRowId };
          setTransferClaimStatusByRowId(data.statusByRowId ?? {});
        }

        void refreshBankHashesWithNeonClaim();

        const hadStoredCsv = Object.keys(statementCsvRowsByAccountRef.current).length > 0;
        const patchDisconnectedRow = () => {
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [acct, rows] of Object.entries(prev)) {
              next[acct] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== bid) return row;
                return {
                  ...row,
                  matchType: "unmatched",
                  reason: "Disconnected from sheet link.",
                  matchedSheetExpense: undefined,
                  matchedSheetTransfer: undefined,
                  matchedSheetIndex: undefined,
                  matchedSheetTransferIndex: undefined,
                };
              });
            }
            return mergeWellsFargoBucketIntoChecking(next);
          });
        };
        try {
          if (hadStoredCsv) {
            await rematchAllStoredAccounts();
          } else {
            patchDisconnectedRow();
          }
        } catch (rematchErr) {
          setActionError(
            rematchErr instanceof Error ? rematchErr.message : "Rematch failed after disconnect.",
          );
          patchDisconnectedRow();
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to disconnect link.");
      } finally {
        setProcessingId(null);
      }
    },
    [refreshBankHashesWithNeonClaim, rematchAllStoredAccounts],
  );

  const openDismissModal = useCallback((match: MatchResult) => {
    setDismissModal({
      open: true,
      match,
      note: "",
      submitting: false,
      error: "",
    });
  }, []);

  const closeDismissModal = useCallback(() => {
    setDismissModal({ open: false, match: null, note: "", submitting: false, error: "" });
  }, []);

  const handleDismissSubmit = useCallback(async () => {
    const match = dismissModal.match;
    if (!match) return;
    const tx = match.bankTransaction;
    const id = idForTx(tx);
    const note = dismissModal.note.trim();
    if (!note) {
      setDismissModal((prev) => ({ ...prev, error: "Enter a note." }));
      return;
    }
    setDismissModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: tx.hash, accountName: tx.accountName, note }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save dismissal (${res.status})`);
      }
      setProcessedHashes((prev) => new Set(prev).add(tx.hash));
      setDismissalNotesById((prev) => ({ ...prev, [id]: note }));
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setDismissModal({ open: false, match: null, note: "", submitting: false, error: "" });
    } catch (err) {
      setDismissModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to dismiss.",
      }));
    }
  }, [dismissModal.match, dismissModal.note]);

  const openUserDismissModal = useCallback((entry: UserInputtedEntry) => {
    setUserDismissModal({
      open: true,
      entry,
      note: "",
      submitting: false,
      error: "",
    });
  }, []);

  const closeUserDismissModal = useCallback(() => {
    setUserDismissModal({ open: false, entry: null, note: "", submitting: false, error: "" });
  }, []);

  const handleUserDismissSubmit = useCallback(async () => {
    const entry = userDismissModal.entry;
    if (!entry) return;
    const parsed = parseSheetDismissKeyFromEntryId(entry.id);
    if (!parsed) {
      setUserDismissModal((prev) => ({ ...prev, error: "This row cannot be dismissed (missing row id)." }));
      return;
    }
    const note = userDismissModal.note.trim();
    if (!note) {
      setUserDismissModal((prev) => ({ ...prev, error: "Enter a note." }));
      return;
    }
    setUserDismissModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/user-dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetName: parsed.sheetName,
          sheetRowId: parsed.sheetRowId,
          note,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save dismissal (${res.status})`);
      }
      setUserDismissedRowKeys((prev) => new Set(prev).add(entry.id));
      setUserDismissalNotesByEntryId((prev) => ({ ...prev, [entry.id]: note }));
      setUserDismissModal({ open: false, entry: null, note: "", submitting: false, error: "" });
    } catch (err) {
      setUserDismissModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to dismiss.",
      }));
    }
  }, [userDismissModal.entry, userDismissModal.note]);

  const openEditEntryModal = useCallback((entry: UserInputtedEntry) => {
    const rowId = rowIdFromEntryId(entry.id);
    const raw = entry.dateValue;
    const asDate = raw ? new Date(raw) : null;
    const dateStr = asDate && !isNaN(asDate.getTime()) ? asDate.toISOString().slice(0, 10) : "";
    setEditEntryModal({ open: true, entry, rowId, date: dateStr, submitting: false, error: "" });
  }, []);

  const closeEditEntryModal = useCallback(() => {
    setEditEntryModal((prev) => ({ ...prev, open: false, entry: null, error: "" }));
  }, []);

  const handleEditEntrySubmit = useCallback(async () => {
    const { entry, rowId, date } = editEntryModal;
    if (!entry || !rowId) return;
    if (!date) {
      setEditEntryModal((prev) => ({ ...prev, error: "Select a date." }));
      return;
    }
    setEditEntryModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      await updateSheetEntryDate({ sheet: entry.source, rowId, date });
      if (entry.source === "Expenses") {
        setSheetExpenses((prev) =>
          prev.map((row) =>
            (row.rowId ?? "").trim() === rowId ? { ...row, timestamp: date, date } : row,
          ),
        );
      } else {
        setSheetTransfers((prev) =>
          prev.map((row) =>
            (row.transferRowId ?? "").trim() === rowId ? { ...row, timestamp: date, date } : row,
          ),
        );
      }
      closeEditEntryModal();
      rematchAllStoredAccounts();
    } catch (err) {
      setEditEntryModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to update date.",
      }));
    }
  }, [closeEditEntryModal, editEntryModal, rematchAllStoredAccounts, setSheetExpenses, setSheetTransfers]);

  const openResetReconcileModal = useCallback(() => {
    setResetReconcileModal({ open: true, confirmText: "", submitting: false, error: "" });
  }, []);

  const closeResetReconcileModal = useCallback(() => {
    setResetReconcileModal({ open: false, confirmText: "", submitting: false, error: "" });
  }, []);

  const handleFullReconcileReset = useCallback(async () => {
    if (resetReconcileModal.confirmText.trim() !== RECONCILIATION_RESET_CONFIRM) {
      setResetReconcileModal((prev) => ({
        ...prev,
        error: `Type ${RECONCILIATION_RESET_CONFIRM} exactly to confirm.`,
      }));
      return;
    }
    setResetReconcileModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: RECONCILIATION_RESET_CONFIRM }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Reset failed (${res.status})`);
      }
      setMatchesByAccount({});
      statementCsvRowsByAccountRef.current = {};
      setProcessedHashes(new Set());
      setDismissalNotesById({});
      setUserDismissedRowKeys(new Set());
      setUserDismissalNotesByEntryId({});
      setDisconnectedIds(new Set());
      setClaimedRowKeys(new Set());
      setBankHashesWithNeonClaim(new Set());
      setTransferClaimStatusByRowId({});
      setUploadedFilesByAccount({});
      setActionError("");
      setUploadError("");
      setResetReconcileModal({ open: false, confirmText: "", submitting: false, error: "" });
    } catch (err) {
      setResetReconcileModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Reset failed.",
      }));
    }
  }, [resetReconcileModal.confirmText]);

  const handleQuickAddSubmit = useCallback(async () => {
    if (!quickAdd.rowId) return;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === quickAdd.rowId);
    if (!selected) {
      setQuickAdd((prev) => ({ ...prev, error: "Transaction no longer available." }));
      return;
    }

    const amountNum = Number(quickAdd.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setQuickAdd((prev) => ({ ...prev, error: "Enter a valid amount." }));
      return;
    }
    if (!quickAdd.description.trim()) {
      setQuickAdd((prev) => ({ ...prev, error: "Description is required." }));
      return;
    }

    setQuickAdd((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const description = quickAdd.description.trim();
      const expenseType = quickAdd.expenseType;
      const tx = selected.bankTransaction;
      const bankCents = toCents(Math.abs(tx.amount));

      await submitExpense({
        expenseType,
        amount: amountNum,
        description,
        date: tx.date,
      });

      // Find the newly-created sheet row so we can create a claim link.
      // Apps Script does not return the row id, so we re-fetch and pick the
      // most recent row matching amount + description + expense type.
      let linkedRowId: string | null = null;
      try {
        const freshExpenses = await getExpenses();
        const match = [...freshExpenses]
          .reverse()
          .find((row) => {
            if (toCents(Math.abs(Number(row.amount ?? 0))) !== toCents(amountNum)) return false;
            if ((row.expenseType ?? "").trim() !== expenseType) return false;
            const desc = (row.description ?? "").trim().toLowerCase();
            return desc === description.toLowerCase();
          });
        if (match?.rowId) {
          linkedRowId = match.rowId.trim();
          setSheetExpenses(freshExpenses);
        }
      } catch {
        // Heuristic re-fetch is best-effort; fall through to processed-only.
      }

      if (linkedRowId) {
        // Create the claim link, marking processed atomically server-side.
        const claimRes = await fetch("/api/reconciliation/claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bankTransaction: {
              hash: tx.hash,
              accountName: tx.accountName,
              amount: tx.amount,
              date: tx.date,
              description: tx.description,
            },
            links: [
              { sheetName: "Expenses", sheetRowId: linkedRowId, amount: Math.abs(tx.amount) },
            ],
            actor: "user",
          }),
        });
        if (claimRes.ok) {
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            next.add(claimKey("Expenses", linkedRowId as string));
            return next;
          });
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [account, rows] of Object.entries(prev)) {
              next[account] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== quickAdd.rowId) return row;
                return {
                  ...row,
                  matchType: "exact_match",
                  reason: "Quick logged: created sheet row and linked to bank transaction.",
                  matchedSheetExpense: {
                    amount: amountNum,
                    timestamp: tx.date,
                    description,
                    expenseType,
                    account: tx.accountName,
                    rowId: linkedRowId as string,
                    date: tx.date,
                  },
                  matchedSheetIndex: undefined,
                  matchedSheetTransfer: undefined,
                  matchedSheetTransferIndex: undefined,
                };
              });
            }
            return next;
          });
          // Memory increment: this user-confirmed pattern should auto-claim next time.
          void recordMerchantMemory(tx, expenseType);
          void refreshBankHashesWithNeonClaim();
        } else {
          // Sheet row exists, but linking failed. Fall back to processed-only.
          await persistProcessedHash(tx);
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
        }
      } else {
        // No row id discovered — fall back to processed-only so the bank tx
        // disappears from review. The user can manually claim later.
        await persistProcessedHash(tx);
        setProcessedHashes((prev) => new Set(prev).add(tx.hash));
      }

      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(quickAdd.rowId as string);
        return next;
      });
      closeQuickAdd();
    } catch (err) {
      setQuickAdd((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to quick add.",
      }));
    }
  }, [
    allMatches,
    closeQuickAdd,
    persistProcessedHash,
    quickAdd,
    recordMerchantMemory,
    refreshBankHashesWithNeonClaim,
  ]);

  const splitTargetAmount = useMemo(() => {
    if (!splitModal.rowId) return 0;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === splitModal.rowId);
    if (!selected) return 0;
    return Math.abs(selected.bankTransaction.amount);
  }, [allMatches, splitModal.rowId]);

  const splitTargetTransaction = useMemo(() => {
    if (!splitModal.rowId) return null;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === splitModal.rowId);
    return selected?.bankTransaction ?? null;
  }, [allMatches, splitModal.rowId]);

  const sortedSplitCandidates = useMemo(
    () => sortByNewestDate(splitModal.candidates, (row) => row.timestamp),
    [splitModal.candidates],
  );

  const filteredSplitCandidates = useMemo(() => {
    const q = normalizeText(splitSearchQuery);
    if (!q) return sortedSplitCandidates;
    return sortedSplitCandidates.filter((row) =>
      [
        row.sheetName,
        row.expenseType,
        row.description,
        row.account,
        row.rowId,
        row.timestamp,
      ].some((value) => normalizeText(value).includes(q)),
    );
  }, [sortedSplitCandidates, splitSearchQuery]);

  const selectedClaimRows = useMemo(
    () => splitModal.candidates.filter((row) => splitModal.selectedKeys.includes(row.key)),
    [splitModal.candidates, splitModal.selectedKeys],
  );

  const splitSelectionIncludesTransfer = useMemo(
    () => selectedClaimRows.some((row) => row.sheetName === "Transfers"),
    [selectedClaimRows],
  );

  const splitEnteredAmount = useMemo(
    () => selectedClaimRows.reduce((sum, row) => sum + row.amount, 0),
    [selectedClaimRows],
  );

  const splitRemainingAmount = useMemo(
    () => splitTargetAmount - splitEnteredAmount,
    [splitEnteredAmount, splitTargetAmount],
  );

  const handleToggleSplitClaim = useCallback((key: string) => {
    setSplitModal((prev) => {
      const selected = new Set(prev.selectedKeys);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return {
        ...prev,
        error: "",
        selectedKeys: Array.from(selected),
      };
    });
  }, []);

  const handleSplitSubmit = useCallback(async (overrideLegs?: 1 | 2) => {
    if (!splitModal.rowId) return;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === splitModal.rowId);
    if (!selected) {
      setSplitModal((prev) => ({ ...prev, error: "Transaction no longer available." }));
      return;
    }

    const selectedRows = splitModal.candidates.filter((row) => splitModal.selectedKeys.includes(row.key));
    if (selectedRows.length === 0) {
      setSplitModal((prev) => ({ ...prev, error: "Select at least one existing sheet row." }));
      return;
    }

    const transferSelected = selectedRows.filter((row) => row.sheetName === "Transfers");
    const expenseSelected = selectedRows.filter((row) => row.sheetName === "Expenses");
    if (transferSelected.length > 0 && expenseSelected.length > 0) {
      setSplitModal((prev) => ({
        ...prev,
        error:
          "Claim transfer rows separately from expense rows (one claim for transfers only, another for expenses).",
      }));
      return;
    }
    if (transferSelected.length > 1) {
      setSplitModal((prev) => ({
        ...prev,
        error: "Select only one transfer sheet row per claim.",
      }));
      return;
    }

    const targetCents = toCents(Math.abs(selected.bankTransaction.amount));
    const enteredCents = selectedRows.reduce((sum, row) => sum + toCents(row.amount), 0);
    if (enteredCents !== targetCents) {
      setSplitModal((prev) => ({
        ...prev,
        error: `Selected rows must total ${fmtMoney(Math.abs(selected.bankTransaction.amount))}.`,
      }));
      return;
    }

    setSplitModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransaction: {
            hash: selected.bankTransaction.hash,
            accountName: selected.bankTransaction.accountName,
            amount: selected.bankTransaction.amount,
            date: selected.bankTransaction.date,
            description: selected.bankTransaction.description,
          },
          links: selectedRows.map((row) => ({
            sheetName: row.sheetName,
            sheetRowId: row.rowId,
            amount: row.amount,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to claim existing rows (${res.status})`);
      }

      if (transferSelected.length === 1) {
        const tr = transferSelected[0];
        const tRes = await fetch("/api/reconciliation/transfer-claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transferRowId: tr.rowId,
            expectedLegs: overrideLegs ?? splitModal.transferExpectedLegs,
            bankTransaction: {
              hash: selected.bankTransaction.hash,
              accountName: selected.bankTransaction.accountName,
              amount: selected.bankTransaction.amount,
            },
          }),
        });
        if (!tRes.ok) {
          const err = await tRes.json().catch(() => ({ error: tRes.statusText }));
          throw new Error(
            err.error ||
              `Saved sheet link but transfer leg tracking failed (${tRes.status}). Try again or use disconnect.`,
          );
        }
        const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
        if (tClaimsGet.ok) {
          const transferClaimsData = (await tClaimsGet.json()) as {
            statusByRowId?: TransferClaimStatusByRowId;
          };
          setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
        }
      }

      setClaimedRowKeys((prev) => {
        const next = new Set(prev);
        selectedRows.forEach((row) => next.add(row.key));
        return next;
      });
      setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      const totalClaimedAmount = selectedRows.reduce((sum, row) => sum + row.amount, 0);
      const claimedDescription =
        selectedRows.length === 1
          ? selectedRows[0].description || selected.bankTransaction.description
          : `Split claim (${selectedRows.length} rows): ${selectedRows
              .map((row) => row.description)
              .filter((value) => Boolean(value && value.trim()))
              .slice(0, 2)
              .join(" + ") || selected.bankTransaction.description}`;
      const linkedExpense = {
        amount: totalClaimedAmount,
        timestamp:
          selectedRows.length === 1
            ? selectedRows[0].timestamp ?? selected.bankTransaction.date
            : selected.bankTransaction.date,
        description: claimedDescription,
        expenseType: selectedRows.length === 1 ? selectedRows[0].expenseType : "Split Claim",
        account:
          selectedRows.length === 1
            ? selectedRows[0].account ?? selected.bankTransaction.accountName
            : selected.bankTransaction.accountName,
        rowId:
          selectedRows.length === 1
            ? selectedRows[0].rowId
            : selectedRows.map((row) => row.rowId).join(", "),
      };

      const singleTransfer = transferSelected.length === 1 ? transferSelected[0] : null;
      const amountSignedForTransfer = singleTransfer
        ? selected.bankTransaction.amount < 0
          ? -Math.abs(singleTransfer.amount)
          : Math.abs(singleTransfer.amount)
        : 0;

      setMatchesByAccount((prev) => {
        const next: Record<string, MatchResult[]> = {};
        for (const [account, rows] of Object.entries(prev)) {
          next[account] = rows.map((row) => {
            if (idForTx(row.bankTransaction) !== splitModal.rowId) return row;
            if (singleTransfer) {
              return {
                ...row,
                matchType: "exact_match",
                reason: "Claimed transfer sheet row and marked processed.",
                matchedSheetTransfer: {
                  amount: amountSignedForTransfer,
                  transferRowId: singleTransfer.rowId,
                  transferFrom: singleTransfer.transferFrom,
                  transferTo: singleTransfer.transferTo,
                  timestamp: singleTransfer.timestamp,
                  date: singleTransfer.date,
                },
                matchedSheetTransferIndex: undefined,
                matchedSheetExpense: undefined,
                matchedSheetIndex: undefined,
              };
            }
            return {
              ...row,
              reason:
                selectedRows.length === 1
                  ? "Claimed existing sheet row and marked processed."
                  : `Claimed ${selectedRows.length} existing sheet rows and marked processed.`,
              matchedSheetExpense: linkedExpense,
              matchedSheetIndex: undefined,
              matchedSheetTransfer: undefined,
              matchedSheetTransferIndex: undefined,
            };
          });
        }
        return next;
      });
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(splitModal.rowId as string);
        return next;
      });
      void refreshBankHashesWithNeonClaim();
      closeSplitModal();
    } catch (err) {
      setSplitModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim selected rows.",
      }));
    }
  }, [
    allMatches,
    closeSplitModal,
    refreshBankHashesWithNeonClaim,
    splitModal.rowId,
    splitModal.transferExpectedLegs,
    splitModal.selectedKeys,
    splitModal.candidates,
  ]);

  const handleSplitSaveClick = useCallback(() => {
    if (splitSelectionIncludesTransfer) {
      setTransferClaimModal({
        open: true,
        rowId: null,
        expectedLegs: splitModal.transferExpectedLegs,
        submitting: false,
        error: "",
        pendingClaimSource: "split",
      });
    } else {
      void handleSplitSubmit();
    }
  }, [handleSplitSubmit, splitModal.transferExpectedLegs, splitSelectionIncludesTransfer]);

  const handleTransferClaimSubmit = useCallback(async () => {
    if (transferClaimModal.pendingClaimSource === "manual") {
      const legs = transferClaimModal.expectedLegs;
      closeTransferClaimModal();
      void handleUserStatementClaimSubmit(legs);
      return;
    }
    if (transferClaimModal.pendingClaimSource === "split") {
      const legs = transferClaimModal.expectedLegs;
      closeTransferClaimModal();
      void handleSplitSubmit(legs);
      return;
    }
    if (!transferClaimModal.rowId) return;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === transferClaimModal.rowId);
    if (!selected) {
      setTransferClaimModal((prev) => ({ ...prev, error: "Transaction no longer available." }));
      return;
    }
    const transferRowId = String(selected.matchedSheetTransfer?.transferRowId ?? "").trim();
    if (!transferRowId) {
      setTransferClaimModal((prev) => ({
        ...prev,
        error: "Matched transfer row is missing Transfer Row ID.",
      }));
      return;
    }

    setTransferClaimModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/transfer-claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transferRowId,
          expectedLegs: transferClaimModal.expectedLegs,
          bankTransaction: {
            hash: selected.bankTransaction.hash,
            accountName: selected.bankTransaction.accountName,
            amount: selected.bankTransaction.amount,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to claim transfer leg (${res.status})`);
      }
      const payload = (await res.json()) as {
        expectedLegs?: number;
        claimedCount?: number;
        isComplete?: boolean;
      };
      const refreshedTransferClaimsRes = await fetch("/api/reconciliation/transfer-claims", {
        cache: "no-store",
      });
      if (refreshedTransferClaimsRes.ok) {
        const transferClaimsData = (await refreshedTransferClaimsRes.json()) as {
          statusByRowId?: TransferClaimStatusByRowId;
        };
        setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
      } else {
        // Fallback to optimistic local patch when refresh endpoint is unavailable.
        setTransferClaimStatusByRowId((prev) => ({
          ...prev,
          [transferRowId]: {
            expectedLegs: payload.expectedLegs === 1 ? 1 : 2,
            claimedCount: Number(payload.claimedCount ?? 1),
            isComplete: Boolean(payload.isComplete),
          },
        }));
      }
      try {
        await rematchAllStoredAccounts();
      } catch (rematchErr) {
        setActionError(
          rematchErr instanceof Error ? rematchErr.message : "Rematch after transfer claim failed.",
        );
        setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      }
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(transferClaimModal.rowId as string);
        return next;
      });
      closeTransferClaimModal();
    } catch (err) {
      setTransferClaimModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim transfer.",
      }));
    }
  }, [allMatches, closeTransferClaimModal, handleSplitSubmit, handleUserStatementClaimSubmit, rematchAllStoredAccounts, transferClaimModal]);

  const runUploadPipeline = useCallback(
    async (file: File, parsedRows: string[][]) => {
      setUploadError("");
      setActionError("");
      setIsUploading(true);

      try {
        // Tag every audit-log entry from this upload with a single UUID so future
        // CSV-cascade-delete (Phase 3 follow-up) can group them.
        const csvUploadId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Identity-merge incoming rows with stored rows on the server (which can
        // hash). The server collapses re-imported transactions onto their existing
        // copy, persists the merged set, and returns it for matching + the ref.
        const mergeRes = await fetch("/api/reconciliation/csv-rows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountName: selectedAccount, rows: parsedRows, merge: true }),
        });
        if (!mergeRes.ok) {
          const err = await mergeRes.json().catch(() => ({ error: mergeRes.statusText }));
          throw new Error(err.error || `Failed to merge CSV rows (${mergeRes.status})`);
        }
        const mergeData = (await mergeRes.json()) as { rows?: string[][] };
        const mergedCsv = Array.isArray(mergeData.rows) ? mergeData.rows : [];
        statementCsvRowsByAccountRef.current = {
          ...statementCsvRowsByAccountRef.current,
          [selectedAccount]: mergedCsv,
        };

        const [
          sheetRows,
          sheetTransfers,
          processedHashesRes,
          dismissalsRes,
          userDismissalsRes,
          claimsRes,
          transferClaimsRes,
        ] = await Promise.all([
          getExpenses(),
          getTransfers(),
          fetch("/api/reconciliation/processed", { cache: "no-store" }),
          fetch("/api/reconciliation/dismissals", { cache: "no-store" }),
          fetch("/api/reconciliation/user-dismissals", { cache: "no-store" }),
          fetch("/api/reconciliation/claims", { cache: "no-store" }),
          fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
        ]);
        if (!processedHashesRes.ok) {
          const err = await processedHashesRes.json().catch(() => ({ error: processedHashesRes.statusText }));
          throw new Error(err.error || "Failed to load processed hashes.");
        }
        if (!dismissalsRes.ok) {
          const err = await dismissalsRes.json().catch(() => ({ error: dismissalsRes.statusText }));
          throw new Error(err.error || "Failed to load dismissals.");
        }
        if (!userDismissalsRes.ok) {
          const err = await userDismissalsRes.json().catch(() => ({ error: userDismissalsRes.statusText }));
          throw new Error(err.error || "Failed to load user dismissals.");
        }
        if (!claimsRes.ok) {
          const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
          throw new Error(err.error || "Failed to load claimed sheet rows.");
        }
        if (!transferClaimsRes.ok) {
          const err = await transferClaimsRes.json().catch(() => ({ error: transferClaimsRes.statusText }));
          throw new Error(err.error || "Failed to load transfer claims.");
        }
        const processedHashesData = (await processedHashesRes.json()) as { hashes?: string[] };
        const processedHashes = processedHashesData.hashes ?? [];
        const dismissalsData = (await dismissalsRes.json()) as {
          dismissals?: Array<{ hash: string; accountName: string; note: string }>;
        };
        const dismissalMap: Record<string, string> = {};
        for (const d of dismissalsData.dismissals ?? []) {
          dismissalMap[`${d.accountName}|${d.hash}`] = d.note;
        }
        setDismissalNotesById(dismissalMap);
        const userDismissalsData = (await userDismissalsRes.json()) as {
          dismissedKeys?: string[];
          dismissals?: Array<{ sheetName: string; sheetRowId: string; note: string }>;
        };
        setUserDismissedRowKeys(
          new Set<string>((userDismissalsData.dismissedKeys ?? []).map((k) => String(k))),
        );
        const userNoteMap: Record<string, string> = {};
        for (const d of userDismissalsData.dismissals ?? []) {
          userNoteMap[claimKey(d.sheetName, d.sheetRowId)] = d.note;
        }
        setUserDismissalNotesByEntryId(userNoteMap);
        const claimsData = (await claimsRes.json()) as {
          claimedRowIds?: string[];
          claims?: Array<{ bankHash?: string }>;
        };
        const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));
        const transferClaimsData = (await transferClaimsRes.json()) as {
          statusByRowId?: TransferClaimStatusByRowId;
          claims?: Array<{ bankHash?: string }>;
        };
        const bankHashSetUpload = new Set<string>();
        for (const c of claimsData.claims ?? []) {
          if (c.bankHash) bankHashSetUpload.add(String(c.bankHash));
        }
        for (const c of transferClaimsData.claims ?? []) {
          if (c.bankHash) bankHashSetUpload.add(String(c.bankHash));
        }
        setSheetExpenses(sheetRows);
        setSheetTransfers(sheetTransfers);
        setClaimedRowKeys(claimedRows);
        setBankHashesWithNeonClaim(bankHashSetUpload);
        setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});

        const res = await fetch("/api/reconciliation/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountName: selectedAccount,
            rows: mergedCsv,
            sheetExpenses: sheetRows,
            sheetTransfers,
            processedHashes,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `Failed to match CSV (${res.status})`);
        }
        const data = (await res.json()) as MatchResponse;
        // Debug: log match summary to console so issues can be diagnosed.
        const matchSummary = data.matches.reduce(
          (acc, m) => { acc[m.matchType] = (acc[m.matchType] ?? 0) + 1; return acc; },
          {} as Record<string, number>,
        );
        console.debug(
          `[reconcile] CSV upload for ${selectedAccount}: ${data.bankTransactions.length} bank txns,`,
          `${data.matches.length} matches:`, matchSummary,
        );
        if (data.bankTransactions.length === 0) {
          setUploadError(
            `No transactions were parsed from this file. ` +
            `Make sure you selected the correct account (currently "${selectedAccount}") ` +
            `or that the CSV is in the correct format.`,
          );
        }
        const autoApprovable = data.matches.filter(
          (match) =>
            match.matchType === "exact_match" &&
            hasLinkedUserInputtedEntry(match) &&
            // Skip rows restored from existing claim links — already claimed.
            !bankHashSetUpload.has(match.bankTransaction.hash),
        );
        const autoApprovedHashes: string[] = [];
        const autoClaimedHashes: string[] = [];
        const autoClaimedRowKeys: string[] = [];
        const autoApprovalErrors: string[] = [];
        await Promise.all(
          autoApprovable.map(async (match) => {
            try {
              const claimedKey = await persistAutoClaim(match, { csvUploadId });
              autoApprovedHashes.push(match.bankTransaction.hash);
              if (claimedKey) {
                autoClaimedHashes.push(match.bankTransaction.hash);
                autoClaimedRowKeys.push(claimedKey);
              }
            } catch (err) {
              autoApprovalErrors.push(
                err instanceof Error
                  ? err.message
                  : `Failed to auto-approve ${match.bankTransaction.description || "transaction"}.`,
              );
            }
          }),
        );

        setMatchesByAccount((prev) =>
          mergeWellsFargoBucketIntoChecking({
            ...prev,
            [selectedAccount]: mergeMatchArrays(prev[selectedAccount], data.matches),
          }),
        );
        // Persist match results to Neon. CSV rows were already stored by the
        // server-side merge above.
        const neonErrors: string[] = [];
        try {
          await saveMatchCacheToNeon(selectedAccount, data.matches, true);
        } catch (e) {
          neonErrors.push(`match-cache: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (neonErrors.length > 0) {
          setUploadError(`Data is shown but failed to save to cloud: ${neonErrors.join("; ")}`);
        }

        if (autoApprovedHashes.length > 0) {
          setProcessedHashes((prev) => {
            const next = new Set(prev);
            autoApprovedHashes.forEach((hash) => next.add(hash));
            return next;
          });
        }
        if (autoClaimedHashes.length > 0) {
          setBankHashesWithNeonClaim((prev) => {
            const next = new Set(prev);
            autoClaimedHashes.forEach((hash) => next.add(hash));
            return next;
          });
        }
        if (autoClaimedRowKeys.length > 0) {
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            autoClaimedRowKeys.forEach((key) => next.add(key));
            return next;
          });
        }
        if (autoApprovalErrors.length > 0) {
          setActionError(autoApprovalErrors[0]);
        }
        const uploadedFileName = file.name.trim();
        if (uploadedFileName) {
          await fetch("/api/reconciliation/uploaded-files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountName: selectedAccount,
              fileName: uploadedFileName,
              bankHashes: data.bankTransactions.map((tx) => tx.hash),
            }),
          });
          setUploadedFilesByAccount((prev) => {
            const existing = prev[selectedAccount] ?? [];
            if (existing.includes(uploadedFileName)) return prev;
            return {
              ...prev,
              [selectedAccount]: [...existing, uploadedFileName],
            };
          });
        }
        setActiveTab(selectedAccount);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setIsUploading(false);
      }
    },
    [persistAutoClaim, selectedAccount],
  );

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setUploadError("");
      if (!selectedAccount) {
        setUploadError("Select an account before uploading a statement.");
        return;
      }
      let parsedRows: string[][];
      try {
        parsedRows = await parseCsvFile(file);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Failed to parse CSV.");
        return;
      }
      if (parsedRows.length === 0) {
        setUploadError("CSV file has no data rows.");
        return;
      }
      // First upload for an account with no saved/built-in parser: ask the user to
      // map the columns before we touch storage. Avoids importing garbage rows.
      if (!accountHasConfiguredParser(selectedAccount)) {
        setCsvMappingModal({ open: true, file, rows: parsedRows, saving: false, error: "" });
        return;
      }
      await runUploadPipeline(file, parsedRows);
    },
    [selectedAccount, accountHasConfiguredParser, runUploadPipeline],
  );

  const handleSaveCsvMapping = useCallback(
    async (format: CsvFormat) => {
      const account = accounts.find((a) => a.name === selectedAccount);
      if (!account) {
        setCsvMappingModal((prev) => ({ ...prev, error: "Account not found." }));
        return;
      }
      setCsvMappingModal((prev) => ({ ...prev, saving: true, error: "" }));
      try {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: account.id,
            name: account.name,
            type: account.type,
            openingBalance: account.openingBalance,
            openingBalanceDate: account.openingBalanceDate,
            includeInReconcile: account.includeInReconcile,
            csvFormat: { ...format, configured: true },
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || "Failed to save column mapping");
        }
        await refreshAccounts();
        const pendingFile = csvMappingModal.file;
        const pendingRows = csvMappingModal.rows;
        setCsvMappingModal({ open: false, file: null, rows: [], saving: false, error: "" });
        if (pendingFile && pendingRows.length > 0) {
          await runUploadPipeline(pendingFile, pendingRows);
        }
      } catch (err) {
        setCsvMappingModal((prev) => ({
          ...prev,
          saving: false,
          error: err instanceof Error ? err.message : "Failed to save column mapping",
        }));
      }
    },
    [accounts, selectedAccount, refreshAccounts, runUploadPipeline, csvMappingModal],
  );

  const openCsvMappingModalManually = useCallback(() => {
    const storedRows = statementCsvRowsByAccountRef.current[selectedAccount] ?? [];
    if (storedRows.length === 0) {
      setUploadError(
        "Drop a CSV file first — then you can map its columns (or re-map them here once a file is uploaded).",
      );
      return;
    }
    setCsvMappingModal({ open: true, file: null, rows: storedRows, saving: false, error: "" });
  }, [selectedAccount]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    // Accept CSV regardless of MIME type — Windows often reports text/plain or
    // application/vnd.ms-excel for .csv files, which would silently reject them.
    accept: {
      "text/csv": [".csv"],
      "text/plain": [".csv"],
      "application/vnd.ms-excel": [".csv"],
      "application/csv": [".csv"],
    },
    onDropRejected: (rejections) => {
      const firstName = rejections[0]?.file?.name ?? "file";
      setUploadError(`"${firstName}" was rejected — make sure it is a .csv file.`);
    },
  });

  const activeReviewRows = (statementReviewRowsByAccount[activeTab] ?? []).filter(
    (row) => row.bankTransaction.accountName === activeTab,
  );
  const activeAutoMatchedRows = (statementAutoMatchedRowsByAccount[activeTab] ?? []).filter(
    (row) => row.bankTransaction.accountName === activeTab,
  );
  const activeCompletedRows = (statementCompletedRowsByAccount[activeTab] ?? []).filter(
    (row) => row.bankTransaction.accountName === activeTab,
  );
  const activeMatchedRowsAll = sortByNewestDate(
    [...activeAutoMatchedRows, ...activeCompletedRows],
    (row) => row.bankTransaction.date,
  );
  const activeUserLinkedMatchedRows = activeMatchedRowsAll.filter((m) =>
    hasLinkedOrClaimedEntry(m, bankHashesWithNeonClaim),
  );
  const activeStatementClosedOnlyRows = activeMatchedRowsAll.filter(
    (m) => !hasLinkedOrClaimedEntry(m, bankHashesWithNeonClaim),
  );
  const selectedAccountUploadedFiles = uploadedFilesByAccount[selectedAccount] ?? [];

  if (neonStateLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
          <span className="ml-3 text-gray-400 text-lg">Loading reconciliation data…</span>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Reconcile</h1>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              type="button"
              onClick={openResetReconcileModal}
              className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-300 text-sm hover:text-red-200 hover:bg-red-500/10 transition-colors"
            >
              Clear reconciliation data
            </button>
            <button
              type="button"
              onClick={openMemoryModal}
              className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
            >
              Memory
            </button>
            <button
              type="button"
              onClick={openActivityModal}
              className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
            >
              Activity
            </button>
            <button
              type="button"
              onClick={openAnchorModal}
              className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
            >
              Set Statement Ending Balance
            </button>
            <label className="text-sm text-gray-300">Account</label>
            <GlassDropdown
              value={viewMode === "home" ? ALL_ACCOUNTS_OPTION : selectedAccount}
              onChange={(nextValue) => {
                if (nextValue === ALL_ACCOUNTS_OPTION) {
                  setViewMode("home");
                  history.replaceState(null, "", window.location.pathname);
                  return;
                }
                const account = nextValue as AccountOption;
                setSelectedAccount(account);
                setActiveTab(account);
                setViewMode("accountDetail");
                history.replaceState(null, "", `${window.location.pathname}?account=${encodeURIComponent(account)}`);
              }}
              options={ACCOUNT_DROPDOWN_OPTIONS}
              className="min-w-[10rem]"
              aria-label="Account"
            />
          </div>
        </div>

        {viewMode === "accountDetail" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div
              {...getRootProps()}
              className={`rounded-xl border border-dashed p-6 text-center cursor-pointer transition-colors ${
                isDragActive
                  ? "border-accent bg-accent/10"
                  : "border-charcoal-dark bg-[#252525] hover:border-accent/70 hover:bg-[#2a2a2a]"
              }`}
            >
              <input {...getInputProps()} />
              <Upload className="mx-auto mb-2 text-gray-400" />
              <p className="text-gray-200 text-sm">
                {isDragActive ? "Drop the CSV here..." : "Drop a CSV here, or click to upload"}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Account profile: <span className="text-gray-300">{selectedAccount}</span>
              </p>
              {accountHasConfiguredParser(selectedAccount) ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openCsvMappingModalManually();
                  }}
                  className="mt-2 text-xs text-gray-400 underline hover:text-accent"
                >
                  Re-configure CSV columns
                </button>
              ) : (
                <p className="text-xs text-yellow-300/90 mt-1">
                  No CSV column mapping yet — dropping a file will let you map its columns first.
                </p>
              )}
              {isUploading && (
                <div className="mt-2 inline-flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing...
                </div>
              )}
            </div>
            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-white font-semibold">Files</h2>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    title="Re-match all uploaded statements against your current Google Sheet. Links bank lines to expenses you've added since uploading; exact matches move to Matched, the rest become suggested matches you can bulk-approve."
                    onClick={() => void handleRematchFromSheet()}
                    disabled={rematching}
                    className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                  >
                    {rematching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Re-match from sheet
                  </button>
                  <button
                    type="button"
                    title="Remove redundant copies of transactions that are already matched or processed (left behind by re-importing overlapping statements). Your matches are not affected."
                    onClick={() => void handleRemoveDuplicateRows(selectedAccount)}
                    disabled={removingDuplicates}
                    className="flex items-center gap-1.5 rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-2.5 py-1 text-xs text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-50"
                  >
                    {removingDuplicates && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Remove duplicate rows
                  </button>
                </div>
              </div>
              <div className="p-3 text-sm">
                {selectedAccountUploadedFiles.length === 0 ? (
                  <p className="text-gray-400">No files uploaded for this account yet.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedAccountUploadedFiles.map((fileName) => (
                      <div
                        key={fileName}
                        className="flex items-center gap-2 rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        title={fileName}
                      >
                        <span className="flex-1 text-gray-200 truncate">{fileName}</span>
                        <button
                          type="button"
                          title="Clear all reconciliation data for this file"
                          onClick={() => void handleClearFile(selectedAccount, fileName)}
                          className="flex-shrink-0 text-gray-500 hover:text-red-400 transition-colors"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {(uploadError || actionError) && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {uploadError || actionError}
          </div>
        )}

        {viewMode === "home" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-4 min-w-0">
            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-white font-semibold">User-inputted: Unmatched / Questionable</h2>
                  <span className="text-xs text-gray-300">{homeFilteredIncompleteRows.length}</span>
                </div>
                <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:items-end">
                  <div className="flex flex-1 min-w-[200px] items-center gap-2">
                    <Search className="w-4 h-4 text-gray-500 shrink-0" aria-hidden />
                    <label htmlFor="home-reconcile-search" className="sr-only">
                      Search transactions
                    </label>
                    <input
                      id="home-reconcile-search"
                      type="search"
                      value={homeSearchQuery}
                      onChange={(e) => setHomeSearchQuery(e.target.value)}
                      placeholder="Search incomplete & matched lists (user text, bank description, account…)"
                      className="w-full px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-gray-500 shrink-0" aria-hidden />
                    <label htmlFor="home-account-filter" className="text-xs text-gray-400 whitespace-nowrap">
                      Account
                    </label>
                    <GlassDropdown
                      id="home-account-filter"
                      value={homeAccountFilter}
                      onChange={(v) =>
                        setHomeAccountFilter(v as AccountOption | typeof ALL_ACCOUNTS_OPTION)
                      }
                      options={ACCOUNT_DROPDOWN_OPTIONS}
                      className="min-w-[10rem]"
                      aria-label="Filter by account"
                    />
                  </div>
                </div>
              </div>
              <div className="p-3 text-sm">
                {userInputtedReviewRows.length === 0 ? (
                  <p className="text-gray-400">No unmatched or questionable user-inputted transactions.</p>
                ) : homeFilteredIncompleteRows.length === 0 ? (
                  <p className="text-gray-400">No rows match your search or account filter.</p>
                ) : (
                  <div className="space-y-2">
                    {homeFilteredIncompleteRows.map(({ entry, suggestedBank }, index) => {
                      const match = suggestedBank;
                      const tx = match?.bankTransaction;
                      const id = tx ? idForTx(tx) : `no-bank:${entry.id}`;
                      const isTransferCandidate = Boolean(
                        match &&
                          (match.matchType === "transfer" ||
                            match.matchType === "questionable_match_fuzzy" ||
                            match.matchType === "suggested_match") &&
                          Boolean(match.matchedSheetTransfer?.transferRowId),
                      );
                      return (
                        <div
                          key={`${entry.id}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                User-inputted
                              </p>
                              {entry.source === "Expenses" ? (
                                <>
                                  <p className="text-yellow-300 text-sm truncate">{entry.title}</p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {entry.subtitle} • {fmtMoney(entry.amount)}
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-green-300 text-sm truncate">{entry.title}</p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {entry.subtitle} • {fmtMoney(entry.amount)}
                                  </p>
                                </>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              {tx ? (
                                <>
                                  <p className="text-gray-200 font-medium truncate">{tx.description || "—"}</p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">
                                  No suggested statement line yet. Use Claim to pick a statement transaction.
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => match && handleApprove(match, entry)}
                                disabled={!match || processingId === id}
                                className="p-1.5 rounded-md text-green-300 hover:text-green-200 hover:bg-green-500/10 disabled:opacity-60 transition-colors"
                                aria-label={isTransferCandidate ? "Claim transfer leg" : "Approve match"}
                                title={isTransferCandidate ? "Claim transfer leg" : "Approve and mark processed"}
                              >
                                {match && processingId === id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4" />
                                )}
                              </button>
                              {match && (
                                <button
                                  type="button"
                                  onClick={() => openDismissModal(match)}
                                  className="p-1.5 rounded-md text-amber-300/90 hover:text-amber-200 hover:bg-amber-500/10 transition-colors"
                                  aria-label="Dismiss statement line with note"
                                  title="Dismiss statement line (bank) with note"
                                >
                                  <Ban className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => openUserDismissModal(entry)}
                                disabled={!parseSheetDismissKeyFromEntryId(entry.id)}
                                className="p-1.5 rounded-md text-red-300 hover:text-red-200 hover:bg-red-500/10 disabled:opacity-60 transition-colors"
                                aria-label="Dismiss user-inputted row with note"
                                title="Dismiss user-inputted row with note"
                              >
                                <X className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditEntryModal(entry)}
                                disabled={!rowIdFromEntryId(entry.id)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-60 transition-colors"
                                aria-label="Edit date"
                                title="Edit transaction date"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => match && openQuickAdd(match)}
                                disabled={!match || Boolean(match.matchedSheetTransfer)}
                                className="p-1.5 rounded-md text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 disabled:opacity-60 transition-colors"
                                aria-label="Quick add"
                                title="Quick add to sheet"
                              >
                                <PlusCircle className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openUserStatementClaimModal(entry)}
                                className="px-2 py-1 rounded-md text-[11px] text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 transition-colors"
                                aria-label="Claim statement line"
                                title="Pick a statement line to link"
                              >
                                Claim
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">User-inputted: Matched</h2>
                <span className="text-xs text-gray-300">{homeFilteredMatchedRows.length}</span>
              </div>
              <div className="p-3 text-sm">
                <p className="text-xs text-gray-500 mb-3">
                  When a suggested row has a sheet Row ID, the checkmark saves a real Neon link between that expense
                  or transfer and the bank line (same as Claim). If there is no Row ID, the checkmark only marks the
                  statement processed—see{" "}
                  <span className="text-gray-400">Statement: closed without sheet row</span>. Use{" "}
                  <span className="text-gray-400">Disconnect</span> to undo a link and match again.
                </p>
                {allHomeUserLinkedMatchedMatches.length === 0 ? (
                  <p className="text-gray-400">No sheet-linked matches yet.</p>
                ) : homeFilteredMatchedRows.length === 0 ? (
                  <p className="text-gray-400">No rows match your search or account filter.</p>
                ) : (
                  <div className="space-y-2">
                    {homeFilteredMatchedRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const rowId = idForTx(tx);
                      const dismissalNote = dismissalNotesById[rowId];
                      return (
                        <div
                          key={`${rowId}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                User-inputted Entry
                              </p>
                              {dismissalNote ? (
                                <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                  Dismissed: {dismissalNote}
                                </p>
                              ) : match.matchedSheetExpense ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {match.matchedSheetExpense.description || "—"}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {(match.matchedSheetExpense.expenseType ?? "—")} •{" "}
                                    {fmtDate(
                                      match.matchedSheetExpense.timestamp ?? match.matchedSheetExpense.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetExpense.amount)}
                                    {match.matchedSheetExpense.account
                                      ? ` • ${match.matchedSheetExpense.account}`
                                      : ""}
                                  </p>
                                </>
                              ) : match.matchedSheetTransfer ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {(match.matchedSheetTransfer.transferFrom ?? "—")} →{" "}
                                    {(match.matchedSheetTransfer.transferTo ?? "—")}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    Transfer •{" "}
                                    {fmtDate(
                                      match.matchedSheetTransfer.timestamp ?? match.matchedSheetTransfer.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetTransfer.amount)}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">Processed</p>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="shrink-0 flex items-start pt-0.5">
                              <button
                                type="button"
                                onClick={() => void handleDisconnectSheetLink(match)}
                                disabled={processingId === rowId}
                                className="p-1.5 rounded-md text-orange-300/90 hover:text-orange-200 hover:bg-orange-500/10 disabled:opacity-60 transition-colors"
                                title="Remove sheet link and reopen this bank line"
                                aria-label="Disconnect sheet link"
                              >
                                {processingId === rowId ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Link2Off className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {allHomeStatementClosedOnlyMatches.length > 0 && (
              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
                <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                  <h2 className="text-white font-semibold">Statement: closed without sheet row</h2>
                  <span className="text-xs text-gray-300">{homeFilteredStatementClosedRows.length}</span>
                </div>
                <div className="p-3 text-sm">
                  <p className="text-xs text-gray-500 mb-3">
                    Dismissed notes, or processed on the bank side with a Neon processed hash but no claim link
                    (legacy checkmark). Use{" "}
                    <span className="text-gray-400">Unmark</span> to clear processed and reopen the line for matching.
                  </p>
                  {homeFilteredStatementClosedRows.length === 0 ? (
                    <p className="text-gray-400">No rows match your search or account filter.</p>
                  ) : (
                    <div className="space-y-2">
                      {homeFilteredStatementClosedRows.map((match, index) => {
                        const tx = match.bankTransaction;
                        const rowId = idForTx(tx);
                        const dismissalNote = dismissalNotesById[rowId];
                        return (
                          <div
                            key={`closed-${rowId}-${index}`}
                            className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                          >
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                              <div className="min-w-0">
                                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                  Statement status
                                </p>
                                {dismissalNote ? (
                                  <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                    Dismissed: {dismissalNote}
                                  </p>
                                ) : (
                                  <p className="text-xs text-gray-500">
                                    Processed on statement only — no linked expense or transfer row in the matcher.
                                  </p>
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                  Bank transaction
                                </p>
                                <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                                </p>
                              </div>
                              <div className="shrink-0 flex items-start pt-0.5">
                                <button
                                  type="button"
                                  onClick={() => void handleDisconnectSheetLink(match)}
                                  disabled={processingId === rowId}
                                  className="p-1.5 rounded-md text-orange-300/90 hover:text-orange-200 hover:bg-orange-500/10 disabled:opacity-60 transition-colors"
                                  title="Unmark processed, remove any claim link, reopen for matching"
                                  aria-label="Unmark processed and reopen"
                                >
                                  {processingId === rowId ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Link2Off className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            )}

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">User-inputted: Dismissed</h2>
                <span className="text-xs text-gray-300">{homeFilteredUserDismissedRows.length}</span>
              </div>
              <div className="p-3 text-sm">
                {userDismissedRowKeys.size === 0 ? (
                  <p className="text-gray-400">No user-inputted rows dismissed yet.</p>
                ) : homeFilteredUserDismissedRows.length === 0 ? (
                  <p className="text-gray-400">No rows match your search or account filter.</p>
                ) : (
                  <div className="space-y-2">
                    {homeFilteredUserDismissedRows.map((entry, index) => (
                      <div
                        key={`${entry.id}-${index}`}
                        className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                      >
                        <div className="grid gap-3 md:grid-cols-2 items-start">
                          <div className="min-w-0">
                            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                              User-inputted
                            </p>
                            {entry.source === "Expenses" ? (
                              <>
                                <p className="text-yellow-300 text-sm truncate">{entry.title}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {entry.subtitle} • {fmtMoney(entry.amount)}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="text-green-300 text-sm truncate">{entry.title}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {entry.subtitle} • {fmtMoney(entry.amount)}
                                </p>
                              </>
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                              Note
                            </p>
                            <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                              {userDismissalNotesByEntryId[entry.id] ?? "—"}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
            </div>

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Statement Accounts</h2>
                <span className="text-xs text-gray-300">
                  {tabAccounts.reduce(
                    (sum, account) => sum + (statementReviewRowsByAccount[account]?.length ?? 0),
                    0,
                  )}{" "}
                  to reconcile
                </span>
              </div>
              <div className="p-3 text-sm space-y-3">
                {tabAccounts.map((account) => {
                  const reviewRows = statementReviewRowsByAccount[account] ?? [];
                  const hasParser = accountHasConfiguredParser(account);
                  return (
                    <div
                      key={account}
                      className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-gray-100 font-medium">{account}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab(account);
                            if (ACCOUNT_OPTIONS.includes(account as AccountOption)) {
                              setSelectedAccount(account as AccountOption);
                            }
                            setViewMode("accountDetail");
                            history.replaceState(null, "", `${window.location.pathname}?account=${encodeURIComponent(account)}`);
                          }}
                          className="px-2.5 py-1 rounded-md text-xs text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
                        >
                          See all transactions
                        </button>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">
                        Unmatched / suggested: {reviewRows.length}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        ) : (
          <>
            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">{activeTab}: Unmatched / Suggested</h2>
                <span className="text-xs text-gray-300">{activeReviewRows.length}</span>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("home");
                    history.replaceState(null, "", window.location.pathname);
                  }}
                  className="px-2.5 py-1 rounded-md text-xs text-gray-300 hover:text-white hover:bg-[#2c2c2c] transition-colors"
                >
                  Back to home
                </button>
              </div>
              <div className="p-3 text-sm">
                {activeReviewRows.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pb-2 mb-2 border-b border-charcoal-dark">
                    {(["all", "high_confidence", "suggested", "transfers"] as BulkFilter[]).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setBulkFilter(f)}
                        className={`px-2.5 py-1 rounded-full text-[11px] uppercase tracking-wide transition-colors ${
                          bulkFilter === f
                            ? "bg-accent text-white"
                            : "bg-[#252525] border border-charcoal-dark text-gray-400 hover:text-white hover:bg-[#2d2d2d]"
                        }`}
                      >
                        {f === "all"
                          ? "All"
                          : f === "high_confidence"
                            ? "High confidence"
                            : f === "suggested"
                              ? "Suggested"
                              : "Transfers"}
                      </button>
                    ))}
                    <div className="flex-1" />
                    {(() => {
                      const visibleApprovable = activeReviewRows
                        .filter((m) => filterMatchForBulk(m, bulkFilter))
                        .filter((m) => isBulkApprovableMatch(m));
                      if (visibleApprovable.length === 0) return null;
                      const allSelected = visibleApprovable.every((m) =>
                        bulkSelected.has(idForTx(m.bankTransaction)),
                      );
                      const someSelected = visibleApprovable.some((m) =>
                        bulkSelected.has(idForTx(m.bankTransaction)),
                      );
                      return (
                        <label className="inline-flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = !allSelected && someSelected;
                            }}
                            onChange={() => {
                              setBulkSelected((prev) => {
                                const next = new Set(prev);
                                if (allSelected) {
                                  for (const m of visibleApprovable) next.delete(idForTx(m.bankTransaction));
                                } else {
                                  for (const m of visibleApprovable) next.add(idForTx(m.bankTransaction));
                                }
                                return next;
                              });
                            }}
                            className="accent-accent"
                          />
                          Select all visible ({visibleApprovable.length})
                        </label>
                      );
                    })()}
                    {bulkSelected.size > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const selectedMatches = activeReviewRows.filter(
                            (m) => bulkSelected.has(idForTx(m.bankTransaction)) && isBulkApprovableMatch(m),
                          );
                          void handleBulkApprove(selectedMatches);
                        }}
                        disabled={bulkApproving}
                        className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-dark disabled:opacity-50 inline-flex items-center gap-2"
                      >
                        {bulkApproving ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Approving {bulkSelected.size}…
                          </>
                        ) : (
                          <>Approve {bulkSelected.size} selected</>
                        )}
                      </button>
                    )}
                  </div>
                )}
                {bulkError && <p className="text-amber-300 text-xs mb-2">{bulkError}</p>}
                {activeReviewRows.length === 0 ? (
                  <div>
                    <p className="text-gray-400">No rows requiring manual review for this account.</p>
                    {(activeUserLinkedMatchedRows.length > 0 || activeStatementClosedOnlyRows.length > 0) && (
                      <div className="mt-3 rounded-lg border border-charcoal-dark bg-[#2a2a2a] px-4 py-3 flex items-center justify-between gap-3">
                        <p className="text-sm text-gray-300">
                          <span className="text-green-400 font-medium">
                            {activeUserLinkedMatchedRows.length + activeStatementClosedOnlyRows.length}
                          </span>{" "}
                          transaction{activeUserLinkedMatchedRows.length + activeStatementClosedOnlyRows.length === 1 ? "" : "s"} already reconciled.
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            matchedSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                          }
                          className="px-3 py-1.5 rounded-lg bg-accent/20 border border-accent/40 text-accent text-xs font-medium hover:bg-accent/30 transition-colors shrink-0"
                        >
                          View matched ↓
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeReviewRows.filter((m) => filterMatchForBulk(m, bulkFilter)).map((match, index) => {
                      const tx = match.bankTransaction;
                      const id = idForTx(tx);
                      const isTransferCandidate =
                        (match.matchType === "transfer" || match.matchType === "questionable_match_fuzzy" || match.matchType === "suggested_match") &&
                        Boolean(match.matchedSheetTransfer?.transferRowId);
                      const canBulk = isBulkApprovableMatch(match);
                      const isChecked = bulkSelected.has(id);
                      return (
                        <div
                          key={`${id}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="flex items-start gap-2">
                            <div className="pt-1.5 shrink-0 w-5 flex justify-center">
                              {canBulk ? (
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setBulkSelected((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(id)) next.delete(id);
                                      else next.add(id);
                                      return next;
                                    });
                                  }}
                                  className="accent-accent"
                                  aria-label="Select for bulk approve"
                                />
                              ) : null}
                            </div>
                            <div className="flex-1 min-w-0">
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 font-medium truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Possible Sheet Match
                              </p>
                              {(match.matchType === "questionable_match_fuzzy" || match.matchType === "suggested_match") && match.matchedSheetExpense ? (
                                <>
                                  <p className={`text-sm truncate ${match.matchType === "suggested_match" ? "text-blue-300" : "text-yellow-300"}`}>
                                    {match.matchedSheetExpense.description || "—"}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {(match.matchedSheetExpense.expenseType ?? "—")} •{" "}
                                    {fmtDate(match.matchedSheetExpense.timestamp ?? match.matchedSheetExpense.date)} •{" "}
                                    {fmtMoney(match.matchedSheetExpense.amount)}
                                    {match.matchedSheetExpense.account
                                      ? ` • ${match.matchedSheetExpense.account}`
                                      : ""}
                                  </p>
                                  {match.matchType === "suggested_match" && (
                                    <p className="text-[11px] text-blue-400/70 mt-0.5">
                                      Suggested — approve to confirm
                                    </p>
                                  )}
                                </>
                              ) : (match.matchType === "questionable_match_fuzzy" ||
                                  match.matchType === "suggested_match" ||
                                  match.matchType === "transfer") &&
                                match.matchedSheetTransfer ? (
                                <>
                                  <p
                                    className={`text-sm truncate ${
                                      match.matchType === "transfer" ? "text-green-300" : match.matchType === "suggested_match" ? "text-blue-300" : "text-yellow-300"
                                    }`}
                                  >
                                    {(match.matchedSheetTransfer.transferFrom ?? "—")} →{" "}
                                    {(match.matchedSheetTransfer.transferTo ?? "—")}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    Transfer •{" "}
                                    {fmtDate(
                                      match.matchedSheetTransfer.timestamp ??
                                        match.matchedSheetTransfer.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetTransfer.amount)}
                                  </p>
                                  <p className="text-[11px] text-gray-500 mt-0.5">
                                    Transfer Row ID: {match.matchedSheetTransfer.transferRowId ?? "missing"}
                                  </p>
                                  {match.matchType === "suggested_match" && (
                                    <p className="text-[11px] text-blue-400/70 mt-0.5">
                                      Suggested — approve to confirm
                                    </p>
                                  )}
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">No candidate match</p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleApprove(match)}
                                disabled={processingId === id}
                                className="p-1.5 rounded-md text-green-300 hover:text-green-200 hover:bg-green-500/10 disabled:opacity-60 transition-colors"
                                aria-label={isTransferCandidate ? "Claim transfer leg" : "Approve match"}
                                title={isTransferCandidate ? "Claim transfer leg" : "Approve and mark processed"}
                              >
                                {processingId === id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => openDismissModal(match)}
                                className="p-1.5 rounded-md text-red-300 hover:text-red-200 hover:bg-red-500/10 transition-colors"
                                aria-label="Dismiss with note"
                                title="Dismiss with note"
                              >
                                <X className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openQuickAdd(match)}
                                disabled={Boolean(match.matchedSheetTransfer)}
                                className="p-1.5 rounded-md text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
                                aria-label="Quick add"
                                title="Quick add to sheet"
                              >
                                <PlusCircle className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openSplitModal(match)}
                                disabled={Boolean(match.matchedSheetTransfer)}
                                className="px-2 py-1 rounded-md text-[11px] text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 transition-colors"
                                aria-label="Claim existing rows"
                                title="Claim existing unmatched sheet rows"
                              >
                                Claim
                              </button>
                            </div>
                          </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section ref={matchedSectionRef} className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">{activeTab}: Matched to sheet</h2>
                <span className="text-xs text-gray-300">{activeUserLinkedMatchedRows.length}</span>
              </div>
              <div className="p-3 text-sm">
                <p className="text-xs text-gray-500 mb-3">
                  Checkmark with a sheet Row ID saves the Neon claim link.{" "}
                  <span className="text-gray-400">Disconnect</span> removes the link and unmarks processed so you can
                  match again.
                </p>
                {activeUserLinkedMatchedRows.length === 0 ? (
                  <p className="text-gray-400">No rows linked to an expense or transfer for this account yet.</p>
                ) : (
                  <div className="space-y-2">
                    {activeUserLinkedMatchedRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const rowId = idForTx(tx);
                      const dismissalNote = dismissalNotesById[rowId];
                      return (
                        <div
                          key={`${rowId}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                User-inputted Entry
                              </p>
                              {dismissalNote ? (
                                <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                  Dismissed: {dismissalNote}
                                </p>
                              ) : match.matchedSheetExpense ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {match.matchedSheetExpense.description || "—"}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {(match.matchedSheetExpense.expenseType ?? "—")} •{" "}
                                    {fmtDate(
                                      match.matchedSheetExpense.timestamp ?? match.matchedSheetExpense.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetExpense.amount)}
                                  </p>
                                </>
                              ) : match.matchedSheetTransfer ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {(match.matchedSheetTransfer.transferFrom ?? "—")} →{" "}
                                    {(match.matchedSheetTransfer.transferTo ?? "—")}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    Transfer •{" "}
                                    {fmtDate(
                                      match.matchedSheetTransfer.timestamp ?? match.matchedSheetTransfer.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetTransfer.amount)}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">Processed</p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-start pt-0.5">
                              <button
                                type="button"
                                onClick={() => void handleDisconnectSheetLink(match)}
                                disabled={processingId === rowId}
                                className="p-1.5 rounded-md text-orange-300/90 hover:text-orange-200 hover:bg-orange-500/10 disabled:opacity-60 transition-colors"
                                title="Remove sheet link and reopen this bank line"
                                aria-label="Disconnect sheet link"
                              >
                                {processingId === rowId ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Link2Off className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {activeStatementClosedOnlyRows.length > 0 && (
              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
                <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                  <h2 className="text-white font-semibold">{activeTab}: Closed on statement (no sheet link)</h2>
                  <span className="text-xs text-gray-300">{activeStatementClosedOnlyRows.length}</span>
                </div>
                <div className="p-3 text-sm">
                  <p className="text-xs text-gray-500 mb-3">
                    Dismissals or legacy processed-without-claim lines. Use{" "}
                    <span className="text-gray-400">Unmark</span> to clear processed and reopen for matching.
                  </p>
                  <div className="space-y-2">
                    {activeStatementClosedOnlyRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const rowId = idForTx(tx);
                      const dismissalNote = dismissalNotesById[rowId];
                      return (
                        <div
                          key={`acct-closed-${rowId}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Statement status
                              </p>
                              {dismissalNote ? (
                                <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                  Dismissed: {dismissalNote}
                                </p>
                              ) : (
                                <p className="text-xs text-gray-500">
                                  Processed on statement only — no linked sheet row.
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-start pt-0.5">
                              <button
                                type="button"
                                onClick={() => void handleDisconnectSheetLink(match)}
                                disabled={processingId === rowId}
                                className="p-1.5 rounded-md text-orange-300/90 hover:text-orange-200 hover:bg-orange-500/10 disabled:opacity-60 transition-colors"
                                title="Unmark processed, remove any claim link, reopen for matching"
                                aria-label="Unmark processed and reopen"
                              >
                                {processingId === rowId ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Link2Off className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
              <p className="text-xs text-gray-500">
                Matched rows shown since {matchCacheSinceDate}. Pending/unmatched rows are always shown.
              </p>
              <button
                type="button"
                onClick={loadOlderMatches}
                disabled={loadingOlderMatches}
                className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-xs hover:text-white hover:bg-[#2d2d2d] transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                {loadingOlderMatches ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Loading older…
                  </>
                ) : (
                  <>Load older matched rows</>
                )}
              </button>
            </div>

            {activeReviewRows.length > 0 && (
              <p className="text-xs text-gray-500">
                Showing {activeReviewRows.length} unmatched/suggested row
                {activeReviewRows.length === 1 ? "" : "s"} for {activeTab}.
              </p>
            )}
          </>
        )}
      </div>

      {memoryModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeMemoryModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="memory-modal-title"
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <div>
                <h2 id="memory-modal-title" className="text-white font-semibold">Merchant Memory</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Patterns the system remembers. Auto-claim fires after 2+ confirmations.
                </p>
              </div>
              <button
                type="button"
                onClick={closeMemoryModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {memoryModal.error && (
                <p className="text-red-300 text-sm mb-3">{memoryModal.error}</p>
              )}
              {memoryModal.loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-accent" />
                  <span className="ml-2 text-gray-400 text-sm">Loading memory…</span>
                </div>
              ) : memoryModal.entries.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-8">
                  No remembered patterns yet. The system will start learning after you claim recurring transactions.
                </p>
              ) : (
                <div className="space-y-2">
                  {memoryModal.entries.map((entry) => {
                    const key = `${entry.fingerprint}|${entry.bankAccountName}`;
                    const isAutoClaiming = entry.confirmedCount >= 2;
                    const isForgetting = memoryModal.forgettingKey === key;
                    return (
                      <div
                        key={key}
                        className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] uppercase tracking-wide text-gray-500">
                                {entry.bankAccountName}
                              </span>
                              <span
                                className={`text-[10px] uppercase tracking-wide font-semibold ${
                                  isAutoClaiming ? "text-accent" : "text-gray-500"
                                }`}
                              >
                                {entry.confirmedCount}× confirmed
                                {isAutoClaiming ? " • auto-claims" : " • not yet auto"}
                              </span>
                            </div>
                            <p className="text-xs text-gray-300 mt-1 font-mono break-words">{entry.fingerprint}</p>
                            {entry.sheetCategory && (
                              <p className="text-xs text-gray-500 mt-0.5">Category: {entry.sheetCategory}</p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleForgetMemoryEntry(entry)}
                            disabled={isForgetting}
                            className="px-2.5 py-1 rounded-md border border-red-500/40 bg-[#252525] text-red-300 text-xs hover:text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5 shrink-0"
                          >
                            {isForgetting ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Forgetting…
                              </>
                            ) : (
                              <>Forget</>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-4 py-3 bg-[#353535] border-t border-charcoal-dark flex items-center justify-end">
              <button
                type="button"
                onClick={closeMemoryModal}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs hover:bg-accent/80 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {activityModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeActivityModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="activity-modal-title"
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <div>
                <h2 id="activity-modal-title" className="text-white font-semibold">Reconciliation Activity</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Showing actions since {activityModal.since}. Click Undo to reverse a single action.
                </p>
              </div>
              <button
                type="button"
                onClick={closeActivityModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {activityModal.error && (
                <p className="text-red-300 text-sm mb-3">{activityModal.error}</p>
              )}
              {activityModal.loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-accent" />
                  <span className="ml-2 text-gray-400 text-sm">Loading activity…</span>
                </div>
              ) : activityModal.entries.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-8">No activity in this window.</p>
              ) : (
                <div className="space-y-2">
                  {activityModal.entries.map((entry) => {
                    const isReverted = !!entry.revertedAt;
                    const isUndoing = activityModal.undoingId === entry.id;
                    const occurred = new Date(entry.occurredAt);
                    const occurredLabel = Number.isNaN(occurred.getTime())
                      ? entry.occurredAt
                      : occurred.toLocaleString();
                    return (
                      <div
                        key={entry.id}
                        className={`rounded-lg border px-3 py-2 ${
                          isReverted
                            ? "border-charcoal-dark bg-[#2a2a2a] opacity-60"
                            : "border-charcoal-dark bg-[#2c2c2c]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] uppercase tracking-wide text-accent font-semibold">
                                {entry.actionType}
                              </span>
                              <span className="text-[10px] uppercase tracking-wide text-gray-500">
                                {entry.actor}
                              </span>
                              {isReverted && (
                                <span className="text-[10px] uppercase tracking-wide text-amber-300/80">
                                  reverted
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">{occurredLabel}</p>
                            <pre className="text-[11px] text-gray-300 mt-1 whitespace-pre-wrap break-words font-mono">
                              {summarizeActivityPayload(entry.actionType, entry.payload)}
                            </pre>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleUndoActivity(entry)}
                            disabled={isReverted || isUndoing}
                            className="px-2.5 py-1 rounded-md border border-charcoal-dark bg-[#252525] text-gray-200 text-xs hover:text-white hover:bg-[#2d2d2d] transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5 shrink-0"
                          >
                            {isUndoing ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Undoing…
                              </>
                            ) : (
                              <>Undo</>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-4 py-3 bg-[#353535] border-t border-charcoal-dark flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={loadOlderActivity}
                disabled={activityModal.loading}
                className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-xs hover:text-white hover:bg-[#2d2d2d] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Load older activity
              </button>
              <button
                type="button"
                onClick={closeActivityModal}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs hover:bg-accent/80 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {quickAdd.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeQuickAdd}
          role="dialog"
          aria-modal="true"
          aria-labelledby="quick-add-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="quick-add-title" className="text-white font-semibold">Quick Add Transaction</h2>
              <button
                type="button"
                onClick={closeQuickAdd}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Expense Type</label>
                <select
                  value={quickAdd.expenseType}
                  onChange={(e) => setQuickAdd((prev) => ({ ...prev, expenseType: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                >
                  {EXPENSE_TYPE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Amount</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={quickAdd.amount}
                  onChange={(e) => setQuickAdd((prev) => ({ ...prev, amount: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Description</label>
                <input
                  type="text"
                  value={quickAdd.description}
                  onChange={(e) => setQuickAdd((prev) => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>
              {quickAdd.error && <p className="text-xs text-red-400">{quickAdd.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeQuickAdd}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleQuickAddSubmit}
                disabled={quickAdd.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {quickAdd.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {dismissModal.open && dismissModal.match && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeDismissModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dismiss-statement-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="dismiss-statement-title" className="text-white font-semibold">
                Dismiss statement line
              </h2>
              <button
                type="button"
                onClick={closeDismissModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Bank</p>
                <p className="text-gray-100 truncate">
                  {dismissModal.match.bankTransaction.description || "—"}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {dismissModal.match.bankTransaction.accountName} •{" "}
                  {fmtDate(dismissModal.match.bankTransaction.date)} •{" "}
                  {fmtMoney(dismissModal.match.bankTransaction.amount)}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Note (saved to Neon)</label>
                <textarea
                  value={dismissModal.note}
                  onChange={(e) =>
                    setDismissModal((prev) => ({ ...prev, note: e.target.value, error: "" }))
                  }
                  rows={4}
                  placeholder="e.g. Paid for group dinner; reimbursed on Venmo."
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none resize-y min-h-[96px]"
                />
              </div>
              {dismissModal.error && <p className="text-xs text-red-400">{dismissModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDismissModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDismissSubmit()}
                disabled={dismissModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-amber-700/90 text-white hover:bg-amber-700 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {dismissModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save dismissal
              </button>
            </div>
          </div>
        </div>
      )}
      {userDismissModal.open && userDismissModal.entry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeUserDismissModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dismiss-user-sheet-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="dismiss-user-sheet-title" className="text-white font-semibold">
                Dismiss user-inputted row
              </h2>
              <button
                type="button"
                onClick={closeUserDismissModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                  {userDismissModal.entry.source}
                </p>
                <p className="text-gray-100 truncate">{userDismissModal.entry.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {userDismissModal.entry.subtitle} • {fmtMoney(userDismissModal.entry.amount)}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Note (saved to Neon)</label>
                <textarea
                  value={userDismissModal.note}
                  onChange={(e) =>
                    setUserDismissModal((prev) => ({ ...prev, note: e.target.value, error: "" }))
                  }
                  rows={4}
                  placeholder="e.g. Duplicate entry; entered in error."
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none resize-y min-h-[96px]"
                />
              </div>
              {userDismissModal.error && <p className="text-xs text-red-400">{userDismissModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeUserDismissModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleUserDismissSubmit()}
                disabled={userDismissModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-amber-700/90 text-white hover:bg-amber-700 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {userDismissModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save dismissal
              </button>
            </div>
          </div>
        </div>
      )}
      {resetReconcileModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeResetReconcileModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-reconcile-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-red-500/30 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="reset-reconcile-title" className="text-white font-semibold">
                Clear all reconciliation data
              </h2>
              <button
                type="button"
                onClick={closeResetReconcileModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 text-sm text-gray-300">
              <p>
                This removes <span className="text-gray-200">statement match data</span> from this
                browser, and deletes in Neon: processed hashes, claim links, transfer claims,
                dismissal notes (statement and user-inputted sheet rows), and uploaded-file history.
                Your Google Sheet expenses are not changed. Statement ending balances (anchors) are
                kept.
              </p>
              <p className="text-xs text-gray-500">
                Type{" "}
                <code className="text-amber-200/90">{RECONCILIATION_RESET_CONFIRM}</code> to confirm.
              </p>
              <input
                type="text"
                value={resetReconcileModal.confirmText}
                onChange={(e) =>
                  setResetReconcileModal((prev) => ({
                    ...prev,
                    confirmText: e.target.value,
                    error: "",
                  }))
                }
                autoComplete="off"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 outline-none font-mono"
                placeholder={RECONCILIATION_RESET_CONFIRM}
              />
              {resetReconcileModal.error && (
                <p className="text-xs text-red-400">{resetReconcileModal.error}</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeResetReconcileModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleFullReconcileReset()}
                disabled={resetReconcileModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {resetReconcileModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Clear everything
              </button>
            </div>
          </div>
        </div>
      )}
      {splitModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeSplitModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="claim-existing-title"
        >
          <div
            className="w-full max-w-3xl rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="claim-existing-title" className="text-white font-semibold">
                Claim Existing Sheet Rows
              </h2>
              <button
                type="button"
                onClick={closeSplitModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {splitTargetTransaction && (
                <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Selected Transaction</p>
                  <p className="text-gray-100 truncate">{splitTargetTransaction.description || "—"}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {splitTargetTransaction.accountName} • {fmtDate(splitTargetTransaction.date)} •{" "}
                    {fmtMoney(splitTargetTransaction.amount)}
                  </p>
                </div>
              )}
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                Target: <span className="text-white">{fmtMoney(splitTargetAmount)}</span>
                <span className="text-gray-500"> • </span>
                Entered: <span className="text-white">{fmtMoney(splitEnteredAmount)}</span>
                <span className="text-gray-500"> • </span>
                Remaining:{" "}
                <span
                  className={
                    toCents(splitRemainingAmount) === 0
                      ? "text-green-300"
                      : splitRemainingAmount > 0
                        ? "text-yellow-300"
                        : "text-red-300"
                  }
                >
                  {fmtMoney(splitRemainingAmount)}
                </span>
              </div>


              <div>
                <label className="block text-xs text-gray-400 mb-1">Search rows</label>
                <input
                  type="text"
                  value={splitSearchQuery}
                  onChange={(e) => setSplitSearchQuery(e.target.value)}
                  placeholder="Search expenses or transfers (type, description, row ID, date)"
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>

              <div className="max-h-[50vh] overflow-auto rounded-md border border-charcoal-dark bg-charcoal">
                {filteredSplitCandidates.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-400">
                    {splitSearchQuery.trim()
                      ? "No rows match your search."
                      : "No unclaimed sheet rows are available. Expense rows need a Row ID; transfer rows need a Transfer Row ID."}
                  </p>
                ) : (
                  <div className="divide-y divide-charcoal-dark">
                    {filteredSplitCandidates.map((row) => {
                      const selected = splitModal.selectedKeys.includes(row.key);
                      return (
                        <label
                          key={row.key}
                          className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-[#2d2d2d]"
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => handleToggleSplitClaim(row.key)}
                            disabled={splitModal.submitting}
                            className="mt-1"
                          />
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                              {row.sheetName}
                            </p>
                            <p className="text-sm text-gray-200 truncate">
                              {row.expenseType || "—"} • {row.description || "—"}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {fmtMoney(row.amount)}
                              {row.timestamp ? ` • ${fmtDate(row.timestamp)}` : ""}
                              {row.account ? ` • ${row.account}` : ""}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                              {row.sheetName === "Transfers" ? "Transfer Row ID" : "Row ID"}: {row.rowId}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {splitModal.error && <p className="text-xs text-red-400">{splitModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeSplitModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSplitSaveClick}
                disabled={splitModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {splitModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Claim Rows
              </button>
            </div>
          </div>
        </div>
      )}
      {userStatementClaimModal.open && userStatementClaimModal.entry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeUserStatementClaimModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-statement-claim-title"
        >
          <div
            className="w-full max-w-3xl rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between shrink-0">
              <h2 id="user-statement-claim-title" className="text-white font-semibold">
                Link to statement transaction
              </h2>
              <button
                type="button"
                onClick={closeUserStatementClaimModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">User-inputted</p>
                <p className="text-gray-100 truncate">{userStatementClaimModal.entry.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {userStatementClaimModal.entry.source} • {userStatementClaimModal.entry.subtitle} •{" "}
                  {fmtMoney(userStatementClaimModal.entry.amount)}
                </p>
              </div>
              <p className="text-xs text-gray-400">
                Lists unprocessed statement lines (all accounts when Account is All) whose amount matches this
                entry. Search and account filter narrow the list.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-gray-400 mb-1">Search statement lines</label>
                  <input
                    type="search"
                    value={userStatementClaimModal.searchQuery}
                    onChange={(e) =>
                      setUserStatementClaimModal((prev) => ({
                        ...prev,
                        searchQuery: e.target.value,
                        error: "",
                      }))
                    }
                    placeholder="Description, date, account…"
                    className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Filter className="w-4 h-4 text-gray-500" aria-hidden />
                  <label htmlFor="user-claim-account-filter" className="text-xs text-gray-400 whitespace-nowrap">
                    Account
                  </label>
                  <GlassDropdown
                    id="user-claim-account-filter"
                    value={userStatementClaimModal.accountFilter}
                    onChange={(v) =>
                      setUserStatementClaimModal((prev) => ({
                        ...prev,
                        accountFilter: v as AccountOption | typeof ALL_ACCOUNTS_OPTION,
                        error: "",
                      }))
                    }
                    options={ACCOUNT_DROPDOWN_OPTIONS}
                    className="min-w-[10rem]"
                    aria-label="Filter statement lines by account"
                  />
                </div>
              </div>
              <div className="max-h-[40vh] overflow-auto rounded-md border border-charcoal-dark bg-charcoal">
                {userClaimFilteredStatementLines.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-400">
                    No matching statement lines. Upload CSVs or adjust search / account filter.
                  </p>
                ) : (
                  <div className="divide-y divide-charcoal-dark">
                    {userClaimFilteredStatementLines.map((m, idx) => {
                      const tid = idForTx(m.bankTransaction);
                      const selected = userStatementClaimModal.selectedBankRowId === tid;
                      return (
                        <label
                          key={`${tid}-${idx}`}
                          className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-[#2d2d2d]"
                        >
                          <input
                            type="radio"
                            name="user-statement-pick"
                            checked={selected}
                            onChange={() =>
                              setUserStatementClaimModal((prev) => ({
                                ...prev,
                                selectedBankRowId: tid,
                                error: "",
                              }))
                            }
                            disabled={userStatementClaimModal.submitting}
                            className="mt-1"
                          />
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                              {m.bankTransaction.accountName}
                            </p>
                            <p className="text-sm text-gray-200 truncate">
                              {m.bankTransaction.description || "—"}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {fmtDate(m.bankTransaction.date)} • {fmtMoney(m.bankTransaction.amount)}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              {userStatementClaimModal.error && (
                <p className="text-xs text-red-400">{userStatementClaimModal.error}</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={closeUserStatementClaimModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUserStatementClaimSaveClick}
                disabled={userStatementClaimModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {userStatementClaimModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Link statement
              </button>
            </div>
          </div>
        </div>
      )}
      {transferClaimModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeTransferClaimModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="transfer-claim-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="transfer-claim-title" className="text-white font-semibold">
                Claim Transfer Leg
              </h2>
              <button
                type="button"
                onClick={closeTransferClaimModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-300">
                Choose how many bank legs this transfer should require.
              </p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-gray-200">
                  <input
                    type="radio"
                    name="transfer-expected-legs"
                    checked={transferClaimModal.expectedLegs === 2}
                    onChange={() =>
                      setTransferClaimModal((prev) => ({ ...prev, expectedLegs: 2, error: "" }))
                    }
                    disabled={transferClaimModal.submitting}
                  />
                  2-leg transfer (between two bank accounts)
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-200">
                  <input
                    type="radio"
                    name="transfer-expected-legs"
                    checked={transferClaimModal.expectedLegs === 1}
                    onChange={() =>
                      setTransferClaimModal((prev) => ({ ...prev, expectedLegs: 1, error: "" }))
                    }
                    disabled={transferClaimModal.submitting}
                  />
                  1-leg transfer (cash or external movement)
                </label>
              </div>
              {transferClaimModal.error && (
                <p className="text-xs text-red-400">{transferClaimModal.error}</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeTransferClaimModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTransferClaimSubmit}
                disabled={transferClaimModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {transferClaimModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Claim Transfer
              </button>
            </div>
          </div>
        </div>
      )}
      <CsvMappingModal
        open={csvMappingModal.open}
        accountName={selectedAccount}
        sampleRows={csvMappingModal.rows}
        initialFormat={accounts.find((a) => a.name === selectedAccount)?.csvFormat as CsvFormat | undefined}
        saving={csvMappingModal.saving}
        error={csvMappingModal.error}
        onSave={handleSaveCsvMapping}
        onClose={() =>
          setCsvMappingModal({ open: false, file: null, rows: [], saving: false, error: "" })
        }
      />

      {anchorModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeAnchorModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="statement-anchor-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="statement-anchor-title" className="text-white font-semibold">
                Set Statement Ending Balance
              </h2>
              <button
                type="button"
                onClick={closeAnchorModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-300">
                Account: <span className="text-white">{selectedAccount}</span>
              </p>
              {anchorModal.loading ? (
                <div className="inline-flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading current balance...
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Statement Ending Date</label>
                    <input
                      type="date"
                      value={anchorModal.date}
                      onChange={(e) =>
                        setAnchorModal((prev) => ({ ...prev, date: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Confirmed Balance</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={anchorModal.balance}
                      onChange={(e) =>
                        setAnchorModal((prev) => ({ ...prev, balance: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                    />
                  </div>
                </>
              )}
              {anchorModal.error && <p className="text-xs text-red-400">{anchorModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeAnchorModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAnchor}
                disabled={anchorModal.loading || anchorModal.saving}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {anchorModal.saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save Anchor
              </button>
            </div>
          </div>
        </div>
      )}
      {editEntryModal.open && editEntryModal.entry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeEditEntryModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-entry-date-title"
        >
          <div
            className="w-full max-w-sm rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="edit-entry-date-title" className="text-white font-semibold">Edit Transaction Date</h2>
              <button
                type="button"
                onClick={closeEditEntryModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-3 space-y-3">
              <div className="rounded-lg bg-charcoal px-3 py-2 text-sm">
                <p className={editEntryModal.entry.source === "Expenses" ? "text-yellow-300 truncate" : "text-green-300 truncate"}>
                  {editEntryModal.entry.title}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {editEntryModal.entry.subtitle} • {fmtMoney(editEntryModal.entry.amount)}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Date</label>
                <input
                  type="date"
                  value={editEntryModal.date}
                  onChange={(e) => setEditEntryModal((prev) => ({ ...prev, date: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>
              {editEntryModal.error && <p className="text-xs text-red-400">{editEntryModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeEditEntryModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleEditEntrySubmit()}
                disabled={editEntryModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {editEntryModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
