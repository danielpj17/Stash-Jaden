import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(f, "utf8");
      for (const rawLine of txt.split("\n")) {
        const line = rawLine.replace(/\r$/, "").trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (key !== "DATABASE_URL") continue;
        let url = line.slice(eq + 1).trim();
        if (
          (url.startsWith('"') && url.endsWith('"')) ||
          (url.startsWith("'") && url.endsWith("'"))
        ) {
          url = url.slice(1, -1);
        }
        if (url) return url;
      }
    } catch {
      /* file missing */
    }
  }
  return null;
}

const url = loadDatabaseUrl();
if (!url) {
  console.error("No DATABASE_URL found in env or .env files.");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node run-sql.mjs <path-to-sql>");
  process.exit(1);
}

const raw = readFileSync(file, "utf8");
const noComments = raw
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");
const statements = noComments
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const sql = neon(url);
console.log(`Running ${statements.length} statement(s) from ${file}...`);
for (const stmt of statements) {
  await sql.query(stmt);
  console.log("OK:", stmt.replace(/\s+/g, " ").slice(0, 90));
}
console.log("Done.");
