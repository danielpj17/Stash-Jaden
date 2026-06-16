import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  findMatches,
  mapBankRowsToTransactions,
  getCsvParseOptionsForAccount,
  PROFILE_BY_ACCOUNT,
  type MerchantMemoryEntry,
  type SheetExpenseLike,
  type SheetTransferLike,
} from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchRequestBody = {
  accountName?: unknown;
  rows?: unknown;
  sheetExpenses?: unknown;
  sheetTransfers?: unknown;
  processedHashes?: unknown;
};

type ClaimLinkRow = {
  bank_hash: string;
  sheet_name: string;
  sheet_row_id: string;
};

function readStringFieldCaseInsensitive(
  row: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    normalized.set(k.trim().toLowerCase(), v);
  }
  for (const key of keys) {
    const value = normalized.get(key.trim().toLowerCase());
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizeSheetExpenses(value: unknown): SheetExpenseLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => row as Record<string, unknown>)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      amount: Number(row.amount ?? 0),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      date: typeof row.date === "string" ? row.date : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      expenseType: typeof row.expenseType === "string" ? row.expenseType : undefined,
      account: typeof row.account === "string" ? row.account : undefined,
      rowId: readStringFieldCaseInsensitive(row, ["rowId", "Row ID", "row id", "row_id", "Row Id"]),
    }))
    .filter((row) => Number.isFinite(row.amount));
}

function normalizeCsvRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => Array.isArray(row))
    .map((row) =>
      (row as unknown[]).map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
    );
}

function normalizeSheetTransfers(value: unknown): SheetTransferLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => row as Record<string, unknown>)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      amount: Number(row.amount ?? 0),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      date: typeof row.date === "string" ? row.date : undefined,
      transferFrom: typeof row.transferFrom === "string" ? row.transferFrom : undefined,
      transferTo: typeof row.transferTo === "string" ? row.transferTo : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      transferRowId: readStringFieldCaseInsensitive(row, [
        "transferRowId",
        "Transfer Row ID",
        "transfer row id",
        "transfer_row_id",
        "Transfer Row Id",
      ]),
    }))
    .filter((row) => Number.isFinite(row.amount));
}

async function getMerchantMemoryForAccount(bankAccountName: string): Promise<MerchantMemoryEntry[]> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !bankAccountName) return [];
  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT fingerprint, bank_account_name, sheet_category, sheet_account, confirmed_count
      FROM reconciliation_merchant_memory
      WHERE bank_account_name = ${bankAccountName}
        AND confirmed_count >= 2
    `) as Array<{
      fingerprint: string;
      bank_account_name: string;
      sheet_category: string | null;
      sheet_account: string | null;
      confirmed_count: number;
    }>;
    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      bankAccountName: row.bank_account_name,
      confirmedCount: Number(row.confirmed_count ?? 0),
      sheetCategory: row.sheet_category,
      sheetAccount: row.sheet_account,
    }));
  } catch {
    // Memory table missing — proceed without memory-based matching.
    return [];
  }
}

async function getClaimedExpenseRowIds(): Promise<Set<string>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return new Set<string>();

  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT sheet_row_id
      FROM reconciliation_claim_links
      WHERE sheet_name = 'Expenses'
    `) as Array<{ sheet_row_id: string }>;
    return new Set(rows.map((row) => String(row.sheet_row_id)));
  } catch {
    // If claim table does not exist yet, continue without filtering.
    return new Set<string>();
  }
}

type TransferClaimRow = {
  transfer_sheet_row_id: string;
  bank_amount_cents: number;
  expected_legs: number;
};

async function getTransferClaimStatusByRowId(): Promise<
  Record<
    string,
    {
      claimedCount: number;
      expectedLegs: number;
      isComplete: boolean;
      hasPositive: boolean;
      hasNegative: boolean;
    }
  >
> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return {};

  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT transfer_sheet_row_id, bank_amount_cents, expected_legs
      FROM reconciliation_transfer_claim_links
    `) as TransferClaimRow[];

    const statusByRowId: Record<
      string,
      {
        claimedCount: number;
        expectedLegs: number;
        isComplete: boolean;
        hasPositive: boolean;
        hasNegative: boolean;
      }
    > = {};

    for (const row of rows) {
      const rowId = String(row.transfer_sheet_row_id ?? "").trim();
      if (!rowId) continue;
      const expectedLegs = Number(row.expected_legs ?? 2) === 1 ? 1 : 2;
      if (!statusByRowId[rowId]) {
        statusByRowId[rowId] = {
          claimedCount: 0,
          expectedLegs,
          isComplete: false,
          hasPositive: false,
          hasNegative: false,
        };
      }
      statusByRowId[rowId].claimedCount += 1;
      if (expectedLegs > statusByRowId[rowId].expectedLegs) {
        statusByRowId[rowId].expectedLegs = expectedLegs;
      }
      const amount = Number(row.bank_amount_cents ?? 0);
      if (amount > 0) statusByRowId[rowId].hasPositive = true;
      if (amount < 0) statusByRowId[rowId].hasNegative = true;
    }

    for (const rowId of Object.keys(statusByRowId)) {
      const entry = statusByRowId[rowId];
      entry.isComplete = entry.claimedCount >= entry.expectedLegs;
    }

    return statusByRowId;
  } catch {
    // If table does not exist yet, continue without transfer-claim filtering.
    return {};
  }
}

async function getClaimLinksByBankHashes(
  bankHashes: string[],
): Promise<Map<string, Array<{ sheetName: string; sheetRowId: string }>>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || bankHashes.length === 0) {
    return new Map<string, Array<{ sheetName: string; sheetRowId: string }>>();
  }

  try {
    const sql = neon(connectionString);
    const expenseRows = (await sql`
      SELECT bank_hash, sheet_name, sheet_row_id
      FROM reconciliation_claim_links
      WHERE bank_hash = ANY(${bankHashes}::text[])
      ORDER BY created_at ASC
    `) as ClaimLinkRow[];
    const transferRows = (await sql`
      SELECT bank_hash, 'Transfers' AS sheet_name, transfer_sheet_row_id AS sheet_row_id
      FROM reconciliation_transfer_claim_links
      WHERE bank_hash = ANY(${bankHashes}::text[])
      ORDER BY created_at ASC
    `) as ClaimLinkRow[];

    const linksByHash = new Map<string, Array<{ sheetName: string; sheetRowId: string }>>();
    const allRows = [...expenseRows, ...transferRows];
    for (const row of allRows) {
      const bankHash = String(row.bank_hash ?? "").trim();
      const sheetName = String(row.sheet_name ?? "").trim();
      const sheetRowId = String(row.sheet_row_id ?? "").trim();
      if (!bankHash || !sheetName || !sheetRowId) continue;
      if (!linksByHash.has(bankHash)) linksByHash.set(bankHash, []);
      linksByHash.get(bankHash)?.push({ sheetName, sheetRowId });
    }
    return linksByHash;
  } catch {
    // If claim tables do not exist yet, continue with normal matcher behavior.
    return new Map<string, Array<{ sheetName: string; sheetRowId: string }>>();
  }
}

export async function POST(request: NextRequest) {
  let body: MatchRequestBody;
  try {
    body = (await request.json()) as MatchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }

  const csvOpts = await getCsvParseOptionsForAccount(accountName);
  const profileAccount = csvOpts ? accountName : (PROFILE_BY_ACCOUNT[accountName] ?? accountName);
  const rows = normalizeCsvRows(body.rows);
  const sheetExpenses = normalizeSheetExpenses(body.sheetExpenses);
  const sheetTransfers = normalizeSheetTransfers(body.sheetTransfers);
  const processedHashes = Array.isArray(body.processedHashes)
    ? body.processedHashes.map((h) => String(h))
    : undefined;

  const bankTransactions = mapBankRowsToTransactions(profileAccount, rows, csvOpts).map((tx) => ({
    ...tx,
    accountName,
  }));
  const bankHashes = Array.from(new Set(bankTransactions.map((tx) => tx.hash)));
  const claimLinksByHash = await getClaimLinksByBankHashes(bankHashes);

  const claimedExpenseRowIds = await getClaimedExpenseRowIds();
  const transferClaimStatusByRowId = await getTransferClaimStatusByRowId();
  const merchantMemory = await getMerchantMemoryForAccount(accountName);
  const unclaimedSheetExpenses = sheetExpenses.filter((row) => {
    const rowId = (row.rowId ?? "").trim();
    if (!rowId) return true;
    return !claimedExpenseRowIds.has(rowId);
  });
  const availableSheetTransfers = sheetTransfers.filter((row) => {
    const rowId = (row.transferRowId ?? "").trim();
    if (!rowId) return true;
    const claimStatus = transferClaimStatusByRowId[rowId];
    return !claimStatus?.isComplete;
  });

  const expenseByRowId = new Map(
    sheetExpenses
      .map((row) => {
        const rowId = String(row.rowId ?? "").trim();
        return rowId ? [rowId, row] : null;
      })
      .filter(
        (
          entry,
        ): entry is [string, SheetExpenseLike] => entry !== null,
      ),
  );
  const transferByRowId = new Map(
    sheetTransfers
      .map((row) => {
        const rowId = String(row.transferRowId ?? "").trim();
        return rowId ? [rowId, row] : null;
      })
      .filter(
        (
          entry,
        ): entry is [string, SheetTransferLike] => entry !== null,
      ),
  );

  const claimedMatches: Awaited<ReturnType<typeof findMatches>> = [];
  const unclaimedBankTransactions: typeof bankTransactions = [];
  for (const tx of bankTransactions) {
    const links = claimLinksByHash.get(tx.hash);
    if (!links || links.length === 0) {
      unclaimedBankTransactions.push(tx);
      continue;
    }

    const linkedExpense = links
      .filter((link) => link.sheetName === "Expenses")
      .map((link) => expenseByRowId.get(link.sheetRowId))
      .find((row): row is SheetExpenseLike => Boolean(row));
    if (linkedExpense) {
      claimedMatches.push({
        bankTransaction: tx,
        matchType: "exact_match" as const,
        reason: "Claim Link: restored from Neon claim link.",
        matchedSheetExpense: linkedExpense,
        matchedSheetIndex: undefined,
      });
      continue;
    }

    const linkedTransfer = links
      .filter((link) => link.sheetName === "Transfers")
      .map((link) => transferByRowId.get(link.sheetRowId))
      .find((row): row is SheetTransferLike => Boolean(row));
    if (linkedTransfer) {
      claimedMatches.push({
        bankTransaction: tx,
        matchType: "exact_match" as const,
        reason: "Claim Link: restored from Neon transfer claim.",
        matchedSheetTransfer: linkedTransfer,
        matchedSheetTransferIndex: undefined,
      });
      continue;
    }

    claimedMatches.push({
      bankTransaction: tx,
      matchType: "processed" as const,
      reason: "Claim Link exists in Neon, but linked sheet row was not found in current sheet payload.",
      matchedByNeonHash: true,
    });
  }

  const matcherMatches = await findMatches(unclaimedBankTransactions, unclaimedSheetExpenses, {
    processedHashes,
    sheetTransfers: availableSheetTransfers,
    transferClaimStatusByRowId,
    merchantMemory,
  });
  const matches = [...claimedMatches, ...matcherMatches];
  return NextResponse.json({ bankTransactions, matches });
}
