import type { SheetRow, TransferRow } from "@/services/sheetsApi";

export type AccountAnchor = {
  accountName: string;
  confirmedBalance: number;
  asOfDate: string;
};

/** Minimal account shape needed to seed balances (from the accounts table). */
export type AccountSeed = {
  name: string;
  openingBalance: number;
  openingBalanceDate?: string | null;
};

function toDateKey(value?: string | null): string {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * A transaction/transfer only counts toward an account balance if it happened
 * strictly after that account's effective gate date (DB anchor date, or the
 * account's opening-balance date when no anchor exists). No gate = always apply.
 */
function shouldApply(
  accountKey: string,
  transactionDate: string,
  gateDateByAccount: Map<string, string>,
): boolean {
  const gate = gateDateByAccount.get(accountKey);
  if (!gate) return true;
  if (!transactionDate) return false;
  return transactionDate > gate;
}

function buildAnchorMap(anchors: AccountAnchor[]): Map<string, AccountAnchor> {
  const map = new Map<string, AccountAnchor>();
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.confirmedBalance)) continue;
    const key = String(anchor.accountName ?? "").trim();
    if (!key) continue;
    map.set(key, {
      accountName: key,
      confirmedBalance: Number(anchor.confirmedBalance),
      asOfDate: toDateKey(anchor.asOfDate),
    });
  }
  return map;
}

export async function getAccountAnchors(): Promise<AccountAnchor[]> {
  const res = await fetch("/api/reconciliation/anchors", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch account anchors: ${res.status}`);
  }
  const data = (await res.json()) as { anchors?: Array<Partial<AccountAnchor>> };
  const anchors = Array.isArray(data.anchors) ? data.anchors : [];
  return anchors
    .map((row) => ({
      accountName: String(row.accountName ?? ""),
      confirmedBalance: Number(row.confirmedBalance ?? 0),
      asOfDate: String(row.asOfDate ?? ""),
    }))
    .filter((row) => row.accountName.trim() !== "" && Number.isFinite(row.confirmedBalance));
}

/**
 * Computes current balances for the user's accounts.
 *
 * Each account is seeded from its opening balance; a DB anchor (if present)
 * overrides the seed and gate date. Transfers and sheet rows are then applied
 * by canonical account name. Precedence per account: anchor > opening balance > 0.
 */
export function computeAccountBalances(
  accounts: AccountSeed[],
  allRows: SheetRow[],
  allTransfers: TransferRow[],
  accountAnchors: AccountAnchor[] = [],
): Record<string, number> {
  const anchorByAccount = buildAnchorMap(accountAnchors);
  const balances: Record<string, number> = {};
  const gateDateByAccount = new Map<string, string>();

  for (const acct of accounts) {
    const name = String(acct.name ?? "").trim();
    if (!name) continue;
    balances[name] = Number(acct.openingBalance) || 0;
    const openDate = toDateKey(acct.openingBalanceDate ?? "");
    if (openDate) gateDateByAccount.set(name, openDate);
  }

  // DB anchors override the opening balance and gate date.
  for (const [name, anchor] of anchorByAccount.entries()) {
    balances[name] = anchor.confirmedBalance;
    if (anchor.asOfDate) gateDateByAccount.set(name, anchor.asOfDate);
    else gateDateByAccount.delete(name);
  }

  for (const t of allTransfers) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const txDate = toDateKey(t.timestamp);
    const fromKey = t.transferFrom.trim();
    const toKey = t.transferTo.trim();

    if (fromKey && balances[fromKey] !== undefined && shouldApply(fromKey, txDate, gateDateByAccount)) {
      balances[fromKey] -= amt;
    }
    if (toKey && balances[toKey] !== undefined && shouldApply(toKey, txDate, gateDateByAccount)) {
      balances[toKey] += amt;
    }
  }

  for (const row of allRows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const accountKey = String(row.account ?? "").trim();
    if (!accountKey || balances[accountKey] === undefined) continue;
    if (!shouldApply(accountKey, toDateKey(row.timestamp), gateDateByAccount)) continue;

    if (row.expenseType === "Income") {
      balances[accountKey] += amount;
    } else {
      balances[accountKey] -= amount;
    }
  }

  return balances;
}
