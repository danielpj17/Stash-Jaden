"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { X, Save, PlusCircle, Loader2, Plus, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import MonthDropdown from "@/components/MonthDropdown";
import GlassDropdown from "@/components/GlassDropdown";
import { useMonth } from "@/contexts/MonthContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { useExpensesData } from "@/contexts/ExpensesDataContext";
import { rowMatchesMonth, transferMatchesMonth, submitTransfer } from "@/services/sheetsApi";
import type { SheetRow } from "@/services/sheetsApi";
import { getLatestSnaptradeBalances, refreshSnaptradeBalances } from "@/services/snaptradeApi";
import type { SupportedBroker, RefreshSnaptradeBalancesResponse } from "@/services/snaptradeApi";
import {
  EXPENSE_CATEGORIES,
  CATEGORY_COLORS,
  BUDGET_STORAGE_KEY,
  LEGACY_EXPENSE_CATEGORY_ALIASES,
  normalizeExpenseCategoryType,
} from "@/lib/constants";
import { migrateBudgetCategoryKeys } from "@/lib/budgetCategoryMigration";
import {
  computeAccountBalances,
  getAccountAnchors,
  type AccountAnchor,
} from "@/services/accountBalancesService";
import {
  PieChart,
  Pie,
  Cell,
  Sector,
  ResponsiveContainer,
  Tooltip,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

/* ------------------------------------------------------------------ */
/*  Budget: resolve display goals (copy from previous month if unset)   */
/* ------------------------------------------------------------------ */

type MonthlyBudgets = Record<string, Record<string, number>>;

function resolveBudgetForMonth(
  month: string,
  allBudgets: MonthlyBudgets | null,
  visited: Set<string> = new Set()
): Record<string, number> {
  const zeros: Record<string, number> = {};
  EXPENSE_CATEGORIES.forEach((cat) => (zeros[cat] = 0));
  if (!allBudgets || typeof allBudgets !== "object") return zeros;

  if (month === "full") {
    const totals: Record<string, number> = {};
    EXPENSE_CATEGORIES.forEach((cat) => (totals[cat] = 0));
    for (let m = 1; m <= 12; m++) {
      const md = allBudgets[String(m)] ?? {};
      EXPENSE_CATEGORIES.forEach((cat) => {
        totals[cat] += md[cat] ?? 0;
      });
    }
    return totals;
  }

  if (visited.has(month)) return zeros;
  visited.add(month);

  const md = allBudgets[month];
  if (md !== undefined && md !== null && typeof md === "object") {
    const result: Record<string, number> = {};
    EXPENSE_CATEGORIES.forEach((cat) => {
      result[cat] = md[cat] ?? 0;
    });
    return result;
  }

  const prevMonth = month === "1" ? "12" : String(Number(month) - 1);
  return resolveBudgetForMonth(prevMonth, allBudgets, visited);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildExpenseTotals(rows: SheetRow[]): { category: string; total: number }[] {
  const byCategory: Record<string, number> = {};
  EXPENSE_CATEGORIES.forEach((cat) => (byCategory[cat] = 0));
  rows.forEach((r) => {
    const cat = normalizeExpenseCategoryType(r.expenseType);
    if (cat !== "Income" && byCategory[cat] !== undefined) {
      byCategory[cat] += r.amount;
    }
  });
  return EXPENSE_CATEGORIES.map((cat) => ({
    category: cat,
    total: byCategory[cat] ?? 0,
  }));
}

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function getProgressColor(pct: number): string {
  const green: [number, number, number] = [80, 200, 120]; // #50C878
  const yellow: [number, number, number] = [242, 192, 55]; // #F2C037
  const red: [number, number, number] = [255, 92, 92]; // #FF5C5C

  if (pct <= 50) return lerpColor(green, green, 0); // solid green up to 50%
  if (pct < 75) return lerpColor(green, yellow, (pct - 50) / 25); // green -> yellow (50%-75%)
  if (pct < 100) return lerpColor(yellow, red, (pct - 75) / 25); // yellow -> red (75%-100%)
  return lerpColor(red, red, 0); // full red at/over 100%
}

function formatDateMMDDYY(timestamp?: string): string {
  if (!timestamp) return "\u2014";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" });
}

function formatDateTimeMMDDYYHM(timestamp?: string): string {
  if (!timestamp) return "\u2014";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

type DailyPoint = { label: string; amount: number };

function getWeekStartDate(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatWeekLabel(weekStart: Date): string {
  return `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDaysInSelectedMonth(selectedMonth: string): number[] {
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return [];
  const year = 2026;
  const lastDay = new Date(year, monthNum, 0).getDate();
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === monthNum;
  const endDay = isCurrentMonth ? Math.min(now.getDate(), lastDay) : lastDay;
  const days: number[] = [];
  for (let d = 1; d <= endDay; d++) days.push(d);
  return days;
}

function buildDailyExpenses(rows: SheetRow[], selectedMonth: string): DailyPoint[] {
  const expenses = rows.filter((r) => r.expenseType !== "Income");
  const isFull = selectedMonth === "full";

  if (isFull) {
    if (expenses.length === 0) return [];
    const byKey: Record<string, number> = {};
    expenses.forEach((r) => {
      if (!r.timestamp) return;
      const d = new Date(r.timestamp);
      if (Number.isNaN(d.getTime())) return;
      const key = formatLocalDateKey(getWeekStartDate(d));
      byKey[key] = (byKey[key] ?? 0) + r.amount;
    });
    const entries = Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, amount]) => ({
      label: formatWeekLabel(new Date(`${key}T00:00:00`)),
      amount,
    }));
  }

  const byKey: Record<string, number> = {};
  expenses.forEach((r) => {
    if (!r.timestamp) return;
    const d = new Date(r.timestamp);
    if (Number.isNaN(d.getTime())) return;
    const key = String(d.getDate());
    byKey[key] = (byKey[key] ?? 0) + r.amount;
  });
  const days = getDaysInSelectedMonth(selectedMonth);
  return days.map((day) => ({
    label: String(day),
    amount: byKey[String(day)] ?? 0,
  }));
}

function buildDailyIncome(rows: SheetRow[], selectedMonth: string): DailyPoint[] {
  const income = rows.filter((r) => r.expenseType === "Income");
  const isFull = selectedMonth === "full";

  if (isFull) {
    if (income.length === 0) return [];
    const byKey: Record<string, number> = {};
    income.forEach((r) => {
      if (!r.timestamp) return;
      const d = new Date(r.timestamp);
      if (Number.isNaN(d.getTime())) return;
      const key = formatLocalDateKey(getWeekStartDate(d));
      byKey[key] = (byKey[key] ?? 0) + r.amount;
    });
    const entries = Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, amount]) => ({
      label: formatWeekLabel(new Date(`${key}T00:00:00`)),
      amount,
    }));
  }

  const byKey: Record<string, number> = {};
  income.forEach((r) => {
    if (!r.timestamp) return;
    const d = new Date(r.timestamp);
    if (Number.isNaN(d.getTime())) return;
    const key = String(d.getDate());
    byKey[key] = (byKey[key] ?? 0) + r.amount;
  });
  const days = getDaysInSelectedMonth(selectedMonth);
  return days.map((day) => ({
    label: String(day),
    amount: byKey[String(day)] ?? 0,
  }));
}

function toCumulative(points: DailyPoint[]): DailyPoint[] {
  let sum = 0;
  return points.map(({ label, amount }) => {
    sum += amount;
    return { label, amount: sum };
  });
}

const fmtDollars = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chartMargin = { top: 6, right: 6, bottom: 6, left: 2 };

const TRANSFER_FROM_OPTIONS = [
  "WF Checking",
  "WF Savings",
  "Venmo - Daniel",
  "Venmo - Katie",
  "Fidelity",
  "Robinhood",
  "My529",
  "Charles Schwab",
  "Ally",
  "Capital One",
  "America First",
  "Discover",
  "Parents",
  "Cash",
] as const;

const TRANSFER_TO_OPTIONS = [
  "WF Checking",
  "WF Savings",
  "Venmo - Daniel",
  "Venmo - Katie",
  "Fidelity",
  "Robinhood",
  "My529",
  "Charles Schwab",
  "Ally",
  "Capital One",
  "America First",
  "Discover",
  "Cash",
  "Misc.",
] as const;

const TRANSFER_FROM_DROPDOWN_OPTIONS = TRANSFER_FROM_OPTIONS.map((opt) => ({
  value: opt,
  label: opt,
}));
const TRANSFER_TO_DROPDOWN_OPTIONS = TRANSFER_TO_OPTIONS.map((opt) => ({
  value: opt,
  label: opt,
}));

const gridStroke = "rgba(255,255,255,0.06)";
const axisStroke = "#9ca3af";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

type PieSlice = { category: string; value: number; isOverBudget: boolean };

export default function BudgetPage() {
  const { selectedMonth, selectedLabel } = useMonth();
  const { refreshKey, triggerRefresh } = useRefresh();
  const { allRows, allTransfers, loading, error } = useExpensesData();

  const [allBudgets, setAllBudgets] = useState<MonthlyBudgets | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [editBudgetValue, setEditBudgetValue] = useState("");
  const [activePieIndex, setActivePieIndex] = useState<number | null>(null);

  const [incomeCardMode, setIncomeCardMode] = useState<"income" | "transfers">("income");
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [tfFrom, setTfFrom] = useState("");
  const [tfTo, setTfTo] = useState("");
  const [tfAmount, setTfAmount] = useState("");
  const [tfStatus, setTfStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [tfError, setTfError] = useState("");
  const [liveBrokerBalances, setLiveBrokerBalances] = useState<Partial<Record<SupportedBroker, number>>>({});
  const [accountAnchors, setAccountAnchors] = useState<AccountAnchor[]>([]);
  const [balancesFetchedAt, setBalancesFetchedAt] = useState<string | null>(null);
  const [balancesRefreshStatus, setBalancesRefreshStatus] = useState<"idle" | "refreshing" | "error">("idle");
  const [balancesRefreshError, setBalancesRefreshError] = useState("");

  const rows = useMemo(
    () => allRows.filter((r) => rowMatchesMonth(r, selectedMonth)),
    [allRows, selectedMonth]
  );
  const transfers = useMemo(
    () => allTransfers.filter((t) => transferMatchesMonth(t, selectedMonth)),
    [allTransfers, selectedMonth]
  );

  const budgetGoals = useMemo(
    () => resolveBudgetForMonth(selectedMonth, allBudgets),
    [selectedMonth, allBudgets]
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/budget", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        // A failed GET (e.g. Neon cold-start/hiccup) returns { error } with a non-2xx
        // status. Never treat that as real budget data: keep allBudgets null so the
        // page stays in an "unloaded" state and saving is blocked — otherwise the next
        // save would overwrite the stored budgets with an empty/zeroed object.
        const loadFailed =
          !response.ok ||
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          "error" in (data as Record<string, unknown>);
        if (loadFailed) {
          setAllBudgets(null);
          const errMsg = (data as { error?: unknown } | null)?.error;
          setBudgetError(
            typeof errMsg === "string"
              ? `Couldn't load saved budgets: ${errMsg}`
              : "Couldn't load saved budgets. Refresh before editing — saving now would overwrite them."
          );
          return;
        }
        const isEmpty = Object.keys(data).length === 0;
        if (isEmpty && typeof window !== "undefined") {
          try {
            const raw = localStorage.getItem(BUDGET_STORAGE_KEY);
            if (raw) {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const isOldFlat = Object.keys(parsed).length > 0 && EXPENSE_CATEGORIES.some((cat) => typeof parsed[cat] === "number");
              let toSave: MonthlyBudgets;
              if (isOldFlat) {
                const goals: Record<string, number> = {};
                EXPENSE_CATEGORIES.forEach((cat) => {
                  const v = parsed[cat];
                  if (typeof v === "number") goals[cat] = v;
                });
                for (const [oldName, newName] of Object.entries(LEGACY_EXPENSE_CATEGORY_ALIASES)) {
                  const v = parsed[oldName];
                  if (typeof v === "number") {
                    goals[newName] = (goals[newName] ?? 0) + v;
                  }
                }
                toSave = {};
                for (let m = 1; m <= 12; m++) toSave[String(m)] = { ...goals };
              } else {
                toSave = migrateBudgetCategoryKeys(parsed as MonthlyBudgets);
              }
              const res = await fetch("/api/budget", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(toSave),
              });
              if (res.ok) {
                localStorage.removeItem(BUDGET_STORAGE_KEY);
                const saved = (await res.json()) as MonthlyBudgets;
                if (!cancelled) setAllBudgets(saved);
                return;
              }
            }
          } catch {
            /* ignore migration errors */
          }
        }
        if (!cancelled) {
          setAllBudgets(data as MonthlyBudgets);
          setBudgetError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAllBudgets(null);
          setBudgetError(
            "Couldn't load saved budgets. Refresh before editing — saving now would overwrite them."
          );
        }
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    getLatestSnaptradeBalances()
      .then((data: RefreshSnaptradeBalancesResponse) => {
        if (cancelled) return;
        setLiveBrokerBalances(data.balances);
        setBalancesFetchedAt(data.fetchedAt);
      })
      .catch(() => {
        /* keep last local values */
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    getAccountAnchors()
      .then((anchors) => {
        if (cancelled) return;
        setAccountAnchors(anchors);
      })
      .catch(() => {
        if (cancelled) return;
        setAccountAnchors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedCategory) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedCategory(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedCategory]);

  /* ---------- derived data ---------- */

  const expenseData = useMemo(() => buildExpenseTotals(rows), [rows]);
  const expenseTotal = expenseData.reduce((s, r) => s + r.total, 0);
  const totalBudget = EXPENSE_CATEGORIES.reduce((s, cat) => s + (budgetGoals[cat] ?? 0), 0);
  const incomeTransactions = useMemo(() => {
    return rows
      .filter((r) => r.expenseType === "Income")
      .sort((a, b) => {
        const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tB - tA;
      });
  }, [rows]);
  const incomeTotal = incomeTransactions.reduce((sum, r) => sum + r.amount, 0);

  const sortedTransfers = useMemo(() => {
    return [...transfers].sort((a, b) => {
      const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tB - tA;
    });
  }, [transfers]);
  const transfersTotal = sortedTransfers.reduce((sum, r) => sum + r.amount, 0);

  const categoryTransactions = useMemo(() => {
    if (!selectedCategory) return [];
    return rows
      .filter((r) => normalizeExpenseCategoryType(r.expenseType) === selectedCategory)
      .sort((a, b) => {
        const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tB - tA;
      });
  }, [rows, selectedCategory]);

  const budgetPieData: PieSlice[] = useMemo(() => {
    if (totalBudget <= 0) return [];
    return expenseData
      .filter((d) => d.total > 0)
      .map((d) => {
        const catBudget = budgetGoals[d.category] ?? 0;
        return {
          category: d.category,
          value: d.total,
          isOverBudget: catBudget > 0 && d.total > catBudget,
        };
      });
  }, [expenseData, totalBudget, budgetGoals]);

  const legendData = useMemo(() => {
    if (totalBudget <= 0) return [];
    return budgetPieData.map((d) => ({
      ...d,
      pct: (d.value / totalBudget) * 100,
    }));
  }, [budgetPieData, totalBudget]);

  const legendTableData = useMemo(() => {
    return EXPENSE_CATEGORIES.map((cat) => {
      const value = expenseData.find((d) => d.category === cat)?.total ?? 0;
      const catBudget = budgetGoals[cat] ?? 0;
      const pct = totalBudget > 0 ? (value / totalBudget) * 100 : 0;
      return {
        category: cat,
        value,
        pct,
        isOverBudget: catBudget > 0 && value > catBudget,
      };
    });
  }, [expenseData, totalBudget, budgetGoals]);

  const pieChartData = useMemo(() => {
    if (totalBudget <= 0) return [];
    const spentValue = budgetPieData.reduce((sum, d) => sum + d.value, 0);
    const remainingValue = Math.max(totalBudget - spentValue, 0);
    if (remainingValue <= 0) return budgetPieData;
    return [
      ...budgetPieData,
      { category: "__blank__", value: remainingValue, isOverBudget: false },
    ];
  }, [budgetPieData, totalBudget]);
  const dailyExpenses = useMemo(
    () => toCumulative(buildDailyExpenses(rows, selectedMonth)),
    [rows, selectedMonth]
  );
  const dailyIncome = useMemo(
    () => toCumulative(buildDailyIncome(rows, selectedMonth)),
    [rows, selectedMonth]
  );

  const accountBalances = useMemo(() => {
    return computeAccountBalances(allRows, allTransfers, liveBrokerBalances, accountAnchors);
  }, [allRows, allTransfers, liveBrokerBalances, accountAnchors]);

  const visibleAccountBalances = useMemo(() => {
    return Object.entries(accountBalances).filter(
      ([, balance]) => Math.abs(balance) >= 0.005
    );
  }, [accountBalances]);

  /* ---------- actions ---------- */

  const openCategory = useCallback((cat: string) => {
    setSelectedCategory(cat);
    setEditBudgetValue(String(budgetGoals[cat] ?? 0));
  }, [budgetGoals]);

  const handleSaveBudget = useCallback(async () => {
    if (!selectedCategory || selectedMonth === "full") return;
    // Saving replaces the ENTIRE budget store in Neon. If budgets haven't finished
    // loading (null) we don't have the other months/categories in memory, so writing
    // now would wipe them. Refuse and tell the user to refresh.
    if (allBudgets === null) {
      setBudgetError(
        "Budgets haven't loaded yet. Refresh the page before editing to avoid overwriting your saved budgets."
      );
      return;
    }
    const num = parseFloat(editBudgetValue.replace(/,/g, ""));
    const amount = Number.isNaN(num) ? 0 : num;
    const base = allBudgets ?? {};
    // Seed from carry-forward (same as display) so we don't persist zeros for categories the user never edited.
    const monthData = { ...resolveBudgetForMonth(selectedMonth, allBudgets) };
    monthData[selectedCategory] = amount;
    const next: MonthlyBudgets = { ...base, [selectedMonth]: monthData };
    try {
      const res = await fetch("/api/budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body?.error === "string"
            ? body.error
            : `Save failed (${res.status}). Check Vercel logs if deployed.`;
        setBudgetError(msg);
        return;
      }
      setAllBudgets((body as MonthlyBudgets) ?? next);
      setBudgetError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save budget. Try again.";
      setBudgetError(msg);
    }
  }, [selectedCategory, selectedMonth, editBudgetValue, allBudgets]);

  const handleSubmitTransfer = useCallback(async () => {
    const num = parseFloat(tfAmount.replace(/,/g, ""));
    if (!tfFrom.trim() || !tfTo.trim() || Number.isNaN(num) || num <= 0) {
      setTfStatus("error");
      setTfError("Choose from and to accounts and enter a valid amount.");
      return;
    }
    setTfStatus("submitting");
    setTfError("");
    try {
      await submitTransfer({
        transferFrom: tfFrom.trim(),
        transferTo: tfTo.trim(),
        amount: num,
      });
      setTfFrom("");
      setTfTo("");
      setTfAmount("");
      setTfStatus("idle");
      setShowTransferForm(false);
      triggerRefresh();
    } catch (err) {
      setTfStatus("error");
      setTfError(err instanceof Error ? err.message : "Failed to submit transfer.");
    }
  }, [tfFrom, tfTo, tfAmount, triggerRefresh]);

  const handleRefreshAccountBalances = useCallback(async () => {
    setBalancesRefreshStatus("refreshing");
    setBalancesRefreshError("");
    try {
      const data = await refreshSnaptradeBalances();
      setLiveBrokerBalances(data.balances);
      setBalancesFetchedAt(data.fetchedAt);
      triggerRefresh();
      setBalancesRefreshStatus("idle");
    } catch (err) {
      setBalancesRefreshStatus("error");
      setBalancesRefreshError(
        err instanceof Error ? err.message : "Failed to refresh account balances."
      );
    }
  }, [triggerRefresh]);

  /* ---------- render ---------- */

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[40vh] text-gray-400">Preparing Budget</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Budget</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/new-expense"
              className="p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors"
              aria-label="New expense"
            >
              <PlusCircle className="w-6 h-6" />
            </Link>
            <MonthDropdown />
          </div>
        </div>

        {(budgetError || error) && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {budgetError ?? error}
            {!(budgetError ?? error)?.includes("NEXT_PUBLIC") && (
              <span className="block mt-1 text-gray-400">Showing empty data until the connection works.</span>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          {/* Left column: Budget on top of Income */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Budget</h2>
                <span className="text-sm font-semibold text-white whitespace-nowrap">
                  {fmtDollars(expenseTotal)}{" "}
                  <span className="text-gray-400 font-normal">/</span>{" "}
                  {fmtDollars(totalBudget)}
                </span>
              </div>

              <div className="p-3 flex-1 min-h-0 bg-[#252525]">
                {totalBudget <= 0 && (
                  <p className="text-gray-400 text-sm py-2 text-center mb-2">
                    No budget set for this month. Click a category to set one.
                  </p>
                )}

                <div className="flex items-center gap-2 px-2 pb-2 text-gray-500 text-[11px] font-medium uppercase tracking-wide border-b border-charcoal-dark">
                  <span className="w-[88px] min-w-0 truncate">Category</span>
                  <span className="w-[68px] shrink-0 text-right">Spent</span>
                  <span className="flex-1 min-w-0" />
                  <span className="w-[72px] shrink-0 text-right">Budgeted</span>
                </div>

                <div className="-mx-0">
                  {[...expenseData]
                    .sort((a, b) => a.category.localeCompare(b.category))
                    .map((row, index) => {
                    const budget = budgetGoals[row.category] ?? 0;
                    const pct =
                      budget > 0
                        ? (row.total / budget) * 100
                        : row.total > 0
                          ? 100
                          : 0;
                    const barColor = getProgressColor(pct);
                    const barWidth = Math.min(pct, 100);

                    return (
                      <button
                        type="button"
                        key={row.category}
                        onClick={() => openCategory(row.category)}
                        className={`relative w-full flex items-center gap-2 text-white px-2 py-[7px] text-left cursor-pointer hover:bg-[#333] transition-colors text-sm ${
                          index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"
                        }`}
                      >
                        <span className="w-[88px] min-w-0 text-gray-300 truncate">{row.category}</span>
                        <span className="w-[68px] shrink-0 text-right text-gray-200 tabular-nums text-xs">
                          {fmtDollars(row.total)}
                        </span>
                        <span className="flex-1 min-w-0 mx-1" />
                        <span className="w-[72px] shrink-0 text-right text-gray-400 tabular-nums text-xs">
                          {fmtDollars(budget)}
                        </span>
                        <span className="absolute inset-x-2 bottom-1 h-0.5 rounded-full bg-[#1a1a1a] overflow-hidden">
                          <span
                            className="block h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${barWidth}%`,
                              backgroundColor: barColor,
                            }}
                          />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setIncomeCardMode("income")}
                    className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                      incomeCardMode === "income"
                        ? "bg-[#252525] text-white"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    Income
                  </button>
                  <button
                    type="button"
                    onClick={() => setIncomeCardMode("transfers")}
                    className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                      incomeCardMode === "transfers"
                        ? "bg-[#252525] text-white"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    Transfers
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {incomeCardMode === "transfers" && (
                    <button
                      type="button"
                      onClick={() => setShowTransferForm((v) => !v)}
                      className="p-1 rounded-md text-gray-400 hover:text-[#50C878] hover:bg-[#252525] transition-colors"
                      aria-label="Add transfer"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  )}
                  <span className="text-sm font-semibold text-white whitespace-nowrap">
                    Total: {fmtDollars(incomeCardMode === "income" ? incomeTotal : transfersTotal)}
                  </span>
                </div>
              </div>
              <div className="p-4 flex-1 min-h-0 bg-[#252525]">
                {incomeCardMode === "income" ? (
                  <div className="min-h-[180px] text-sm -mx-2">
                    {incomeTransactions.length === 0 ? (
                      <p className="text-gray-400 px-2 py-2">No income entries for this period.</p>
                    ) : (
                      incomeTransactions.map((row, index) => (
                        <div
                          key={`${row.timestamp ?? index}-${row.amount}-${row.description}`}
                          className={`flex justify-between items-baseline gap-3 text-white px-2 py-1.5 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="text-gray-200">{row.description.trim() || "Income"}</span>
                            <span className="text-gray-500 text-xs ml-2 shrink-0">{formatDateMMDDYY(row.timestamp)}</span>
                          </span>
                          <span className="text-right shrink-0">
                            {fmtDollars(row.amount)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="min-h-[180px] text-sm -mx-2">
                    {showTransferForm && (
                      <div className="mx-2 mb-3 p-3 rounded-lg bg-[#1e1e1e] border border-charcoal-dark space-y-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <GlassDropdown
                            value={tfFrom}
                            onChange={setTfFrom}
                            options={TRANSFER_FROM_DROPDOWN_OPTIONS}
                            placeholder="From…"
                            className="flex-1 min-w-0"
                            aria-label="Transfer from"
                          />
                          <GlassDropdown
                            value={tfTo}
                            onChange={setTfTo}
                            options={TRANSFER_TO_DROPDOWN_OPTIONS}
                            placeholder="To…"
                            className="flex-1 min-w-0"
                            aria-label="Transfer to"
                          />
                          <input
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            value={tfAmount}
                            onChange={(e) => setTfAmount(e.target.value)}
                            placeholder="Amount"
                            className="w-full sm:w-28 shrink-0 px-2.5 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none tabular-nums"
                          />
                        </div>
                        {tfStatus === "error" && (
                          <p className="text-xs text-red-400">{tfError}</p>
                        )}
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handleSubmitTransfer}
                            disabled={tfStatus === "submitting"}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-50 transition-colors"
                          >
                            {tfStatus === "submitting" ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5" />
                            )}
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowTransferForm(false);
                              setTfStatus("idle");
                              setTfError("");
                              setTfFrom("");
                              setTfTo("");
                              setTfAmount("");
                            }}
                            className="px-3 py-1.5 rounded-lg text-gray-400 text-sm hover:text-white transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {sortedTransfers.length === 0 ? (
                      <p className="text-gray-400 px-2 py-2">No transfers for this period.</p>
                    ) : (
                      sortedTransfers.map((row, index) => {
                        const from = row.transferFrom.trim() || "—";
                        const to = row.transferTo.trim() || "—";
                        const legacy = row.description?.trim();
                        return (
                        <div
                          key={`${row.timestamp ?? index}-${row.amount}-${from}-${to || legacy || ""}`}
                          className={`flex justify-between items-baseline gap-3 text-white px-2 py-1.5 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="text-gray-200 inline-flex items-center gap-1.5">
                              <span>{from}</span>
                              <span className="text-gray-500">→</span>
                              <span>{to}</span>
                            </span>
                            {legacy && (
                              <span className="text-gray-500 text-xs ml-2">({legacy})</span>
                            )}
                            <span className="text-gray-500 text-xs ml-2 shrink-0">{formatDateMMDDYY(row.timestamp)}</span>
                          </span>
                          <span className="text-right shrink-0">
                            {fmtDollars(row.amount)}
                          </span>
                        </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Middle column: Budget Usage pie */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Budget Usage &mdash; {selectedLabel}</h2>
                {totalBudget > 0 && (
                  <span className="text-sm font-semibold text-white whitespace-nowrap tabular-nums">
                    {((expenseTotal / totalBudget) * 100).toFixed(1)}%
                  </span>
                )}
              </div>

              <div className="p-2 flex-1 min-h-0 bg-[#252525]">
                {totalBudget <= 0 ? (
                  <div className="flex items-center justify-center h-56 text-gray-400 text-sm">
                    Set a budget to see the chart.
                  </div>
                ) : (
                  <div onMouseLeave={() => setActivePieIndex(null)}>
                    <div className="h-56 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <Pie
                            data={pieChartData}
                            dataKey="value"
                            nameKey="category"
                            cx="50%"
                            cy="50%"
                            innerRadius="62%"
                            outerRadius="88%"
                            paddingAngle={2}
                            startAngle={90}
                            endAngle={-270}
                            activeIndex={activePieIndex ?? undefined}
                            onMouseEnter={(_d, i) => {
                              const row = pieChartData[i];
                              setActivePieIndex(row?.category === "__blank__" ? null : i);
                            }}
                            onMouseLeave={() => setActivePieIndex(null)}
                            style={{ outline: "none" }}
                            activeShape={(props: unknown) => {
                              const p = props as React.ComponentProps<typeof Sector> & {
                                style?: React.CSSProperties;
                                payload?: PieSlice;
                              };
                              const isBlank = p.payload?.category === "__blank__";
                              return (
                                <Sector
                                  {...p}
                                  stroke={isBlank ? "none" : "white"}
                                  strokeWidth={isBlank ? 0 : 2}
                                  style={{ ...p.style, outline: "none" }}
                                />
                              );
                            }}
                            inactiveShape={(props: unknown) => {
                              const p = props as React.ComponentProps<typeof Sector> & {
                                style?: React.CSSProperties;
                              };
                              return <Sector {...p} stroke="none" style={{ ...p.style, opacity: 0.45, outline: "none" }} />;
                            }}
                          >
                            {pieChartData.map((slice) => {
                              if (slice.category === "__blank__") {
                                return (
                                  <Cell
                                    key="__blank__"
                                    fill="rgba(0,0,0,0)"
                                    stroke="none"
                                    style={{ outline: "none" }}
                                  />
                                );
                              }
                              const color = CATEGORY_COLORS[slice.category] ?? "#888";
                              return (
                                <Cell
                                  key={slice.category}
                                  fill={color}
                                  stroke="white"
                                  strokeWidth={1}
                                  style={{ outline: "none" }}
                                />
                              );
                            })}
                          </Pie>
                          <Tooltip
                            active={activePieIndex !== null}
                            content={() => {
                              if (activePieIndex == null || totalBudget <= 0) return null;
                              const slice = pieChartData[activePieIndex];
                              if (!slice || slice.category === "__blank__") return null;
                              const pct = (slice.value / totalBudget) * 100;
                              return (
                                <div
                                  style={{
                                    backgroundColor: "#282828",
                                    border: "1px solid #333333",
                                    borderRadius: "8px",
                                    color: "#e5e7eb",
                                    padding: "8px 12px",
                                  }}
                                >
                                  {slice.category}: {fmtDollars(slice.value)} ({pct.toFixed(1)}%)
                                </div>
                              );
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="mt-3 overflow-x-auto -mx-2">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                            <th className="pb-1.5 pr-2 pl-2">Category</th>
                            <th className="pb-1.5 text-right pr-2">% of Budget</th>
                          </tr>
                        </thead>
                        <tbody className="text-white">
                          {[...legendTableData]
                            .sort((a, b) => b.pct - a.pct)
                            .map((row) => (
                              <tr key={row.category} className="border-b border-charcoal-dark/80 odd:bg-[#2C2C2C]">
                                <td className="py-1.5 pr-2 pl-2 text-gray-200">
                                  <span
                                    className="inline-block w-3 h-3 rounded-sm shrink-0 mr-2 align-middle"
                                    style={{
                                      backgroundColor: CATEGORY_COLORS[row.category] ?? "#888",
                                    }}
                                    aria-hidden
                                  />
                                  {row.category}
                                </td>
                                <td className="py-1.5 text-right pr-2 tabular-nums">
                                  {row.pct.toFixed(1)}%
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right column: Expenses over month on top of Income over month */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">
                  Expenses: {selectedLabel}
                </h2>
              </div>
              <div className="pt-2 pr-4 pb-2 pl-0 flex-1 min-h-[260px] min-w-0 bg-[#252525] flex flex-col">
                {dailyExpenses.length === 0 ? (
                  <p className="text-gray-400 text-sm flex items-center justify-center h-full">No expense data for this period.</p>
                ) : (
                  <div className="flex-1 min-h-0 w-full -ml-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyExpenses} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                        <XAxis dataKey="label" stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} />
                        <YAxis stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                        <Tooltip
                          formatter={(value: number) => [`$${Number(value).toLocaleString()}`, "Cumulative"]}
                          contentStyle={{
                            backgroundColor: "#2F2F2F",
                            border: "1px solid #474747",
                            borderRadius: "8px",
                            color: "#e5e7eb",
                          }}
                          labelStyle={{ color: "#CCCCCC" }}
                        />
                        <Line type="stepAfter" dataKey="amount" stroke="#4EA8FF" strokeWidth={2} dot={false} name="Expenses" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">
                  Income: {selectedLabel}
                </h2>
              </div>
              <div className="pt-2 pr-4 pb-2 pl-0 flex-1 min-h-[260px] min-w-0 bg-[#252525] flex flex-col">
                {dailyIncome.length === 0 ? (
                  <p className="text-gray-400 text-sm flex items-center justify-center h-full">No income data for this period.</p>
                ) : (
                  <div className="flex-1 min-h-0 w-full -ml-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyIncome} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                        <XAxis dataKey="label" stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} />
                        <YAxis stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                        <Tooltip
                          formatter={(value: number) => [`$${Number(value).toLocaleString()}`, "Cumulative"]}
                          contentStyle={{
                            backgroundColor: "#2F2F2F",
                            border: "1px solid #474747",
                            borderRadius: "8px",
                            color: "#e5e7eb",
                          }}
                          labelStyle={{ color: "#CCCCCC" }}
                        />
                        <Line type="stepAfter" dataKey="amount" stroke="#50C878" strokeWidth={2} dot={false} name="Income" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Account Balances</h2>
                <div className="flex items-center gap-2">
                  {balancesFetchedAt && (
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      Updated {formatDateTimeMMDDYYHM(balancesFetchedAt)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleRefreshAccountBalances}
                    disabled={balancesRefreshStatus === "refreshing"}
                    className="p-1.5 rounded-md text-gray-400 hover:text-[#50C878] hover:bg-[#252525] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Refresh account balances"
                    title="Refresh account balances"
                  >
                    {balancesRefreshStatus === "refreshing" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
              <div className="p-3 flex-1 min-h-0 bg-[#252525]">
                <div className="overflow-x-auto -mx-2">
                  {balancesRefreshStatus === "error" && (
                    <p className="text-red-400 text-xs px-2 pb-2">{balancesRefreshError}</p>
                  )}
                  {visibleAccountBalances.length === 0 ? (
                    <p className="text-gray-400 text-sm px-2 py-2">No accounts with a non-zero balance.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                          <th className="pb-1.5 pr-2 pl-2">Account</th>
                          <th className="pb-1.5 text-right pr-2">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="text-white">
                        {visibleAccountBalances.map(([name, balance], index) => (
                          <tr
                            key={name}
                            className={`border-b border-charcoal-dark/80 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}
                          >
                            <td className="py-1.5 pr-2 pl-2 text-gray-200">{name}</td>
                            <td
                              className={`py-1.5 text-right pr-2 tabular-nums ${
                                balance < 0 ? "text-red-400" : ""
                              }`}
                            >
                              {balance < 0 ? `(${fmtDollars(Math.abs(balance))})` : fmtDollars(balance)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ==================== Category detail modal ==================== */}
        {selectedCategory && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setSelectedCategory(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="budget-modal-title"
          >
            <div
              className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col w-full max-w-lg max-h-[80vh] shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3 shrink-0">
                <h2 id="budget-modal-title" className="text-white font-semibold truncate">
                  {selectedCategory}
                  <span className="ml-2 font-medium text-gray-300">
                    &mdash; Spent: {fmtDollars(expenseData.find((d) => d.category === selectedCategory)?.total ?? 0)}
                    {" "}
                    / Budget: {fmtDollars(budgetGoals[selectedCategory] ?? 0)}
                  </span>
                </h2>
                <button
                  type="button"
                  onClick={() => setSelectedCategory(null)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-charcoal transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 flex-1 min-h-0 overflow-y-auto">
                {/* Budget edit row (only for single months, not "Full Year") */}
                {selectedMonth !== "full" && (
                  <div className="flex items-center gap-2 mb-4 pb-4 border-b border-charcoal-dark">
                    <label htmlFor="modal-budget-input" className="text-sm text-gray-300 shrink-0">
                      Monthly budget:
                    </label>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-gray-400">$</span>
                      <input
                        id="modal-budget-input"
                        type="text"
                        inputMode="decimal"
                        value={editBudgetValue}
                        onChange={(e) => setEditBudgetValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSaveBudget(); }}
                        disabled={allBudgets === null}
                        className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                      <button
                        type="button"
                        onClick={handleSaveBudget}
                        disabled={allBudgets === null}
                        title={allBudgets === null ? "Budgets are still loading — refresh before editing" : undefined}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {/* Transactions list */}
                <div className="text-sm -mx-2">
                  <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wide px-2 mb-2">
                    Transactions
                  </h3>
                  {categoryTransactions.length === 0 ? (
                    <p className="text-gray-400 px-2 py-2">No transactions in this category for this period.</p>
                  ) : (
                    categoryTransactions.map((row, index) => (
                      <div
                        key={`${row.timestamp ?? index}-${row.amount}-${row.description}`}
                        className={`flex justify-between items-baseline gap-3 text-white px-2 py-1.5 ${
                          index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-gray-200">{row.description.trim() || "\u2014"}</span>
                          <span className="text-gray-500 text-xs ml-2 shrink-0">{formatDateMMDDYY(row.timestamp)}</span>
                        </span>
                        <span className="text-right shrink-0">{fmtDollars(row.amount)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
