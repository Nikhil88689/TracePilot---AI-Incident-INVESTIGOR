// Concatenates supabase/migrations/*.sql, in filename order, into one file you can paste into the Supabase
// SQL editor. The migrations themselves stay the source of truth; this only saves you pasting each one.
// Usage: npm run db:bundle   ->   supabase/all-migrations.generated.sql (gitignored)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../supabase/migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const out = files.map((f) => `-- ==== ${f} ====\n${readFileSync(new URL(f, dir), "utf8").trimEnd()}\n`).join("\n");
writeFileSync(new URL("../supabase/all-migrations.generated.sql", import.meta.url), out);
console.log(`Bundled ${files.length} migrations:\n${files.map((f) => `  ${f}`).join("\n")}`);
