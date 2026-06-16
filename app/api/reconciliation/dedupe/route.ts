import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  computeCsvIdentityKeys,
  getCsvParseOptionsForAccount,
} from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CSV_SAVE_CHUNK_SIZE = 15;

async function readStoredRowsForAccount(sql: any, accountName: string): Promise<string[][]> {
  const rows = (await sql`
    SELECT cells
    FROM reconciliation_csv_rows
    WHERE account_name = ${accountName}
    ORDER BY created_at ASC
  `) as Array<{ cells: unknown }>;
  return rows
    .map((r) => (Array.isArray(r.cells) ? r.cells.map((c: unknown) => String(c ?? "")) : null))
    .filter((cells): cells is string[] => cells !== null && cells.length > 0);
}

/**
 * Fetch every bank-transaction hash that already carries reconciliation state for
 * this account (claimed, transfer-claimed, processed, or dismissed).
 */
async function getResolvedHashes(sql: any, accountName: string): Promise<Set<string>> {
  const rows = (await sql`
    SELECT bank_hash AS h FROM reconciliation_claim_links WHERE account_name = ${accountName}
    UNION
    SELECT bank_hash AS h FROM reconciliation_transfer_claim_links WHERE bank_account_name = ${accountName}
    UNION
    SELECT hash AS h FROM processed_transactions WHERE account_name = ${accountName}
    UNION
    SELECT hash AS h FROM reconciliation_statement_dismissals WHERE account_name = ${accountName}
  `) as Array<{ h: string }>;
  return new Set(rows.map((r) => String(r.h)).filter(Boolean));
}

/**
 * Remove redundant stored CSV rows for an account: an *unresolved* row is dropped
 * when another row with the same transaction identity is already resolved
 * (matched / processed / dismissed). This clears the "-N" balance-variant copies
 * that re-imported overlapping statements left behind, without touching genuine
 * duplicate purchases (where no resolved sibling exists, nothing is removed).
 */
export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { accountName?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);

    const existing = await readStoredRowsForAccount(sql, accountName);
    if (existing.length === 0) {
      return NextResponse.json({ success: true, removedHashes: [], removedCount: 0, rows: [] });
    }

    const csvOpts = await getCsvParseOptionsForAccount(accountName);
    const keys = computeCsvIdentityKeys(accountName, existing, csvOpts);
    const resolvedHashes = await getResolvedHashes(sql, accountName);

    // Group parseable rows by base identity (hash without the -N suffix).
    type Member = { index: number; hash: string; resolved: boolean };
    const groups = new Map<string, Member[]>();
    const keepIndices = new Set<number>();
    existing.forEach((_row, i) => {
      const key = keys[i];
      if (!key.startsWith("id:")) {
        keepIndices.add(i); // headers / unparseable rows are always kept
        return;
      }
      const hash = key.slice(3);
      const base = hash.replace(/-\d+$/, "");
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base)!.push({ index: i, hash, resolved: resolvedHashes.has(hash) });
    });

    const removedHashes: string[] = [];
    for (const members of groups.values()) {
      const resolved = members.filter((m) => m.resolved);
      const unresolved = members.filter((m) => !m.resolved);
      resolved.forEach((m) => keepIndices.add(m.index));
      // Drop one unresolved copy for each resolved sibling; keep any extras
      // (those represent genuine still-unmatched transactions).
      const dropCount = Math.min(resolved.length, unresolved.length);
      unresolved.forEach((m, idx) => {
        if (idx < dropCount) removedHashes.push(m.hash);
        else keepIndices.add(m.index);
      });
    }

    if (removedHashes.length === 0) {
      return NextResponse.json({ success: true, removedHashes: [], removedCount: 0, rows: existing });
    }

    const keptRows = existing.filter((_row, i) => keepIndices.has(i));
    const keptKeys = keys.filter((_key, i) => keepIndices.has(i));

    // Replace the account's stored rows with the kept set (DELETE rides with the
    // first insert chunk so a failure can't silently wipe the account).
    const inserts = keptRows.map((cells, i) =>
      sql`
        INSERT INTO reconciliation_csv_rows (account_name, dedupe_key, cells)
        VALUES (${accountName}, ${keptKeys[i]}, ${JSON.stringify(cells)}::jsonb)
        ON CONFLICT (account_name, dedupe_key)
        DO UPDATE SET cells = EXCLUDED.cells, created_at = now()
      `,
    );
    for (let i = 0; i < inserts.length; i += CSV_SAVE_CHUNK_SIZE) {
      const chunk = inserts.slice(i, i + CSV_SAVE_CHUNK_SIZE);
      const isFirst = i === 0;
      await sql.transaction(
        isFirst
          ? [sql`DELETE FROM reconciliation_csv_rows WHERE account_name = ${accountName}`, ...chunk]
          : chunk,
      );
    }

    // Drop the removed copies from the cached match results so they leave the UI.
    await sql`
      DELETE FROM reconciliation_match_cache
      WHERE account_name = ${accountName} AND bank_hash = ANY(${removedHashes}::text[])
    `;

    return NextResponse.json({
      success: true,
      removedHashes,
      removedCount: removedHashes.length,
      rows: keptRows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove duplicate rows" },
      { status: 502 },
    );
  }
}
