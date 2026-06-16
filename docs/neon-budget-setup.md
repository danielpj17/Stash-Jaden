# Neon database setup

Stash stores accounts, budgets, manual assets/liabilities, and all reconciliation
state in Neon Postgres. Run the setup SQL once after creating your project.

1. In [Neon](https://neon.tech), create a project and copy the **connection string**.
   Use the **pooled** (Transaction mode) string for Next.js/serverless.
2. Add it to `.env` (or `.env.local`): `DATABASE_URL=postgresql://...` (no quotes around the value).
3. In Neon Dashboard → SQL Editor, paste the entire contents of
   [`docs/neon-setup.sql`](./neon-setup.sql) and run. It is the **single, complete,
   copy-pasteable schema** for every table the app uses, and is safe to re-run
   (every statement is idempotent).
4. Restart your dev server.

Notes:

- The API routes also auto-create/upgrade their tables on first use, so this script
  is a convenience/reference — but keep `neon-setup.sql` as the canonical schema and
  update it whenever a table or column changes.
- To wipe all data back to a blank slate, use
  [`docs/neon-blank-slate-reset.sql`](./neon-blank-slate-reset.sql) (destructive).
