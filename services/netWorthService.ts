import { getExpenses, getTransfers } from "@/services/sheetsApi";

const ASSETS_API = "/api/assets";
const LIABILITIES_API = "/api/liabilities";

type ManualAsset = {
  id: string;
  name: string;
  value: number;
  category: string;
  updated_at?: string;
};

type ManualLiability = {
  id: string;
  name: string;
  value: number;
  category: string;
  updated_at?: string;
};

export type NetWorthSummary = {
  totalNetWorth: number;
  liquidNetWorth: number;
  earning: number;
  spending: number;
  investing: number;
  saving: number;
};

function asFiniteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function isInvestingLabel(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return [
    "invest",
    "brokerage",
    "roth",
    "ira",
    "401k",
    "hsa",
    "crypto",
    "stocks",
    "fidelity",
    "robinhood",
    "schwab",
  ].some((keyword) => v.includes(keyword));
}

function sumValues(items: Array<{ value: number }>): number {
  return items.reduce((sum, item) => sum + asFiniteNumber(item.value), 0);
}

/**
 * @param liquidAssetsTotal Sum of the user's data-driven account balances
 *   (computeAccountBalances). Passed in by the caller since the accounts list
 *   lives in React context. Defaults to 0 when unknown.
 */
export async function getNetWorthSummary(
  month?: string,
  liquidAssetsTotal = 0
): Promise<NetWorthSummary> {
  const [manualAssets, manualLiabilities, expenses, transfers] = await Promise.all([
    fetchJson<ManualAsset[]>(ASSETS_API),
    fetchJson<ManualLiability[]>(LIABILITIES_API),
    getExpenses(month),
    getTransfers(month),
  ]);

  const fixedAssetsTotal = sumValues(manualAssets);
  const liabilitiesTotal = sumValues(manualLiabilities);

  const earning = expenses
    .filter((row) => row.expenseType.trim().toLowerCase() === "income")
    .reduce((sum, row) => sum + asFiniteNumber(row.amount), 0);

  const spending = expenses
    .filter((row) => {
      const type = row.expenseType.trim().toLowerCase();
      return type !== "income" && type !== "investments" && type !== "tithing";
    })
    .reduce((sum, row) => sum + asFiniteNumber(row.amount), 0);

  const investingFromExpenses = expenses
    .filter((row) => row.expenseType.trim().toLowerCase() === "investments")
    .reduce((sum, row) => sum + asFiniteNumber(row.amount), 0);

  // Include transfers into investing accounts (and subtract transfers out).
  const investingFromTransfers = transfers.reduce((sum, row) => {
    const fromInvesting = isInvestingLabel(row.transferFrom);
    const toInvesting = isInvestingLabel(row.transferTo || row.description || "");
    const amount = asFiniteNumber(row.amount);
    if (toInvesting && !fromInvesting) return sum + amount;
    if (fromInvesting && !toInvesting) return sum - amount;
    return sum;
  }, 0);

  const investing = investingFromExpenses + investingFromTransfers;
  const saving = earning - (spending + investing);

  return {
    totalNetWorth: liquidAssetsTotal + fixedAssetsTotal - liabilitiesTotal,
    liquidNetWorth: liquidAssetsTotal - liabilitiesTotal,
    earning,
    spending,
    investing,
    saving,
  };
}
