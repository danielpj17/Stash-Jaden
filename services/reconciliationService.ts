import { createHash } from "node:crypto";
import { generateMerchantFingerprint } from "@/lib/merchantFingerprint";

export { generateMerchantFingerprint };

export type BankProfile = {
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex?: number | null;
  creditIndex?: number | null;
};

export const BANK_PROFILES: Record<string, BankProfile> = {
  "Wells Fargo": {
    dateIndex: 0,
    amountIndex: 1,
    descriptionIndex: 4,
  },
  Venmo: {
    dateIndex: 1,
    amountIndex: 7,
    descriptionIndex: 4,
  },
  "Capital One": {
    dateIndex: 0,
    amountIndex: null,
    descriptionIndex: 3,
    debitIndex: 5,
    creditIndex: 6,
  },
  "America First": {
    dateIndex: null,
    amountIndex: null,
    descriptionIndex: null,
  },
  Discover: {
    dateIndex: null,
    amountIndex: null,
    descriptionIndex: null,
  },
};

type ResolvedBankProfile = {
  profile: BankProfile;
  startRowIndex: number;
};

/**
 * Maps a UI account name to the bank profile used to parse its CSV.
 * Shared by the match route and the CSV identity-dedup helper so both resolve
 * the same profile (e.g. "WF Checking" -> "Wells Fargo").
 */
export const PROFILE_BY_ACCOUNT: Record<string, string> = {
  "WF Checking": "Wells Fargo",
  "WF Savings": "Wells Fargo",
  Fidelity: "Fidelity",
  "Venmo - Daniel": "Venmo",
  "Venmo - Katie": "Venmo",
  Venmo: "Venmo",
  "Capital One": "Capital One",
  "America First": "America First",
  Discover: "Discover",
  Schwab: "Charles Schwab",
  Ally: "Ally",
};

export type BankTransaction = {
  accountName: string;
  date: string;
  amount: number;
  description: string;
  hash: string;
  raw?: string[];
};

export type SheetExpenseLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  description?: string;
  expenseType?: string;
  account?: string;
  rowId?: string;
};

export type SheetTransferLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  transferFrom?: string;
  transferTo?: string;
  description?: string;
  transferRowId?: string;
};

type TransferClaimStatus = {
  claimedCount: number;
  expectedLegs: number;
  isComplete: boolean;
  hasPositive: boolean;
  hasNegative: boolean;
};

export type MatchType =
  | "exact_match"
  | "processed"
  | "questionable_match_fuzzy"
  | "suggested_match"
  | "transfer"
  | "unmatched";

export type MatchResult = {
  bankTransaction: BankTransaction;
  matchType: MatchType;
  reason: string;
  matchedSheetExpense?: SheetExpenseLike;
  matchedSheetIndex?: number;
  matchedSheetTransfer?: SheetTransferLike;
  matchedSheetTransferIndex?: number;
  transferCounterparty?: BankTransaction;
  matchedByNeonHash?: boolean;
  matchedByMerchantMemory?: boolean;
  confidenceScore?: number;
  candidateCount?: number;
  isAmbiguousCluster?: boolean;
};

export type MerchantMemoryEntry = {
  fingerprint: string;
  bankAccountName: string;
  confirmedCount: number;
  sheetCategory?: string | null;
  sheetAccount?: string | null;
};


/**
 * Creates a stable transaction hash for deduplication across imports/sync runs.
 * Description and amount are normalized before hashing to reduce formatting noise.
 */
export function generateTransactionHash(
  date: string,
  amount: number,
  description: string,
): string {
  const normalizedDescription = description.trim().toLowerCase();
  const normalizedAmount = Number(amount).toFixed(2);
  const normalizedDate = String(date).trim();
  const payload = `${normalizedDate}|${normalizedAmount}|${normalizedDescription}`;

  return createHash("sha256").update(payload).digest("hex");
}

function cents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

function amountKey(amount: number): number {
  return Math.abs(cents(amount));
}

function normalizeDateOnly(value: string): string {
  const raw = String(value).trim();
  if (!raw) return "";

  // Keep YYYY-MM-DD stable when provided directly.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateDistanceInDays(a: string, b: string): number | null {
  const aKey = normalizeDateOnly(a);
  const bKey = normalizeDateOnly(b);
  if (!aKey || !bKey) return null;

  const aTime = Date.parse(`${aKey}T00:00:00Z`);
  const bTime = Date.parse(`${bKey}T00:00:00Z`);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) return null;

  return Math.abs(Math.round((aTime - bTime) / 86_400_000));
}

function toIndexedMap(rows: SheetExpenseLike[]): Map<string, SheetExpenseLike[]> {
  const indexed = new Map<string, SheetExpenseLike[]>();
  for (const row of rows) {
    const key = `${amountKey(row.amount)}|${normalizeDateOnly(
      row.date ?? row.timestamp ?? "",
    )}`;
    if (!indexed.has(key)) indexed.set(key, []);
    indexed.get(key)?.push(row);
  }
  return indexed;
}

function toAmountOnlyIndex(rows: SheetExpenseLike[]): Map<number, SheetExpenseLike[]> {
  const indexed = new Map<number, SheetExpenseLike[]>();
  for (const row of rows) {
    const key = amountKey(row.amount);
    if (!indexed.has(key)) indexed.set(key, []);
    indexed.get(key)!.push(row);
  }
  return indexed;
}

function scoreCandidate(
  tx: BankTransaction,
  sheet: SheetExpenseLike,
  dayDistance: number | null,
): number {
  let score = 0;
  const days = dayDistance ?? 999;
  if (days <= 0) score += 1.0;
  else if (days <= 1) score += 0.9;
  else if (days <= 3) score += 0.7;
  else if (days <= 7) score += 0.5;
  else if (days <= 14) score += 0.3;
  else if (days <= 31) score += 0.15;
  else score += 0.05;

  score += descriptionSimilarity(tx.description, sheet.description ?? "") * 0.5;

  if (sheet.account && sheet.account === tx.accountName) score += 0.2;
  return score;
}

const CLUSTER_DAY_DISTANCE = 1;
const CLUSTER_DESCRIPTION_SIMILARITY = 0.3;

/**
 * Detect bank txs that are part of an "ambiguous cluster": multiple bank
 * transactions with the same amount, close dates, and similar descriptions
 * (same merchant). These should never be auto-matched — they require manual
 * review to avoid swapping the wrong pairs.
 */
function buildClusterSet(bankTransactions: BankTransaction[]): Set<string> {
  const clusterHashes = new Set<string>();
  for (let i = 0; i < bankTransactions.length; i++) {
    const a = bankTransactions[i];
    for (let j = i + 1; j < bankTransactions.length; j++) {
      const b = bankTransactions[j];
      if (amountKey(a.amount) !== amountKey(b.amount)) continue;
      const dayDist = dateDistanceInDays(a.date, b.date);
      if (dayDist === null || dayDist > CLUSTER_DAY_DISTANCE) continue;
      if (descriptionSimilarity(a.description, b.description) >= CLUSTER_DESCRIPTION_SIMILARITY) {
        clusterHashes.add(a.hash);
        clusterHashes.add(b.hash);
      }
    }
  }
  return clusterHashes;
}

function isProfileConfigured(profile: BankProfile): boolean {
  const hasSingleAmount = profile.amountIndex !== null;
  const hasSplitDebitCredit =
    profile.debitIndex != null && profile.creditIndex != null;
  return (
    profile.dateIndex !== null &&
    (hasSingleAmount || hasSplitDebitCredit) &&
    profile.descriptionIndex !== null
  );
}

function parseBankAmount(rawValue: string): number | null {
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  const isParenthesizedNegative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed.replace(/[,$\s()]/g, "");
  if (!normalized) return null;

  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return null;
  return isParenthesizedNegative ? -Math.abs(numeric) : numeric;
}

function normalizeHeaderCell(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\uFEFF/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isVenmoProfile(accountName: string): boolean {
  return accountName.trim().toLowerCase() === "venmo";
}

function isCapitalOneProfile(accountName: string): boolean {
  return accountName.trim().toLowerCase() === "capital one";
}

function isWellsFargoProfile(accountName: string): boolean {
  return accountName.trim().toLowerCase() === "wells fargo";
}

function resolveVenmoProfile(rows: string[][], fallback: BankProfile): ResolvedBankProfile {
  if (!Array.isArray(rows) || !isProfileConfigured(fallback)) {
    return { profile: fallback, startRowIndex: 0 };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const normalized = row.map((cell) => normalizeHeaderCell(cell));
    const dateIndex = normalized.findIndex(
      (cell) => cell === "datetime" || cell === "date time" || cell === "date",
    );
    const amountIndex = normalized.findIndex(
      (cell) => cell === "amount total" || cell === "total amount" || cell === "amount",
    );
    const descriptionIndex = normalized.findIndex(
      (cell) => cell === "note" || cell === "description" || cell === "details",
    );
    if (dateIndex >= 0 && amountIndex >= 0 && descriptionIndex >= 0) {
      return {
        profile: {
          dateIndex,
          amountIndex,
          descriptionIndex,
        },
        startRowIndex: i + 1,
      };
    }
  }

  return { profile: fallback, startRowIndex: 0 };
}

function resolveCapitalOneProfile(rows: string[][], fallback: BankProfile): ResolvedBankProfile {
  if (!Array.isArray(rows)) {
    return { profile: fallback, startRowIndex: 0 };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const normalized = row.map((cell) => normalizeHeaderCell(cell));
    const dateIndex = normalized.findIndex(
      (cell) =>
        cell === "transaction date" ||
        cell === "transactiondate" ||
        cell === "date",
    );
    const descriptionIndex = normalized.findIndex((cell) => cell === "description");
    const debitIndex = normalized.findIndex((cell) => cell === "debit");
    const creditIndex = normalized.findIndex((cell) => cell === "credit");

    if (dateIndex >= 0 && descriptionIndex >= 0 && debitIndex >= 0 && creditIndex >= 0) {
      return {
        profile: {
          dateIndex,
          amountIndex: null,
          descriptionIndex,
          debitIndex,
          creditIndex,
        },
        startRowIndex: i + 1,
      };
    }
  }

  return { profile: fallback, startRowIndex: 0 };
}


function formatDateKeyFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Wells Fargo often includes "PURCHASE AUTHORIZED ON MM/DD ..." in the description.
 * Use that embedded purchase date (when present) to reduce false fuzzy matches caused by posting-date lag.
 */
function deriveBankTransactionDate(
  accountName: string,
  postedDateRaw: string,
  rawDescription: string,
): string {
  const normalizedAccount = accountName.trim().toLowerCase();
  const isWells = normalizedAccount === "wells fargo";
  if (!isWells) return postedDateRaw;

  const match = rawDescription.match(/purchase\s+authorized\s+on\s+(\d{1,2})\/(\d{1,2})/i);
  if (!match) return postedDateRaw;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return postedDateRaw;

  const posted = new Date(postedDateRaw);
  if (Number.isNaN(posted.getTime())) return postedDateRaw;

  const derived = new Date(Date.UTC(posted.getUTCFullYear(), month - 1, day));
  // If derived is implausibly in the future vs posted date, assume prior year boundary.
  if (derived.getTime() - posted.getTime() > 7 * 86_400_000) {
    derived.setUTCFullYear(derived.getUTCFullYear() - 1);
  }
  return formatDateKeyFromDate(derived);
}

function cleanBankDescription(rawDescription: string): string {
  const cleaned = rawDescription
    .replace(/^\s*purchase\s+authorized\s+on\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*/i, "")
    .replace(/\s+ref\s*#?[a-z0-9-]+/gi, "")
    .replace(/\s+card\s+\d{2,6}\b/gi, "")
    .replace(/\s+atm\s+id\s+\d+\b/gi, "")
    .replace(/\s+x{3,}\d{2,}\b/gi, "")
    .replace(/\s+[a-z](\d{8,})\b/gi, (_, digits) => ` #${digits.slice(-4)}`)
    .replace(/\s+(\d{10,})\b/g, (_, digits) => ` #${digits.slice(-4)}`)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || rawDescription.trim();
}

const DESCRIPTION_STOP_WORDS = new Set([
  "purchase",
  "authorized",
  "on",
  "payment",
  "online",
  "transfer",
  "from",
  "to",
  "ref",
  "card",
  "atm",
  "deposit",
  "web",
  "pmts",
  "inc",
  "llc",
  "co",
  "ut",
  "provo",
  "hurricane",
  "st",
  "saint",
]);

function normalizeDescriptionForMatch(value: string): string {
  return cleanBankDescription(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionTokenSet(value: string): Set<string> {
  const normalized = normalizeDescriptionForMatch(value);
  if (!normalized) return new Set<string>();
  const tokens = normalized
    .split(" ")
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !DESCRIPTION_STOP_WORDS.has(t) &&
        !/^\d+$/.test(t),
    );
  return new Set(tokens);
}

function descriptionSimilarity(a: string, b: string): number {
  const aTokens = descriptionTokenSet(a);
  const bTokens = descriptionTokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }

  const denom = Math.max(aTokens.size, bTokens.size);
  return denom > 0 ? overlap / denom : 0;
}

const TRANSFER_CANDIDATE_MAX_DAY_DISTANCE = 31;

function isLikelyTransferDescription(value: string): boolean {
  const normalized = normalizeDescriptionForMatch(value);
  return /(?:\btransfer\b|\bvenmo\b|\bcashout\b|\bzelle\b|\bpaypal\b|\bcash\s*app\b|\bpayment\b|\bcardpmt\b|\bcrcardpmt\b|\bautopay\b|\bdeposit\b|\bwithdrawal\b)/
    .test(normalized);
}

export function mapBankRowToTransaction(
  accountName: keyof typeof BANK_PROFILES | string,
  row: string[],
  profileOverride?: BankProfile,
): BankTransaction | null {
  const profile = profileOverride ?? BANK_PROFILES[accountName];
  if (!profile || !isProfileConfigured(profile)) return null;

  const dateIndex = profile.dateIndex as number;
  const descriptionIndex = profile.descriptionIndex as number;
  const postedDate = String(row[dateIndex] ?? "").trim();
  const rawDescription = String(row[descriptionIndex] ?? "").trim();
  const description = cleanBankDescription(rawDescription);
  const derivedDate = deriveBankTransactionDate(String(accountName), postedDate, rawDescription);
  const date = normalizeDateOnly(derivedDate);
  let amount: number | null = null;
  if (profile.amountIndex !== null) {
    const rawAmount = String(row[profile.amountIndex] ?? "");
    amount = parseBankAmount(rawAmount);
  } else if (profile.debitIndex != null && profile.creditIndex != null) {
    const debitIdx = profile.debitIndex;
    const creditIdx = profile.creditIndex;
    const debitAmount = parseBankAmount(String(row[debitIdx] ?? ""));
    const creditAmount = parseBankAmount(String(row[creditIdx] ?? ""));
    if (debitAmount !== null && Math.abs(debitAmount) > 0) {
      amount = Math.abs(debitAmount);
    } else if (creditAmount !== null && Math.abs(creditAmount) > 0) {
      amount = -Math.abs(creditAmount);
    } else {
      amount = null;
    }
  }
  if (!date || !description || amount === null) return null;

  return {
    accountName: String(accountName),
    date,
    amount,
    description,
    hash: generateTransactionHash(date, amount, description),
    raw: row,
  };
}

// When two rows produce identical hashes (same date/amount/description), append -2, -3, etc.
// so each transaction gets a unique, stable key for Neon storage.
function disambiguateHashes(txs: BankTransaction[]): BankTransaction[] {
  const seen = new Map<string, number>();
  return txs.map((tx) => {
    const count = (seen.get(tx.hash) ?? 0) + 1;
    seen.set(tx.hash, count);
    return count > 1 ? { ...tx, hash: `${tx.hash}-${count}` } : tx;
  });
}

export function mapBankRowsToTransactions(
  accountName: keyof typeof BANK_PROFILES | string,
  rows: string[][],
): BankTransaction[] {
  const fallbackProfile = BANK_PROFILES[accountName];
  if (!fallbackProfile || !isProfileConfigured(fallbackProfile)) return [];

  // Wells Fargo changed CSV format: old format has amount at col 1, new format has
  // a header row (DATE, DESCRIPTION, AMOUNT, ...) with description at col 1 and amount at col 2.
  // The stored mergedCsv can contain both formats simultaneously, so we detect per-row.
  if (isWellsFargoProfile(String(accountName))) {
    const newFormatProfile: BankProfile = { dateIndex: 0, amountIndex: 2, descriptionIndex: 1 };
    return disambiguateHashes(rows.flatMap((row): BankTransaction[] => {
      // Old format: col 1 is a numeric amount. New format: col 1 is description text.
      const isOldFormat = parseBankAmount(String(row[1] ?? "")) !== null;
      const profile = isOldFormat ? fallbackProfile : newFormatProfile;
      const tx = mapBankRowToTransaction(accountName, row, profile);
      return tx ? [tx] : [];
    }));
  }

  const resolved = isVenmoProfile(String(accountName))
    ? resolveVenmoProfile(rows, fallbackProfile)
    : isCapitalOneProfile(String(accountName))
      ? resolveCapitalOneProfile(rows, fallbackProfile)
      : { profile: fallbackProfile, startRowIndex: 0 };

  return disambiguateHashes(
    rows
      .slice(resolved.startRowIndex)
      .map((row) => mapBankRowToTransaction(accountName, row, resolved.profile))
      .filter((tx): tx is BankTransaction => tx !== null),
  );
}

function fullRowKey(row: string[]): string {
  return row.map((cell) => String(cell).trim()).join("\t");
}

/**
 * Returns one stable dedupe key per input row, aligned to `rows`, identifying a
 * transaction by its identity (date|amount|description) rather than its full raw
 * line. This collapses the same transaction re-imported across overlapping
 * statements (which may differ only in a non-identifying column such as the
 * running balance), while preserving genuinely-duplicate lines within a single
 * file.
 *
 * - Parseable rows -> `id:${tx.hash}`. The hash is already occurrence-
 *   disambiguated (X, X-2, ...), so two identical lines in one file get distinct
 *   keys and are both kept.
 * - Rows that produce no transaction (header rows, unconfigured banks) -> an
 *   occurrence-indexed full-row key (`raw:...`), preserving today's behaviour so
 *   header rows survive for Venmo/Capital One profile resolution.
 */
export function computeCsvIdentityKeys(
  accountName: string,
  rows: string[][],
): string[] {
  const profileAccount = PROFILE_BY_ACCOUNT[accountName] ?? accountName;
  const transactions = mapBankRowsToTransactions(profileAccount, rows);
  const keyByRawRef = new Map<string[], string>();
  for (const tx of transactions) {
    if (tx.raw) keyByRawRef.set(tx.raw, `id:${tx.hash}`);
  }

  const fallbackCount = new Map<string, number>();
  return rows.map((row) => {
    const idKey = keyByRawRef.get(row);
    if (idKey) return idKey;
    const base = fullRowKey(row);
    const n = fallbackCount.get(base) ?? 0;
    fallbackCount.set(base, n + 1);
    return n === 0 ? `raw:${base}` : `raw:${base}|${n}`;
  });
}

/**
 * Identity-merge two batches of CSV rows. Existing rows are kept, incoming rows
 * with the same identity overwrite them, and new identities are appended — i.e.
 * the result holds max(existing, incoming) copies of each identity. Returns the
 * merged rows together with their aligned identity keys.
 */
export function mergeCsvRowsByIdentity(
  accountName: string,
  existing: string[][],
  incoming: string[][],
): { rows: string[][]; keys: string[] } {
  const existingKeys = computeCsvIdentityKeys(accountName, existing);
  const incomingKeys = computeCsvIdentityKeys(accountName, incoming);
  const byKey = new Map<string, string[]>();
  existing.forEach((row, i) => byKey.set(existingKeys[i], row));
  incoming.forEach((row, i) => byKey.set(incomingKeys[i], row));
  return {
    rows: Array.from(byKey.values()),
    keys: Array.from(byKey.keys()),
  };
}

async function getProcessedTransactionHashes(): Promise<Set<string>> {
  if (typeof window !== "undefined") return new Set<string>();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return new Set<string>();

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT hash
      FROM processed_transactions
    `) as { hash: string }[];
    return new Set(rows.map((r) => r.hash));
  } catch {
    // Gracefully skip Neon hash matching when table/env is not ready.
    return new Set<string>();
  }
}

/**
 * Match bank transactions against processed hashes, existing sheet rows, and transfer pairs.
 *
 * Priority:
 * 1) Exact Match: amount+date equals a sheet row.
 * 2) Processed: hash exists in Neon but no current sheet row is linked.
 * 3) Transfer: amount/date aligns with transfer rows or opposing bank transaction.
 * 4) Amount-first expense matching:
 *    a) Auto-match (exact_match): high score, clear margin, not in ambiguous cluster.
 *    b) Suggested (suggested_match): amount matches but confidence too low for auto.
 * 5) Cross-account counterparty transfer.
 * 6) Unmatched: no amount match found at all.
 */
export async function findMatches(
  bankTransactions: BankTransaction[],
  sheetExpenses: SheetExpenseLike[],
  options?: {
    processedHashes?: Iterable<string>;
    sheetTransfers?: SheetTransferLike[];
    transferClaimStatusByRowId?: Record<string, TransferClaimStatus>;
    merchantMemory?: MerchantMemoryEntry[];
  },
): Promise<MatchResult[]> {
  const processedHashes = options?.processedHashes
    ? new Set(options.processedHashes)
    : await getProcessedTransactionHashes();
  const exactSheetIndex = toIndexedMap(sheetExpenses);
  const amountIndex = toAmountOnlyIndex(sheetExpenses);
  const clusterSet = buildClusterSet(bankTransactions);

  // Merchant Memory — Phase 4. Only entries with confirmed_count >= 2 auto-match.
  const memoryByKey = new Map<string, MerchantMemoryEntry>();
  for (const entry of options?.merchantMemory ?? []) {
    if (!entry || (entry.confirmedCount ?? 0) < 2) continue;
    memoryByKey.set(`${entry.fingerprint}|${entry.bankAccountName}`, entry);
  }

  const AUTO_SCORE_THRESHOLD = 1.0;
  const AUTO_SCORE_MARGIN = 0.3;
  // When exactly one unclaimed sheet expense has the bank line's exact amount,
  // the amount alone is strong evidence — auto-match it even with weak
  // description overlap, as long as it falls within this date window (posting
  // lag / logging delay). Ambiguous (multiple same-amount) candidates still
  // require manual approval.
  const UNIQUE_AMOUNT_AUTO_DAY_WINDOW = 14;

  const consumedRowIds = new Set<string>();
  const results: MatchResult[] = [];

  for (const tx of bankTransactions) {
    const txDate = normalizeDateOnly(tx.date);
    const exactKey = `${amountKey(tx.amount)}|${txDate}`;
    const exactSheet = (exactSheetIndex.get(exactKey) ?? []).find((row) => {
      const rowId = String(row.rowId ?? "").trim();
      return !rowId || !consumedRowIds.has(rowId);
    });
    const exactSheetIndexValue = exactSheet
      ? sheetExpenses.findIndex((row) => row === exactSheet)
      : -1;
    const exactByHash = processedHashes.has(tx.hash);

    if (exactSheet) {
      const rowId = String(exactSheet.rowId ?? "").trim();
      if (rowId) consumedRowIds.add(rowId);
      results.push({
        bankTransaction: tx,
        matchType: "exact_match",
        reason: "Exact Match: identical amount and date already exists in sheet.",
        matchedByNeonHash: exactByHash,
        matchedSheetExpense: exactSheet,
        matchedSheetIndex: exactSheetIndexValue >= 0 ? exactSheetIndexValue : undefined,
      });
      continue;
    }
    if (exactByHash) {
      results.push({
        bankTransaction: tx,
        matchType: "processed",
        reason:
          "Already processed: transaction hash exists in Neon, but no linked sheet entry is currently found.",
        matchedByNeonHash: true,
      });
      continue;
    }

    // Merchant Memory: if this fingerprint has been confirmed >= 2 times,
    // auto-match against the most-recent unclaimed sheet expense with the
    // same amount.
    if (memoryByKey.size > 0) {
      const fingerprint = generateMerchantFingerprint(tx.description, tx.amount);
      const memEntry = memoryByKey.get(`${fingerprint}|${tx.accountName}`);
      if (memEntry) {
        const candidates = amountIndex.get(amountKey(tx.amount)) ?? [];
        const sortedCandidates = [...candidates].sort((a, b) => {
          const aDate = String(a.date ?? a.timestamp ?? "");
          const bDate = String(b.date ?? b.timestamp ?? "");
          return bDate.localeCompare(aDate);
        });
        const pick = sortedCandidates.find((row) => {
          const rowId = String(row.rowId ?? "").trim();
          return !rowId || !consumedRowIds.has(rowId);
        });
        if (pick) {
          const rowId = String(pick.rowId ?? "").trim();
          if (rowId) consumedRowIds.add(rowId);
          results.push({
            bankTransaction: tx,
            matchType: "exact_match",
            reason: `Memory: matched recurring pattern (${memEntry.confirmedCount} prior confirmations).`,
            matchedSheetExpense: pick,
            matchedSheetIndex: sheetExpenses.indexOf(pick),
            matchedByMerchantMemory: true,
          });
          continue;
        }
      }
    }

    const sheetTransfers = options?.sheetTransfers ?? [];
    const transferClaimStatusByRowId = options?.transferClaimStatusByRowId ?? {};
    const transferCandidates = sheetTransfers
      .map((sheetTransfer, index) => {
        if (amountKey(sheetTransfer.amount) !== amountKey(tx.amount)) return null;
        const transferRowId = String(sheetTransfer.transferRowId ?? "").trim();
        const claimStatus = transferRowId ? transferClaimStatusByRowId[transferRowId] : undefined;
        if (claimStatus?.isComplete) return null;

        const txSign = cents(tx.amount) >= 0 ? 1 : -1;
        if (claimStatus && claimStatus.expectedLegs === 2) {
          const hasSameSignClaim = txSign > 0 ? claimStatus.hasPositive : claimStatus.hasNegative;
          if (hasSameSignClaim) return null;
        }

        const transferDate = sheetTransfer.date ?? sheetTransfer.timestamp ?? "";
        const dayDistance = dateDistanceInDays(transferDate, tx.date);
        if (dayDistance === null || dayDistance > TRANSFER_CANDIDATE_MAX_DAY_DISTANCE) return null;

        const transferText = [
          sheetTransfer.transferFrom ?? "",
          sheetTransfer.transferTo ?? "",
          sheetTransfer.description ?? "",
        ]
          .join(" ")
          .trim();
        const similarity = descriptionSimilarity(tx.description, transferText);
        const likelyTransfer =
          isLikelyTransferDescription(tx.description) ||
          isLikelyTransferDescription(transferText) ||
          similarity >= 0.12;
        if (!likelyTransfer) return null;

        return { index, row: sheetTransfer, dayDistance, similarity };
      })
      .filter(
        (
          candidate,
        ): candidate is {
          index: number;
          row: SheetTransferLike;
          dayDistance: number;
          similarity: number;
        } => candidate !== null,
      )
      .sort((a, b) => {
        if (a.dayDistance !== b.dayDistance) return a.dayDistance - b.dayDistance;
        return b.similarity - a.similarity;
      });

    const bestSheetTransfer = transferCandidates[0];
    if (bestSheetTransfer) {
      const uniqueTransferCandidate = transferCandidates.length === 1;
      if (uniqueTransferCandidate) {
        results.push({
          bankTransaction: tx,
          matchType: "transfer",
          reason:
            "Transfer Match: amount/date aligns with a transfer already logged in sheet.",
          matchedSheetTransfer: bestSheetTransfer.row,
          matchedSheetTransferIndex: bestSheetTransfer.index,
        });
        continue;
      }

      results.push({
        bankTransaction: tx,
        matchType: "questionable_match_fuzzy",
        reason:
          "Questionable Transfer Match: multiple transfer-sheet candidates share the same amount/date window.",
        matchedSheetTransfer: bestSheetTransfer.row,
        matchedSheetTransferIndex: bestSheetTransfer.index,
      });
      continue;
    }

    // --- Amount-first expense matching ---
    const amountCandidateRows = amountIndex.get(amountKey(tx.amount)) ?? [];
    const scoredCandidates = amountCandidateRows
      .map((sheetRow, _i) => {
        const rowId = String(sheetRow.rowId ?? "").trim();
        const sheetDate = sheetRow.date ?? sheetRow.timestamp ?? "";
        const dayDist = dateDistanceInDays(sheetDate, tx.date);
        const score = scoreCandidate(tx, sheetRow, dayDist);
        const globalIndex = sheetExpenses.indexOf(sheetRow);
        return { row: sheetRow, index: globalIndex, dayDistance: dayDist, score, rowId };
      })
      .sort((a, b) => b.score - a.score);

    if (scoredCandidates.length > 0) {
      const best = scoredCandidates[0];
      const second = scoredCandidates[1];
      const isCluster = clusterSet.has(tx.hash);
      const bestConsumed = best.rowId ? consumedRowIds.has(best.rowId) : false;
      const margin = second ? best.score - second.score : Infinity;

      // A single unclaimed expense at this exact amount, close enough in date:
      // the amount uniqueness carries the match even when descriptions diverge.
      const isUniqueAmountCandidate = scoredCandidates.length === 1;
      const withinUniqueWindow =
        best.dayDistance !== null && best.dayDistance <= UNIQUE_AMOUNT_AUTO_DAY_WINDOW;
      const uniqueAmountAutoMatch = isUniqueAmountCandidate && withinUniqueWindow;

      const shouldAutoMatch =
        !isCluster &&
        !bestConsumed &&
        ((best.score >= AUTO_SCORE_THRESHOLD && margin >= AUTO_SCORE_MARGIN) ||
          uniqueAmountAutoMatch);

      if (shouldAutoMatch) {
        if (best.rowId) consumedRowIds.add(best.rowId);
        const reason = uniqueAmountAutoMatch
          ? `Auto Match: only unclaimed expense at this amount within ${UNIQUE_AMOUNT_AUTO_DAY_WINDOW} days (${best.dayDistance}d apart, score ${best.score.toFixed(2)}).`
          : `Auto Match: amount-first scoring (score ${best.score.toFixed(2)}, margin ${margin === Infinity ? "∞" : margin.toFixed(2)}).`;
        results.push({
          bankTransaction: tx,
          matchType: "exact_match",
          reason,
          matchedSheetExpense: best.row,
          matchedSheetIndex: best.index >= 0 ? best.index : undefined,
          confidenceScore: best.score,
          candidateCount: scoredCandidates.length,
          isAmbiguousCluster: isCluster,
        });
        continue;
      }

      const reasonParts: string[] = [];
      if (isCluster) reasonParts.push("ambiguous cluster (same merchant/amount/date)");
      if (bestConsumed) reasonParts.push("best candidate already consumed by another match");
      if (best.score < AUTO_SCORE_THRESHOLD) reasonParts.push(`score ${best.score.toFixed(2)} below auto threshold`);
      if (margin < AUTO_SCORE_MARGIN) reasonParts.push(`margin ${margin === Infinity ? "∞" : margin.toFixed(2)} too narrow`);

      results.push({
        bankTransaction: tx,
        matchType: "suggested_match",
        reason: `Suggested Match: exact amount, needs approval (${reasonParts.join("; ")}).`,
        matchedSheetExpense: best.row,
        matchedSheetIndex: best.index >= 0 ? best.index : undefined,
        confidenceScore: best.score,
        candidateCount: scoredCandidates.length,
        isAmbiguousCluster: isCluster,
      });
      continue;
    }

    if (tx.amount < 0) {
      const transferCounterparty = bankTransactions.find((candidate) => {
        if (candidate.accountName === tx.accountName) return false;
        if (normalizeDateOnly(candidate.date) !== txDate) return false;
        return cents(candidate.amount) === Math.abs(cents(tx.amount));
      });

      if (transferCounterparty) {
        results.push({
          bankTransaction: tx,
          matchType: "transfer",
          reason:
            "Transfer detected: negative amount matches positive amount in a different account on the same day.",
          transferCounterparty,
        });
        continue;
      }
    }

    results.push({
      bankTransaction: tx,
      matchType: "unmatched",
      reason: "No amount match found in sheet expenses, transfers, or cross-account counterparties.",
    });
  }

  return results;
}
