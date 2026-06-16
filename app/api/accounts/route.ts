import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT_TYPES = ["checking", "savings", "cash", "credit", "brokerage", "other"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

type AccountRecord = {
  id: string;
  name: string;
  type: AccountType;
  openingBalance: number;
  openingBalanceDate: string | null;
  csvFormat: Record<string, unknown>;
  includeInReconcile: boolean;
  sortOrder: number;
  archived: boolean;
  updatedAt?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureAccountsTable(sql: any): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      type text NOT NULL DEFAULT 'other',
      opening_balance numeric(14, 2) NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opening_balance_date date`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS csv_format jsonb NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS include_in_reconcile boolean NOT NULL DEFAULT true`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_name ON accounts (name)`;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toDateString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.length >= 10 ? raw.slice(0, 10) : raw;
  return parsed.toISOString().slice(0, 10);
}

function normalizeAccount(raw: unknown): AccountRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) return null;

  const typeRaw = typeof candidate.type === "string" ? candidate.type.trim().toLowerCase() : "other";
  const type: AccountType = (ACCOUNT_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as AccountType)
    : "other";

  const providedId = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const openingBalanceDateRaw =
    typeof candidate.opening_balance_date === "string"
      ? candidate.opening_balance_date
      : typeof candidate.openingBalanceDate === "string"
        ? candidate.openingBalanceDate
        : "";
  const csvFormat =
    candidate.csv_format && typeof candidate.csv_format === "object" && !Array.isArray(candidate.csv_format)
      ? (candidate.csv_format as Record<string, unknown>)
      : candidate.csvFormat && typeof candidate.csvFormat === "object" && !Array.isArray(candidate.csvFormat)
        ? (candidate.csvFormat as Record<string, unknown>)
        : {};

  const includeInReconcile =
    typeof candidate.include_in_reconcile === "boolean"
      ? candidate.include_in_reconcile
      : typeof candidate.includeInReconcile === "boolean"
        ? candidate.includeInReconcile
        : true;

  return {
    id: providedId || crypto.randomUUID(),
    name,
    type,
    openingBalance: toNumber(candidate.opening_balance ?? candidate.openingBalance, 0),
    openingBalanceDate: openingBalanceDateRaw.trim() || null,
    csvFormat,
    includeInReconcile,
    sortOrder: Math.trunc(toNumber(candidate.sort_order ?? candidate.sortOrder, 0)),
    archived:
      candidate.archived === true ||
      candidate.archived === "true" ||
      candidate.archived === 1,
  };
}

function normalizeBody(raw: unknown): AccountRecord[] | null {
  if (Array.isArray(raw)) {
    const items = raw.map(normalizeAccount);
    if (items.some((item) => item === null)) return null;
    return items as AccountRecord[];
  }
  const single = normalizeAccount(raw);
  return single ? [single] : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAccount(row: any): AccountRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    type: ((ACCOUNT_TYPES as readonly string[]).includes(String(row.type))
      ? String(row.type)
      : "other") as AccountType,
    openingBalance: Number(row.opening_balance ?? 0),
    openingBalanceDate: toDateString(row.opening_balance_date),
    csvFormat:
      row.csv_format && typeof row.csv_format === "object" && !Array.isArray(row.csv_format)
        ? (row.csv_format as Record<string, unknown>)
        : {},
    includeInReconcile: row.include_in_reconcile !== false,
    sortOrder: Number(row.sort_order ?? 0),
    archived: row.archived === true,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json([]);
  }

  try {
    const sql = neon(connectionString);
    await ensureAccountsTable(sql);
    const rows = await sql`
      SELECT id, name, type, opening_balance, opening_balance_date, csv_format,
             include_in_reconcile, sort_order, archived, updated_at
      FROM accounts
      ORDER BY sort_order ASC, name ASC
    `;
    return NextResponse.json(rows.map(rowToAccount));
  } catch (err) {
    console.error("Accounts GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load accounts" },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = normalizeBody(body);
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "Invalid account data" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureAccountsTable(sql);
    const saved: AccountRecord[] = [];
    for (const item of items) {
      const rows = await sql`
        INSERT INTO accounts (
          id, name, type, opening_balance, opening_balance_date, csv_format,
          include_in_reconcile, sort_order, archived
        )
        VALUES (
          ${item.id}, ${item.name}, ${item.type}, ${item.openingBalance},
          ${item.openingBalanceDate}::date, ${JSON.stringify(item.csvFormat)}::jsonb,
          ${item.includeInReconcile}, ${item.sortOrder}, ${item.archived}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          opening_balance = EXCLUDED.opening_balance,
          opening_balance_date = EXCLUDED.opening_balance_date,
          csv_format = EXCLUDED.csv_format,
          include_in_reconcile = EXCLUDED.include_in_reconcile,
          sort_order = EXCLUDED.sort_order,
          archived = EXCLUDED.archived,
          updated_at = now()
        RETURNING id, name, type, opening_balance, opening_balance_date, csv_format,
                  include_in_reconcile, sort_order, archived, updated_at
      `;
      saved.push(rowToAccount(rows[0]));
    }
    return NextResponse.json(Array.isArray(body) ? saved : saved[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Accounts POST error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const candidate = (body ?? {}) as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const purge = candidate.purge === true || candidate.purge === "true";

  if (!id && !name) {
    return NextResponse.json({ error: "id or name is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureAccountsTable(sql);

    // Resolve the account name (needed if purge is requested and only id was given).
    let accountName = name;
    if (id) {
      const found = await sql`SELECT name FROM accounts WHERE id = ${id}`;
      if (found.length > 0) accountName = String(found[0].name);
      await sql`DELETE FROM accounts WHERE id = ${id}`;
    } else {
      await sql`DELETE FROM accounts WHERE name = ${name}`;
    }

    if (purge && accountName) {
      // Best-effort: drop reconciliation history tied to this account name.
      try {
        await sql`DELETE FROM account_anchors WHERE account_name = ${accountName}`;
      } catch {
        /* table may not exist yet */
      }
      try {
        await sql`DELETE FROM reconciliation_csv_rows WHERE account_name = ${accountName}`;
      } catch {
        /* table may not exist yet */
      }
    }

    return NextResponse.json({ success: true, purged: purge });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Accounts DELETE error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
