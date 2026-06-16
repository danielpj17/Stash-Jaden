"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import MonthDropdown from "@/components/MonthDropdown";
import { useMonth } from "@/contexts/MonthContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { useExpensesData } from "@/contexts/ExpensesDataContext";
import { useAccounts, type Account, type AccountType } from "@/contexts/AccountsContext";
import { rowMatchesMonth } from "@/services/sheetsApi";
import { getNetWorthSummary, type NetWorthSummary } from "@/services/netWorthService";
import {
  computeAccountBalances,
  getAccountAnchors,
  type AccountAnchor,
} from "@/services/accountBalancesService";
import {
  ASSET_CATEGORIES,
  LIABILITY_CATEGORIES,
  PIE_COLORS,
} from "@/lib/constants";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

type ManualItem = {
  id: string;
  name: string;
  value: number;
  category: string;
  acquisition_date?: string | null;
  details?: Record<string, unknown>;
  updated_at?: string;
};

type EditingState = {
  id: string;
  name: string;
  value: string;
  category: string;
};

type ManualFormState = {
  id?: string;
  name: string;
  value: string;
  category: string;
  acquisitionDate: string;
  details: Record<string, string>;
};

type GrowthPoint = {
  month: string;
  label: string;
  sheetsNetChange: number | null;
};

const ACCOUNT_TYPE_OPTIONS: AccountType[] = [
  "checking",
  "savings",
  "cash",
  "credit",
  "brokerage",
  "other",
];

type AccountFormState = {
  id?: string;
  name: string;
  type: AccountType;
  openingBalance: string;
  openingBalanceDate: string;
  includeInReconcile: boolean;
};

const fmtCurrency = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function parseMonthFromRow(row: { month?: string; timestamp?: string }): string | null {
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    }
  }

  const raw = String(row.month ?? "").trim().toLowerCase();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) {
    return `${new Date().getFullYear()}-${String(numeric).padStart(2, "0")}`;
  }

  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];

  for (let i = 0; i < monthNames.length; i += 1) {
    if (!raw.includes(monthNames[i])) continue;
    const parsedYear = Number(raw.replace(/[^0-9]/g, ""));
    const year = Number.isFinite(parsedYear) && parsedYear > 1900 ? parsedYear : new Date().getFullYear();
    return `${year}-${String(i + 1).padStart(2, "0")}`;
  }

  return null;
}

function lastSixMonthKeys(): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short" });
}

function formatAcquiredDate(dateValue?: string | null): string {
  if (!dateValue) return "—";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function fetchManualItems(url: string): Promise<ManualItem[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch ${url}`);
  }
  const data = (await res.json()) as Array<Partial<ManualItem>>;
  return Array.isArray(data)
    ? data.map((item) => ({
        id: String(item.id ?? ""),
        name: String(item.name ?? ""),
        value: Number(item.value ?? 0),
        category: String(item.category ?? ""),
        acquisition_date:
          typeof item.acquisition_date === "string"
            ? item.acquisition_date
            : typeof (item as { acquisitionDate?: unknown }).acquisitionDate === "string"
              ? String((item as { acquisitionDate?: unknown }).acquisitionDate)
              : null,
        details:
          item.details && typeof item.details === "object" && !Array.isArray(item.details)
            ? (item.details as Record<string, unknown>)
            : {},
        updated_at: item.updated_at ? String(item.updated_at) : undefined,
      }))
    : [];
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

export default function NetWorthPage() {
  const { selectedMonth } = useMonth();
  const { triggerRefresh } = useRefresh();
  const { allRows, allTransfers, loading: expensesLoading, error: expensesError } = useExpensesData();

  const [summary, setSummary] = useState<NetWorthSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [assets, setAssets] = useState<ManualItem[]>([]);
  const [liabilities, setLiabilities] = useState<ManualItem[]>([]);
  const [tableError, setTableError] = useState<string | null>(null);
  const [tableLoading, setTableLoading] = useState(true);

  const [activeManualTab, setActiveManualTab] = useState<"assets" | "liabilities">("assets");
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [manualFormMode, setManualFormMode] = useState<"create" | "edit">("create");
  const [manualFormTab, setManualFormTab] = useState<"assets" | "liabilities">("assets");
  const [manualForm, setManualForm] = useState<ManualFormState>({
    name: "",
    value: "",
    category: ASSET_CATEGORIES[0],
    acquisitionDate: "",
    details: {},
  });
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [goalTarget, setGoalTarget] = useState<number>(0);
  const [accountAnchors, setAccountAnchors] = useState<AccountAnchor[]>([]);

  // Account management modal
  const { accounts, refresh: refreshAccounts } = useAccounts();
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountFormMode, setAccountFormMode] = useState<"create" | "edit">("create");
  const [accountForm, setAccountForm] = useState<AccountFormState>({
    name: "",
    type: "checking",
    openingBalance: "",
    openingBalanceDate: "",
    includeInReconcile: true,
  });
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountDeletingId, setAccountDeletingId] = useState<string | null>(null);

  const summaryReqRef = useRef(0);
  const tableReqRef = useRef(0);
  const anchorsReqRef = useRef(0);

  const accountSeeds = useMemo(
    () =>
      accounts.map((a) => ({
        name: a.name,
        openingBalance: a.openingBalance,
        openingBalanceDate: a.openingBalanceDate,
      })),
    [accounts]
  );

  const filteredRows = useMemo(
    () => allRows.filter((row) => rowMatchesMonth(row, selectedMonth)),
    [allRows, selectedMonth]
  );

  const incomeBreakdown = useMemo(() => {
    const bySource: Record<string, number> = {};
    filteredRows
      .filter((row) => row.expenseType.trim().toLowerCase() === "income")
      .forEach((row) => {
        const source = row.description.trim() || "Unlabeled Income";
        bySource[source] = (bySource[source] ?? 0) + Number(row.amount || 0);
      });
    return Object.entries(bySource)
      .map(([source, amount]) => ({ source, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredRows]);

  const sheetsHistoryByMonth = useMemo<Record<string, number>>(() => {
    const incomeByMonth: Record<string, number> = {};
    const expensesByMonth: Record<string, number> = {};
    allRows.forEach((row) => {
      const key = parseMonthFromRow(row);
      if (!key) return;
      const amount = Number(row.amount || 0);
      if (!Number.isFinite(amount)) return;

      if (row.expenseType.trim().toLowerCase() === "income") {
        incomeByMonth[key] = (incomeByMonth[key] ?? 0) + amount;
      } else {
        expensesByMonth[key] = (expensesByMonth[key] ?? 0) + amount;
      }
    });
    const out: Record<string, number> = {};
    Object.keys({ ...incomeByMonth, ...expensesByMonth }).forEach((key) => {
      out[key] = (incomeByMonth[key] ?? 0) - (expensesByMonth[key] ?? 0);
    });
    return out;
  }, [allRows]);

  const trendData = useMemo<GrowthPoint[]>(() => {
    const defaultKeys = lastSixMonthKeys();
    const dynamicKeys = Object.keys(sheetsHistoryByMonth);
    const keys = [...new Set([...defaultKeys, ...dynamicKeys])]
      .sort((a, b) => a.localeCompare(b))
      .slice(-12);
    return keys.map((key) => ({
      month: key,
      label: monthLabel(key),
      sheetsNetChange:
        sheetsHistoryByMonth[key] !== undefined ? Number(sheetsHistoryByMonth[key]) : null,
    }));
  }, [sheetsHistoryByMonth]);

  const accountBalances = useMemo(
    () => computeAccountBalances(accountSeeds, allRows, allTransfers, accountAnchors),
    [accountSeeds, allRows, allTransfers, accountAnchors]
  );
  const visibleAccountBalances = useMemo(
    () => Object.entries(accountBalances).filter(([, value]) => Math.abs(Number(value)) >= 0.005),
    [accountBalances]
  );
  const allAccountBalancesTotal = useMemo(
    () => Object.values(accountBalances).reduce((sum, value) => sum + Number(value || 0), 0),
    [accountBalances]
  );

  // Investments = brokerage-type account balances + investing-labeled manual assets.
  const investmentsTotal = useMemo(() => {
    const brokerageNames = new Set(
      accounts.filter((a) => a.type === "brokerage").map((a) => a.name)
    );
    const fromAccounts = Object.entries(accountBalances)
      .filter(([name]) => brokerageNames.has(name))
      .reduce((sum, [, value]) => sum + Number(value || 0), 0);
    const fromAssets = assets
      .filter((a) => isInvestingLabel(`${a.category} ${a.name}`))
      .reduce((sum, a) => sum + Number(a.value || 0), 0);
    return fromAccounts + fromAssets;
  }, [accounts, accountBalances, assets]);

  const averageMonthlyExpenses = useMemo(() => {
    if (trendData.length === 0) return 0;
    const keys = new Set(trendData.map((point) => point.month));
    const expenseByMonth: Record<string, number> = {};
    allRows.forEach((row) => {
      if (row.expenseType.trim().toLowerCase() === "income") return;
      const key = parseMonthFromRow(row);
      if (!key || !keys.has(key)) return;
      expenseByMonth[key] = (expenseByMonth[key] ?? 0) + Number(row.amount || 0);
    });
    const totals = trendData.map((point) => expenseByMonth[point.month] ?? 0);
    const sum = totals.reduce((acc, v) => acc + v, 0);
    return totals.length ? sum / totals.length : 0;
  }, [allRows, trendData]);

  const loadSummary = useCallback(async () => {
    const reqId = ++summaryReqRef.current;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await getNetWorthSummary(selectedMonth, allAccountBalancesTotal);
      if (reqId !== summaryReqRef.current) return;
      setSummary(data);
    } catch (err) {
      if (reqId !== summaryReqRef.current) return;
      setSummaryError(err instanceof Error ? err.message : "Failed to load net worth summary");
    } finally {
      if (reqId !== summaryReqRef.current) return;
      setSummaryLoading(false);
    }
  }, [selectedMonth, allAccountBalancesTotal]);

  const loadManualTables = useCallback(async () => {
    const reqId = ++tableReqRef.current;
    setTableLoading(true);
    setTableError(null);
    try {
      const [assetData, liabilityData] = await Promise.all([
        fetchManualItems("/api/assets"),
        fetchManualItems("/api/liabilities"),
      ]);
      if (reqId !== tableReqRef.current) return;
      setAssets(assetData);
      setLiabilities(liabilityData);
    } catch (err) {
      if (reqId !== tableReqRef.current) return;
      setTableError(err instanceof Error ? err.message : "Failed to load assets/liabilities");
    } finally {
      if (reqId !== tableReqRef.current) return;
      setTableLoading(false);
    }
  }, []);

  const loadAccountAnchors = useCallback(async () => {
    const reqId = ++anchorsReqRef.current;
    try {
      const anchors = await getAccountAnchors();
      if (reqId !== anchorsReqRef.current) return;
      setAccountAnchors(anchors);
    } catch (err) {
      if (reqId !== anchorsReqRef.current) return;
      console.error("Failed to load account anchors:", err);
      setAccountAnchors([]);
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadManualTables();
  }, [loadManualTables]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setSummaryError(null);
    setTableError(null);
    triggerRefresh();
    try {
      await Promise.all([
        loadSummary(),
        loadManualTables(),
        loadAccountAnchors(),
        refreshAccounts(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [triggerRefresh, loadSummary, loadManualTables, loadAccountAnchors, refreshAccounts]);

  useEffect(() => {
    loadAccountAnchors();
  }, [loadAccountAnchors]);

  const liquidNetWorth = summary?.liquidNetWorth ?? 0;
  const totalNetWorth = summary?.totalNetWorth ?? 0;

  const liquidityRatio = useMemo(() => {
    if (!summary || averageMonthlyExpenses <= 0) return 0;
    // Liquid assets = account balances total (liquid net worth + liabilities).
    return allAccountBalancesTotal / averageMonthlyExpenses;
  }, [summary, allAccountBalancesTotal, averageMonthlyExpenses]);

  const runwayMonths = useMemo(() => {
    if (!summary || summary.spending <= 0) return 0;
    return liquidNetWorth / summary.spending;
  }, [summary, liquidNetWorth]);

  const savingsRate = useMemo(() => {
    if (!summary || summary.earning <= 0) return 0;
    return (summary.saving / summary.earning) * 100;
  }, [summary]);

  const goalProgress = useMemo(() => {
    if (!summary || goalTarget <= 0) return 0;
    return Math.max(0, (totalNetWorth / goalTarget) * 100);
  }, [summary, totalNetWorth, goalTarget]);

  const resetManualForm = useCallback((tab: "assets" | "liabilities") => {
    setManualForm({
      name: "",
      value: "",
      category: tab === "assets" ? ASSET_CATEGORIES[0] : LIABILITY_CATEGORIES[0],
      acquisitionDate: "",
      details: {},
    });
  }, []);

  const openCreateModal = (tab: "assets" | "liabilities") => {
    setManualFormMode("create");
    setManualFormTab(tab);
    resetManualForm(tab);
    setManualModalOpen(true);
  };

  const openEditModal = (item: ManualItem, tab: "assets" | "liabilities") => {
    setManualFormMode("edit");
    setManualFormTab(tab);
    const details = item.details && typeof item.details === "object" ? item.details : {};
    const detailStrings: Record<string, string> = {};
    Object.entries(details).forEach(([key, value]) => {
      detailStrings[key] = value == null ? "" : String(value);
    });
    setManualForm({
      id: item.id,
      name: item.name,
      value: String(item.value),
      category: item.category,
      acquisitionDate: item.acquisition_date ?? "",
      details: detailStrings,
    });
    setManualModalOpen(true);
  };

  const setDetailField = (key: string, value: string) => {
    setManualForm((prev) => ({
      ...prev,
      details: {
        ...prev.details,
        [key]: value,
      },
    }));
  };

  const saveManualForm = async () => {
    const parsedValue = Number(manualForm.value);
    if (!manualForm.name.trim() || !manualForm.category.trim() || !Number.isFinite(parsedValue)) {
      setTableError("Please provide valid name, category, and numeric value.");
      return;
    }
    const apiPath = manualFormTab === "assets" ? "/api/assets" : "/api/liabilities";
    setSavingRow(`${manualFormTab}:${manualForm.id ?? "new"}`);
    setTableError(null);
    try {
      const details: Record<string, unknown> = {};
      Object.entries(manualForm.details).forEach(([key, value]) => {
        const trimmed = String(value ?? "").trim();
        if (trimmed.length > 0) details[key] = trimmed;
      });
      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: manualForm.id,
          name: manualForm.name.trim(),
          value: parsedValue,
          category: manualForm.category.trim(),
          acquisitionDate: manualForm.acquisitionDate.trim() || null,
          details,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save ${manualFormTab}`);
      }
      setManualModalOpen(false);
      await Promise.all([loadManualTables(), loadSummary()]);
    } catch (err) {
      setTableError(err instanceof Error ? err.message : `Failed to save ${manualFormTab}`);
    } finally {
      setSavingRow(null);
    }
  };

  const deleteManualItem = async (item: ManualItem, tab: "assets" | "liabilities") => {
    const label = tab === "assets" ? "asset" : "liability";
    if (!window.confirm(`Delete ${label} "${item.name}"? This cannot be undone.`)) return;
    const apiPath = tab === "assets" ? "/api/assets" : "/api/liabilities";
    setDeletingId(item.id);
    setTableError(null);
    try {
      const res = await fetch(apiPath, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to delete ${label}`);
      }
      await Promise.all([loadManualTables(), loadSummary()]);
    } catch (err) {
      setTableError(err instanceof Error ? err.message : `Failed to delete ${label}`);
    } finally {
      setDeletingId(null);
    }
  };

  /* ---------- account management ---------- */

  const openCreateAccountModal = () => {
    setAccountFormMode("create");
    setAccountError(null);
    setAccountForm({
      name: "",
      type: "checking",
      openingBalance: "",
      openingBalanceDate: "",
      includeInReconcile: true,
    });
    setAccountModalOpen(true);
  };

  const openEditAccountModal = (account: Account) => {
    setAccountFormMode("edit");
    setAccountError(null);
    setAccountForm({
      id: account.id,
      name: account.name,
      type: account.type,
      openingBalance: String(account.openingBalance ?? 0),
      openingBalanceDate: account.openingBalanceDate ?? "",
      includeInReconcile: account.includeInReconcile,
    });
    setAccountModalOpen(true);
  };

  const saveAccountForm = async () => {
    const name = accountForm.name.trim();
    const openingBalance = Number(accountForm.openingBalance || 0);
    if (!name || !Number.isFinite(openingBalance)) {
      setAccountError("Please provide a name and a numeric opening balance.");
      return;
    }
    setAccountSaving(true);
    setAccountError(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: accountForm.id,
          name,
          type: accountForm.type,
          openingBalance,
          openingBalanceDate: accountForm.openingBalanceDate.trim() || null,
          includeInReconcile: accountForm.includeInReconcile,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Failed to save account");
      }
      setAccountModalOpen(false);
      await Promise.all([refreshAccounts(), loadSummary()]);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Failed to save account");
    } finally {
      setAccountSaving(false);
    }
  };

  const deleteAccount = async (account: Account) => {
    const purge = window.confirm(
      `Delete account "${account.name}"?\n\nClick OK to also permanently remove its reconciliation history ` +
        `(uploaded statements + balance anchor). Click Cancel to keep that history (it re-attaches if you ` +
        `re-create an account with the same name).`
    );
    // Either choice proceeds with delete; purge just controls history removal.
    setAccountDeletingId(account.id);
    setAccountError(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.id, purge }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Failed to delete account");
      }
      await Promise.all([refreshAccounts(), loadSummary()]);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Failed to delete account");
    } finally {
      setAccountDeletingId(null);
    }
  };

  const activeRows = activeManualTab === "assets" ? assets : liabilities;
  const isAssetForm = manualFormTab === "assets";
  const categoryLower = manualForm.category.trim().toLowerCase();
  const isVehicleAsset = isAssetForm && categoryLower === "vehicle";
  const isRealEstateAsset = isAssetForm && categoryLower === "real estate";
  const isPersonalAsset = isAssetForm && categoryLower === "personal";
  const isCreditCardLiability = !isAssetForm && categoryLower === "credit card";
  const isLoanLiability = !isAssetForm && categoryLower === "loan";
  const isMortgageLiability = !isAssetForm && categoryLower === "mortgage";

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Net Worth</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="px-3 py-2 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 hover:text-white hover:bg-[#2d2d2d] disabled:opacity-60"
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
            <MonthDropdown />
          </div>
        </div>

        {(summaryError || tableError || expensesError) && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {summaryError ?? tableError ?? expensesError}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Total Net Worth</p>
            <p className="text-2xl font-semibold text-white mt-2">
              {summaryLoading || !summary ? "Loading..." : fmtCurrency(totalNetWorth)}
            </p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Liquid Net Worth</p>
            <p className="text-2xl font-semibold text-white mt-2">
              {summaryLoading || !summary ? "Loading..." : fmtCurrency(liquidNetWorth)}
            </p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Monthly Savings Rate</p>
            <p className="text-2xl font-semibold text-white mt-2">
              {summaryLoading || !summary ? "Loading..." : `${savingsRate.toFixed(1)}%`}
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
            <h2 className="text-white font-semibold">Manual Assets & Liabilities</h2>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                onClick={() => openCreateModal(activeManualTab)}
                className="px-2.5 py-1 rounded-md bg-[#252525] border border-charcoal-dark text-white hover:bg-[#2f2f2f]"
                aria-label={`Add ${activeManualTab === "assets" ? "asset" : "liability"}`}
                title={`Add ${activeManualTab === "assets" ? "asset" : "liability"}`}
              >
                +
              </button>
              <div className="inline-flex rounded-lg border border-charcoal-dark overflow-hidden">
                <button
                  type="button"
                  onClick={() => setActiveManualTab("assets")}
                  className={`px-3 py-1.5 text-sm ${
                    activeManualTab === "assets" ? "bg-[#50C878] text-black" : "text-gray-300 bg-[#2b2b2b]"
                  }`}
                >
                  Assets
                </button>
                <button
                  type="button"
                  onClick={() => setActiveManualTab("liabilities")}
                  className={`px-3 py-1.5 text-sm ${
                    activeManualTab === "liabilities"
                      ? "bg-[#FF5C5C] text-black"
                      : "text-gray-300 bg-[#2b2b2b]"
                  }`}
                >
                  Liabilities
                </button>
              </div>
            </div>
          </div>
          <div className="p-4 overflow-x-auto">
            {tableLoading ? (
              <p className="text-sm text-gray-400">Loading data...</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                    <th className="py-2 pr-2">Name</th>
                    <th className="py-2 pr-2">Category</th>
                    <th className="py-2 pr-2">Acquired</th>
                    <th className="py-2 pr-2 text-right">Value</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-white">
                  {activeRows.map((row) => {
                    return (
                      <tr key={row.id} className="border-b border-charcoal-dark/80 odd:bg-[#2C2C2C]">
                        <td className="py-2 pr-2">{row.name}</td>
                        <td className="py-2 pr-2">{row.category}</td>
                        <td className="py-2 pr-2">{formatAcquiredDate(row.acquisition_date)}</td>
                        <td className="py-2 pr-2 text-right">{fmtCurrency(Number(row.value || 0))}</td>
                        <td className="py-2 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditModal(row, activeManualTab)}
                              className="px-3 py-1 rounded-md bg-[#3a3a3a] text-gray-200 hover:bg-[#474747]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteManualItem(row, activeManualTab)}
                              disabled={deletingId === row.id}
                              className="px-3 py-1 rounded-md bg-[#3a2a2a] text-red-300 hover:bg-[#4a3030] disabled:opacity-50"
                            >
                              {deletingId === row.id ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
              <h2 className="text-white font-semibold">Income Breakdown</h2>
            </div>
            <div className="p-4 h-[320px]">
              {expensesLoading ? (
                <p className="text-sm text-gray-400">Loading chart...</p>
              ) : incomeBreakdown.length === 0 ? (
                <p className="text-sm text-gray-400">No income entries for the selected period.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={incomeBreakdown}
                      dataKey="amount"
                      nameKey="source"
                      innerRadius={70}
                      outerRadius={110}
                      paddingAngle={2}
                    >
                      {incomeBreakdown.map((entry, index) => (
                        <Cell key={entry.source} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => fmtCurrency(Number(value))}
                      contentStyle={{
                        backgroundColor: "#2F2F2F",
                        border: "1px solid #474747",
                        borderRadius: "8px",
                        color: "#e5e7eb",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
              <h2 className="text-white font-semibold">Net Worth History (Monthly Net Change)</h2>
            </div>
            <div className="p-4 h-[320px]">
              {trendData.length === 0 ? (
                <p className="text-sm text-gray-400">No historical trend data available yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendData} margin={{ top: 6, right: 6, bottom: 6, left: 2 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" stroke="#9ca3af" tick={{ fill: "#9ca3af", fontSize: 11 }} />
                    <YAxis
                      stroke="#9ca3af"
                      tick={{ fill: "#9ca3af", fontSize: 11 }}
                      tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
                    />
                    <Tooltip
                      formatter={(value: number) => [fmtCurrency(Number(value)), "Net Change"]}
                      contentStyle={{
                        backgroundColor: "#2F2F2F",
                        border: "1px solid #474747",
                        borderRadius: "8px",
                        color: "#e5e7eb",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="sheetsNetChange"
                      stroke={PIE_COLORS[0]}
                      strokeWidth={2.5}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
              <p className="text-xs text-gray-400 mt-2">
                Income minus expenses per month (from your transaction sheet).
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Liquidity Ratio</p>
            <p className="text-xl font-semibold text-white mt-2">{liquidityRatio.toFixed(2)}x</p>
            <p className="text-xs text-gray-500 mt-1">Liquid assets / avg monthly expenses</p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Runway</p>
            <p className="text-xl font-semibold text-white mt-2">{runwayMonths.toFixed(1)} months</p>
            <p className="text-xs text-gray-500 mt-1">How long liquid net worth can cover spending</p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Current Investments</p>
            <p className="text-xl font-semibold text-white mt-2">{fmtCurrency(investmentsTotal)}</p>
            <p className="text-xs text-gray-500 mt-2">
              Brokerage-type accounts + investing-labeled assets.
            </p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Connected Account Balances</p>
            <div className="mt-2 space-y-1 text-sm">
              {visibleAccountBalances.length === 0 ? (
                <p className="text-gray-500">No linked balances yet.</p>
              ) : (
                visibleAccountBalances
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, value]) => (
                    <p key={name} className="text-gray-300">
                      {name}: <span className="text-white font-semibold">{fmtCurrency(Number(value ?? 0))}</span>
                    </p>
                  ))
              )}
            </div>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-gray-400">Goal Tracking</p>
              <input
                type="number"
                min={0}
                value={goalTarget}
                onChange={(e) => setGoalTarget(Math.max(0, Number(e.target.value) || 0))}
                className="w-28 rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-sm text-right text-white"
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Target: {fmtCurrency(goalTarget)}</p>
            <div className="w-full h-3 rounded-full bg-[#1e1e1e] mt-3 overflow-hidden">
              <div
                className="h-full bg-[#50C878]"
                style={{ width: `${Math.min(100, goalProgress)}%` }}
              />
            </div>
            <p className="text-xs text-gray-300 mt-2">
              {summary ? `${goalProgress.toFixed(1)}% complete` : "Loading progress..."}
            </p>
          </div>
        </div>

        {/* ==================== Accounts management ==================== */}
        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
            <h2 className="text-white font-semibold">Accounts</h2>
            <button
              type="button"
              onClick={openCreateAccountModal}
              className="px-2.5 py-1 rounded-md bg-[#252525] border border-charcoal-dark text-white hover:bg-[#2f2f2f]"
              aria-label="Add account"
              title="Add account"
            >
              + Add account
            </button>
          </div>
          {accountError && (
            <p className="px-4 pt-3 text-sm text-red-400">{accountError}</p>
          )}
          <div className="p-4 overflow-x-auto">
            {accounts.length === 0 ? (
              <p className="text-sm text-gray-400">
                No accounts yet. Add your bank, cash, credit, and brokerage accounts to track
                balances and reconcile statements.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                    <th className="py-2 pr-2">Name</th>
                    <th className="py-2 pr-2">Type</th>
                    <th className="py-2 pr-2 text-right">Opening Balance</th>
                    <th className="py-2 pr-2">As Of</th>
                    <th className="py-2 pr-2 text-center">Reconcile</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-white">
                  {accounts.map((account) => (
                    <tr
                      key={account.id}
                      className="border-b border-charcoal-dark/80 odd:bg-[#2C2C2C]"
                    >
                      <td className="py-2 pr-2">{account.name}</td>
                      <td className="py-2 pr-2 capitalize">{account.type}</td>
                      <td className="py-2 pr-2 text-right">
                        {fmtCurrency(Number(account.openingBalance || 0))}
                      </td>
                      <td className="py-2 pr-2">{formatAcquiredDate(account.openingBalanceDate)}</td>
                      <td className="py-2 pr-2 text-center">
                        {account.includeInReconcile ? "Yes" : "No"}
                      </td>
                      <td className="py-2 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openEditAccountModal(account)}
                            className="px-3 py-1 rounded-md bg-[#3a3a3a] text-gray-200 hover:bg-[#474747]"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteAccount(account)}
                            disabled={accountDeletingId === account.id}
                            className="px-3 py-1 rounded-md bg-[#3a2a2a] text-red-300 hover:bg-[#4a3030] disabled:opacity-50"
                          >
                            {accountDeletingId === account.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {accountModalOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/50 p-4 flex items-center justify-center"
            onClick={() => setAccountModalOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
                <h3 className="text-white font-semibold">
                  {accountFormMode === "create" ? "Add Account" : "Edit Account"}
                </h3>
                <button
                  type="button"
                  onClick={() => setAccountModalOpen(false)}
                  className="px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
                >
                  Close
                </button>
              </div>
              <div className="p-4 grid gap-3 md:grid-cols-2">
                <label className="text-sm text-gray-300 md:col-span-2">
                  Account Name
                  <input
                    value={accountForm.name}
                    onChange={(e) => setAccountForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    placeholder="Main Checking, Cash, Visa..."
                  />
                  <span className="mt-1 block text-xs text-gray-500">
                    Use the same name you reconcile under to keep statement history attached.
                  </span>
                </label>
                <label className="text-sm text-gray-300">
                  Type
                  <select
                    value={accountForm.type}
                    onChange={(e) =>
                      setAccountForm((prev) => ({ ...prev, type: e.target.value as AccountType }))
                    }
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white capitalize"
                  >
                    {ACCOUNT_TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t} className="capitalize">
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-gray-300">
                  Opening Balance
                  <input
                    value={accountForm.openingBalance}
                    onChange={(e) =>
                      setAccountForm((prev) => ({ ...prev, openingBalance: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white text-right"
                    placeholder="0.00"
                  />
                </label>
                <label className="text-sm text-gray-300">
                  As-Of Date
                  <input
                    type="date"
                    value={accountForm.openingBalanceDate}
                    onChange={(e) =>
                      setAccountForm((prev) => ({ ...prev, openingBalanceDate: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                  />
                  <span className="mt-1 block text-xs text-gray-500">
                    Only transactions after this date adjust the balance.
                  </span>
                </label>
                <label className="text-sm text-gray-300 flex items-center gap-2 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={accountForm.includeInReconcile}
                    onChange={(e) =>
                      setAccountForm((prev) => ({ ...prev, includeInReconcile: e.target.checked }))
                    }
                  />
                  Include in reconciliation (upload bank statements for this account)
                </label>
                {accountError && (
                  <p className="md:col-span-2 text-sm text-red-400">{accountError}</p>
                )}
              </div>
              <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2 bg-[#252525]">
                <button
                  type="button"
                  onClick={() => setAccountModalOpen(false)}
                  className="px-3 py-1.5 rounded-md bg-[#3a3a3a] text-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveAccountForm}
                  disabled={accountSaving}
                  className="px-3 py-1.5 rounded-md bg-[#50C878] text-black disabled:opacity-50"
                >
                  {accountSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}

        {manualModalOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/50 p-4 flex items-center justify-center"
            onClick={() => setManualModalOpen(false)}
          >
            <div
              className="w-full max-w-2xl rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
                <h3 className="text-white font-semibold">
                  {manualFormMode === "create" ? "Add" : "Edit"} {manualFormTab === "assets" ? "Asset" : "Liability"}
                </h3>
                <button
                  type="button"
                  onClick={() => setManualModalOpen(false)}
                  className="px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
                >
                  Close
                </button>
              </div>
              <div className="p-4 grid gap-3 md:grid-cols-2">
                <label className="text-sm text-gray-300">
                  Name
                  <input
                    value={manualForm.name}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    placeholder={manualFormTab === "assets" ? "Primary Residence, Toyota Camry..." : "Chase Freedom, Mortgage..."}
                  />
                </label>
                <label className="text-sm text-gray-300">
                  Category
                  <select
                    value={manualForm.category}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, category: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                  >
                    {(manualFormTab === "assets" ? ASSET_CATEGORIES : LIABILITY_CATEGORIES).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-gray-300">
                  Current Value
                  <input
                    value={manualForm.value}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, value: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white text-right"
                    placeholder="0.00"
                  />
                </label>
                <label className="text-sm text-gray-300">
                  Acquisition Date
                  <input
                    type="date"
                    value={manualForm.acquisitionDate}
                    onChange={(e) =>
                      setManualForm((prev) => ({ ...prev, acquisitionDate: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                  />
                </label>

                {isVehicleAsset && (
                  <>
                    <label className="text-sm text-gray-300">
                      Year
                      <input
                        value={manualForm.details.year ?? ""}
                        onChange={(e) => setDetailField("year", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Model
                      <input
                        value={manualForm.details.model ?? ""}
                        onChange={(e) => setDetailField("model", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Current Miles
                      <input
                        value={manualForm.details.currentMiles ?? ""}
                        onChange={(e) => setDetailField("currentMiles", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Debt Financed?
                      <select
                        value={manualForm.details.debtFinanced ?? ""}
                        onChange={(e) => setDetailField("debtFinanced", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      >
                        <option value="">Select</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    </label>
                    <label className="text-sm text-gray-300 md:col-span-2">
                      Remaining Auto Loan Balance
                      <input
                        value={manualForm.details.loanBalance ?? ""}
                        onChange={(e) => setDetailField("loanBalance", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isRealEstateAsset && (
                  <>
                    <label className="text-sm text-gray-300">
                      Property Type
                      <input
                        value={manualForm.details.propertyType ?? ""}
                        onChange={(e) => setDetailField("propertyType", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Address
                      <input
                        value={manualForm.details.address ?? ""}
                        onChange={(e) => setDetailField("address", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Sq Ft
                      <input
                        value={manualForm.details.squareFeet ?? ""}
                        onChange={(e) => setDetailField("squareFeet", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Mortgage Financed?
                      <select
                        value={manualForm.details.mortgageFinanced ?? ""}
                        onChange={(e) => setDetailField("mortgageFinanced", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      >
                        <option value="">Select</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    </label>
                    <label className="text-sm text-gray-300 md:col-span-2">
                      Remaining Mortgage Balance
                      <input
                        value={manualForm.details.mortgageBalance ?? ""}
                        onChange={(e) => setDetailField("mortgageBalance", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isPersonalAsset && (
                  <label className="text-sm text-gray-300 md:col-span-2">
                    Notes / Description
                    <input
                      value={manualForm.details.notes ?? ""}
                      onChange={(e) => setDetailField("notes", e.target.value)}
                      className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    />
                  </label>
                )}

                {!isAssetForm && (
                  <>
                    <label className="text-sm text-gray-300">
                      Lender / Issuer
                      <input
                        value={manualForm.details.lender ?? ""}
                        onChange={(e) => setDetailField("lender", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Interest Rate (%)
                      <input
                        value={manualForm.details.interestRate ?? ""}
                        onChange={(e) => setDetailField("interestRate", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Minimum Payment
                      <input
                        value={manualForm.details.minimumPayment ?? ""}
                        onChange={(e) => setDetailField("minimumPayment", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isCreditCardLiability && (
                  <>
                    <label className="text-sm text-gray-300">
                      Last 4 Digits
                      <input
                        value={manualForm.details.last4 ?? ""}
                        onChange={(e) => setDetailField("last4", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Credit Limit
                      <input
                        value={manualForm.details.creditLimit ?? ""}
                        onChange={(e) => setDetailField("creditLimit", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isLoanLiability && (
                  <>
                    <label className="text-sm text-gray-300">
                      Loan Type
                      <input
                        value={manualForm.details.loanType ?? ""}
                        onChange={(e) => setDetailField("loanType", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Term (months)
                      <input
                        value={manualForm.details.termMonths ?? ""}
                        onChange={(e) => setDetailField("termMonths", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isMortgageLiability && (
                  <label className="text-sm text-gray-300 md:col-span-2">
                    Property Address
                    <input
                      value={manualForm.details.propertyAddress ?? ""}
                      onChange={(e) => setDetailField("propertyAddress", e.target.value)}
                      className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    />
                  </label>
                )}
              </div>
              <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2 bg-[#252525]">
                <button
                  type="button"
                  onClick={() => setManualModalOpen(false)}
                  className="px-3 py-1.5 rounded-md bg-[#3a3a3a] text-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveManualForm}
                  disabled={Boolean(savingRow)}
                  className="px-3 py-1.5 rounded-md bg-[#50C878] text-black disabled:opacity-50"
                >
                  {savingRow ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
