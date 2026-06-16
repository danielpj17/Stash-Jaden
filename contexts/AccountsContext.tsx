"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from "react";
import { useRefresh } from "@/contexts/RefreshContext";

export type AccountType = "checking" | "savings" | "cash" | "credit" | "brokerage" | "other";

export type CsvFormat = {
  version?: number;
  headerRows?: number;
  dateIndex: number | null;
  amountIndex: number | null;
  debitIndex?: number | null;
  creditIndex?: number | null;
  descriptionIndex: number | null;
  dateFormat?: string;
  amountSign?: "standard" | "flip";
  configured?: boolean;
};

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  openingBalance: number;
  openingBalanceDate: string | null;
  csvFormat: Partial<CsvFormat> & Record<string, unknown>;
  includeInReconcile: boolean;
  sortOrder: number;
  archived: boolean;
  updatedAt?: string;
};

type AccountsContextType = {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Non-archived account names, sorted by sort order then name. */
  accountNames: string[];
  /** Non-archived account names flagged for reconciliation. */
  reconcileAccountNames: string[];
};

const AccountsContext = createContext<AccountsContextType | null>(null);

function normalizeAccount(raw: Partial<Account> & Record<string, unknown>): Account {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    type: (raw.type as AccountType) ?? "other",
    openingBalance: Number(raw.openingBalance ?? 0),
    openingBalanceDate:
      typeof raw.openingBalanceDate === "string" ? raw.openingBalanceDate : null,
    csvFormat:
      raw.csvFormat && typeof raw.csvFormat === "object" && !Array.isArray(raw.csvFormat)
        ? (raw.csvFormat as Account["csvFormat"])
        : {},
    includeInReconcile: raw.includeInReconcile !== false,
    sortOrder: Number(raw.sortOrder ?? 0),
    archived: raw.archived === true,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
  };
}

export function AccountsProvider({ children }: { children: ReactNode }) {
  const { refreshKey } = useRefresh();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const reqId = ++reqRef.current;
    setLoading(true);
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to load accounts: ${res.status}`);
      }
      const data = (await res.json()) as Array<Partial<Account> & Record<string, unknown>>;
      if (reqId !== reqRef.current) return;
      setAccounts(Array.isArray(data) ? data.map(normalizeAccount) : []);
      setError(null);
    } catch (err) {
      if (reqId !== reqRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const sortedActive = useMemo(
    () =>
      accounts
        .filter((a) => !a.archived)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [accounts]
  );

  const accountNames = useMemo(() => sortedActive.map((a) => a.name), [sortedActive]);
  const reconcileAccountNames = useMemo(
    () => sortedActive.filter((a) => a.includeInReconcile).map((a) => a.name),
    [sortedActive]
  );

  const value = useMemo(
    () => ({ accounts, loading, error, refresh, accountNames, reconcileAccountNames }),
    [accounts, loading, error, refresh, accountNames, reconcileAccountNames]
  );

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts() {
  const ctx = useContext(AccountsContext);
  if (!ctx) throw new Error("useAccounts must be used within AccountsProvider");
  return ctx;
}
