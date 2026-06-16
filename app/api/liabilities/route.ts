import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManualItem = {
  id: string;
  name: string;
  value: number;
  category: string;
  acquisition_date?: string | null;
  details?: Record<string, unknown>;
  updated_at?: string;
};

async function ensureManualLiabilitiesTable(sql: any): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS manual_liabilities (
      id text PRIMARY KEY,
      name text NOT NULL,
      value numeric(14, 2) NOT NULL,
      category text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS acquisition_date date`;
  await sql`ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb`;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
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

function normalizeItem(raw: unknown): ManualItem | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const category = typeof candidate.category === "string" ? candidate.category.trim() : "";
  const value = toNumber(candidate.value);
  const providedId = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const acquisitionDateRaw =
    typeof candidate.acquisition_date === "string"
      ? candidate.acquisition_date
      : typeof candidate.acquisitionDate === "string"
        ? candidate.acquisitionDate
        : "";
  const acquisition_date = acquisitionDateRaw.trim() || null;
  const details =
    candidate.details && typeof candidate.details === "object" && !Array.isArray(candidate.details)
      ? (candidate.details as Record<string, unknown>)
      : {};

  if (!name || !category || value === null) return null;

  return {
    id: providedId || crypto.randomUUID(),
    name,
    value,
    category,
    acquisition_date,
    details,
  };
}

function normalizeBody(raw: unknown): ManualItem[] | null {
  if (Array.isArray(raw)) {
    const items = raw.map(normalizeItem);
    if (items.some((item) => item === null)) return null;
    return items as ManualItem[];
  }
  const single = normalizeItem(raw);
  return single ? [single] : null;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json([]);
  }

  try {
    const sql = neon(connectionString);
    await ensureManualLiabilitiesTable(sql);
    const rows = await sql`
      SELECT id, name, value, category, acquisition_date, details, updated_at
      FROM manual_liabilities
      ORDER BY updated_at DESC, name ASC
    `;

    const data = rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      value: Number(row.value),
      category: String(row.category),
      acquisition_date: toDateString(row.acquisition_date),
      details:
        row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? (row.details as Record<string, unknown>)
          : {},
      updated_at: String(row.updated_at),
    }));

    return NextResponse.json(data);
  } catch (err) {
    console.error("Liabilities GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load liabilities" },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = normalizeBody(body);
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "Invalid liability data" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureManualLiabilitiesTable(sql);
    const saved: ManualItem[] = [];
    for (const item of items) {
      const rows = await sql`
        INSERT INTO manual_liabilities (id, name, value, category, acquisition_date, details)
        VALUES (${item.id}, ${item.name}, ${item.value}, ${item.category}, ${item.acquisition_date}::date, ${item.details ?? {}})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          value = EXCLUDED.value,
          category = EXCLUDED.category,
          acquisition_date = EXCLUDED.acquisition_date,
          details = EXCLUDED.details,
          updated_at = now()
        RETURNING id, name, value, category, acquisition_date, details, updated_at
      `;
      const row = rows[0];
      saved.push({
        id: String(row.id),
        name: String(row.name),
        value: Number(row.value),
        category: String(row.category),
        acquisition_date: toDateString(row.acquisition_date),
        details:
          row.details && typeof row.details === "object" && !Array.isArray(row.details)
            ? (row.details as Record<string, unknown>)
            : {},
        updated_at: String(row.updated_at),
      });
    }

    return NextResponse.json(Array.isArray(body) ? saved : saved[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Liabilities POST error:", err);
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

  const id = typeof (body as { id?: unknown })?.id === "string" ? (body as { id: string }).id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureManualLiabilitiesTable(sql);
    await sql`DELETE FROM manual_liabilities WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Liabilities DELETE error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
