"use client";

import { useMemo, useState } from "react";
import type { CsvFormat } from "@/services/reconciliationService";

type ColumnRole = "ignore" | "date" | "amount" | "debit" | "credit" | "description";

type Props = {
  open: boolean;
  accountName: string;
  /** Raw parsed CSV rows (PapaParse output). */
  sampleRows: string[][];
  initialFormat?: Partial<CsvFormat>;
  saving?: boolean;
  error?: string;
  onSave: (format: CsvFormat) => void;
  onClose: () => void;
};

const PREVIEW_ROWS = 8;

function parseAmount(raw: string): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const paren = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[,$\s()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return paren ? -Math.abs(n) : n;
}

function looksLikeDate(raw: string): boolean {
  const t = String(raw ?? "").trim();
  if (!t || /^\d+(\.\d+)?$/.test(t)) return false;
  if (!/[\/\-.]/.test(t) && !/[a-z]{3}/i.test(t)) return false;
  return !Number.isNaN(Date.parse(t));
}

function normalizeHeader(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/﻿/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Best-effort guess of header rows + column roles from a sample. */
function autodetectFormat(rows: string[][]): {
  headerRows: number;
  roles: Record<number, ColumnRole>;
} {
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const roles: Record<number, ColumnRole> = {};
  for (let c = 0; c < colCount; c += 1) roles[c] = "ignore";
  if (rows.length === 0) return { headerRows: 0, roles };

  // Detect a header row: first row that is mostly non-numeric & non-date text.
  const firstRow = rows[0] ?? [];
  const nonDataCells = firstRow.filter((cell) => {
    const t = String(cell ?? "").trim();
    return t !== "" && parseAmount(t) === null && !looksLikeDate(t);
  }).length;
  const headerRows = firstRow.length > 0 && nonDataCells >= Math.ceil(firstRow.length / 2) ? 1 : 0;

  const dataRows = rows.slice(headerRows).slice(0, 50);
  const headerNames = headerRows > 0 ? firstRow.map(normalizeHeader) : [];

  const stats: Array<{ dateFrac: number; numFrac: number; avgLen: number; nonEmpty: number }> = [];
  for (let c = 0; c < colCount; c += 1) {
    let dates = 0;
    let nums = 0;
    let lenSum = 0;
    let nonEmpty = 0;
    for (const row of dataRows) {
      const cell = String(row[c] ?? "").trim();
      if (!cell) continue;
      nonEmpty += 1;
      if (looksLikeDate(cell)) dates += 1;
      if (parseAmount(cell) !== null) nums += 1;
      else lenSum += cell.length;
    }
    const denom = Math.max(nonEmpty, 1);
    stats.push({
      dateFrac: dates / denom,
      numFrac: nums / denom,
      avgLen: lenSum / Math.max(nonEmpty - nums, 1),
      nonEmpty,
    });
  }

  // Header-name hints take priority when present.
  const usedByHint = new Set<number>();
  const hintMatch = (keywords: string[]): number => {
    for (let c = 0; c < headerNames.length; c += 1) {
      if (usedByHint.has(c)) continue;
      if (keywords.some((k) => headerNames[c] === k || headerNames[c].includes(k))) {
        usedByHint.add(c);
        return c;
      }
    }
    return -1;
  };

  let dateCol = hintMatch(["date", "datetime", "transaction date", "posted"]);
  let debitCol = hintMatch(["debit", "withdrawal", "charges"]);
  let creditCol = hintMatch(["credit", "deposit"]);
  let amountCol = debitCol >= 0 || creditCol >= 0 ? -1 : hintMatch(["amount", "amount total"]);
  let descCol = hintMatch(["description", "note", "memo", "payee", "details", "name"]);

  // Fall back to data-driven detection for anything not hinted.
  if (dateCol < 0) {
    let best = -1;
    let bestFrac = 0.5;
    for (let c = 0; c < colCount; c += 1) {
      if (stats[c].dateFrac > bestFrac) {
        bestFrac = stats[c].dateFrac;
        best = c;
      }
    }
    dateCol = best;
  }

  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    const numericCols = [];
    for (let c = 0; c < colCount; c += 1) {
      if (c === dateCol) continue;
      if (stats[c].numFrac >= 0.6 && stats[c].nonEmpty > 0) numericCols.push(c);
    }
    // Two mutually-exclusive numeric columns -> debit/credit split.
    if (numericCols.length >= 2) {
      const [a, b] = numericCols;
      let exclusive = 0;
      let both = 0;
      for (const row of dataRows) {
        const av = String(row[a] ?? "").trim() !== "";
        const bv = String(row[b] ?? "").trim() !== "";
        if (av && bv) both += 1;
        else if (av || bv) exclusive += 1;
      }
      if (exclusive > both) {
        debitCol = a;
        creditCol = b;
      } else {
        amountCol = a;
      }
    } else if (numericCols.length === 1) {
      amountCol = numericCols[0];
    }
  }

  if (descCol < 0) {
    let best = -1;
    let bestLen = 0;
    for (let c = 0; c < colCount; c += 1) {
      if (c === dateCol || c === amountCol || c === debitCol || c === creditCol) continue;
      if (stats[c].avgLen > bestLen) {
        bestLen = stats[c].avgLen;
        best = c;
      }
    }
    descCol = best;
  }

  if (dateCol >= 0) roles[dateCol] = "date";
  if (descCol >= 0) roles[descCol] = "description";
  if (amountCol >= 0) roles[amountCol] = "amount";
  if (debitCol >= 0) roles[debitCol] = "debit";
  if (creditCol >= 0) roles[creditCol] = "credit";

  return { headerRows, roles };
}

function rolesFromFormat(format: Partial<CsvFormat>, colCount: number): Record<number, ColumnRole> {
  const roles: Record<number, ColumnRole> = {};
  for (let c = 0; c < colCount; c += 1) roles[c] = "ignore";
  const set = (idx: number | null | undefined, role: ColumnRole) => {
    if (typeof idx === "number" && idx >= 0 && idx < colCount) roles[idx] = role;
  };
  set(format.dateIndex, "date");
  set(format.descriptionIndex, "description");
  set(format.amountIndex, "amount");
  set(format.debitIndex, "debit");
  set(format.creditIndex, "credit");
  return roles;
}

export default function CsvMappingModal({
  open,
  accountName,
  sampleRows,
  initialFormat,
  saving = false,
  error,
  onSave,
  onClose,
}: Props) {
  const colCount = useMemo(
    () => sampleRows.reduce((m, r) => Math.max(m, r.length), 0),
    [sampleRows],
  );

  const detected = useMemo(() => {
    if (initialFormat && initialFormat.configured) {
      return {
        headerRows: initialFormat.headerRows ?? 0,
        roles: rolesFromFormat(initialFormat, colCount),
      };
    }
    return autodetectFormat(sampleRows);
  }, [sampleRows, initialFormat, colCount]);

  const [roles, setRoles] = useState<Record<number, ColumnRole>>(detected.roles);
  const [headerRows, setHeaderRows] = useState<number>(detected.headerRows);
  const [amountSign, setAmountSign] = useState<"standard" | "flip">(
    initialFormat?.amountSign === "flip" ? "flip" : "standard",
  );
  const [dateFormat, setDateFormat] = useState<string>(initialFormat?.dateFormat ?? "auto");
  const [localError, setLocalError] = useState<string>("");

  // A column can only hold one role; assigning a role clears it from other columns
  // (except ignore, which can repeat). Debit/credit are the exception (both used).
  const setRole = (col: number, role: ColumnRole) => {
    setRoles((prev) => {
      const next = { ...prev };
      if (role !== "ignore" && role !== "debit" && role !== "credit") {
        for (const key of Object.keys(next)) {
          const c = Number(key);
          if (c !== col && next[c] === role) next[c] = "ignore";
        }
      }
      next[col] = role;
      return next;
    });
  };

  const indexFor = (role: ColumnRole): number | null => {
    for (let c = 0; c < colCount; c += 1) if (roles[c] === role) return c;
    return null;
  };

  const buildFormat = (): CsvFormat => {
    const debitIndex = indexFor("debit");
    const creditIndex = indexFor("credit");
    const usesSplit = debitIndex !== null || creditIndex !== null;
    return {
      version: 1,
      headerRows: Math.max(0, Math.trunc(headerRows)),
      dateIndex: indexFor("date"),
      amountIndex: usesSplit ? null : indexFor("amount"),
      debitIndex: usesSplit ? debitIndex : null,
      creditIndex: usesSplit ? creditIndex : null,
      descriptionIndex: indexFor("description"),
      dateFormat,
      amountSign,
      configured: true,
    };
  };

  const format = buildFormat();

  const previewRows = useMemo(() => {
    const dataRows = sampleRows.slice(Math.max(0, Math.trunc(headerRows)));
    return dataRows.slice(0, PREVIEW_ROWS).map((row) => {
      const date = format.dateIndex !== null ? String(row[format.dateIndex] ?? "").trim() : "";
      const description =
        format.descriptionIndex !== null ? String(row[format.descriptionIndex] ?? "").trim() : "";
      let amount: number | null = null;
      if (format.amountIndex !== null) {
        amount = parseAmount(String(row[format.amountIndex] ?? ""));
      } else if (format.debitIndex != null || format.creditIndex != null) {
        const debit = format.debitIndex != null ? parseAmount(String(row[format.debitIndex] ?? "")) : null;
        const credit = format.creditIndex != null ? parseAmount(String(row[format.creditIndex] ?? "")) : null;
        if (debit !== null && Math.abs(debit) > 0) amount = Math.abs(debit);
        else if (credit !== null && Math.abs(credit) > 0) amount = -Math.abs(credit);
      }
      if (amount !== null && amountSign === "flip") amount = -amount;
      return { date, description, amount };
    });
  }, [sampleRows, headerRows, format, amountSign]);

  const validate = (): string => {
    if (format.dateIndex === null) return "Assign a Date column.";
    if (format.descriptionIndex === null) return "Assign a Description column.";
    if (format.amountIndex === null && format.debitIndex === null && format.creditIndex === null) {
      return "Assign an Amount column, or both Debit and Credit columns.";
    }
    return "";
  };

  const handleSave = () => {
    const v = validate();
    if (v) {
      setLocalError(v);
      return;
    }
    setLocalError("");
    onSave(format);
  };

  if (!open) return null;

  const headerSample = headerRows > 0 ? sampleRows[0] ?? [] : null;
  const gridRows = sampleRows.slice(0, 10);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 p-4 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl bg-[#252525] border border-charcoal-dark"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between sticky top-0 z-10">
          <h3 className="text-white font-semibold">Map CSV columns — {accountName}</h3>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
          >
            Close
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-gray-400">
            Tell the app which column is which. We&apos;ve guessed below — adjust any that are wrong, then
            check the preview. This mapping is saved for {accountName} and reused on future uploads.
          </p>

          <div className="flex flex-wrap items-end gap-4">
            <label className="text-sm text-gray-300">
              Header rows to skip
              <input
                type="number"
                min={0}
                value={headerRows}
                onChange={(e) => setHeaderRows(Math.max(0, Number(e.target.value) || 0))}
                className="mt-1 block w-24 rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
              />
            </label>
            <label className="text-sm text-gray-300">
              Amount sign
              <select
                value={amountSign}
                onChange={(e) => setAmountSign(e.target.value as "standard" | "flip")}
                className="mt-1 block w-48 rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
              >
                <option value="standard">Standard (negative = money out)</option>
                <option value="flip">Flip (positive = money out)</option>
              </select>
            </label>
            <label className="text-sm text-gray-300">
              Date format hint
              <select
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value)}
                className="mt-1 block w-40 rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
              >
                <option value="auto">Auto-detect</option>
                <option value="MDY">MM/DD/YYYY</option>
                <option value="DMY">DD/MM/YYYY</option>
                <option value="YMD">YYYY-MM-DD</option>
                <option value="ISO">ISO 8601</option>
              </select>
            </label>
          </div>

          <div className="overflow-x-auto rounded-lg border border-charcoal-dark">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#2b2b2b]">
                  {Array.from({ length: colCount }).map((_, c) => (
                    <th key={c} className="p-2 text-left align-top border-b border-charcoal-dark">
                      <select
                        value={roles[c] ?? "ignore"}
                        onChange={(e) => setRole(c, e.target.value as ColumnRole)}
                        className="w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-1 py-1 text-white"
                      >
                        <option value="ignore">Ignore</option>
                        <option value="date">Date</option>
                        <option value="amount">Amount</option>
                        <option value="debit">Debit</option>
                        <option value="credit">Credit</option>
                        <option value="description">Description</option>
                      </select>
                      {headerSample && (
                        <div className="mt-1 text-gray-400 font-normal truncate max-w-[10rem]">
                          {String(headerSample[c] ?? "")}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {gridRows.map((row, ri) => (
                  <tr key={ri} className={ri < headerRows ? "opacity-40" : ""}>
                    {Array.from({ length: colCount }).map((_, c) => (
                      <td key={c} className="p-2 border-b border-charcoal-dark/60 truncate max-w-[12rem]">
                        {String(row[c] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-white mb-2">Preview</h4>
            <div className="overflow-x-auto rounded-lg border border-charcoal-dark">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#2b2b2b] text-left text-gray-400">
                    <th className="p-2">Date</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2">Description</th>
                  </tr>
                </thead>
                <tbody className="text-white">
                  {previewRows.map((r, i) => (
                    <tr key={i} className="border-b border-charcoal-dark/60">
                      <td className="p-2">{r.date || <span className="text-red-400">—</span>}</td>
                      <td className="p-2 text-right tabular-nums">
                        {r.amount === null ? (
                          <span className="text-red-400">—</span>
                        ) : (
                          r.amount.toFixed(2)
                        )}
                      </td>
                      <td className="p-2 truncate max-w-[20rem]">
                        {r.description || <span className="text-red-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(localError || error) && (
            <p className="text-sm text-red-400">{localError || error}</p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2 bg-[#252525] sticky bottom-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md bg-[#3a3a3a] text-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 rounded-md bg-[#50C878] text-black disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save mapping & upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
