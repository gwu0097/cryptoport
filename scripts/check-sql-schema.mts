// Fails if any SQL creates or targets a table outside the `cryptoport`
// schema (see src/lib/sqlSchemaCheck.ts for why). Run on handover SQL
// BEFORE pasting it to the user, and it also runs over db/schema.sql:
//
//   node scripts/check-sql-schema.mts [file.sql ...]   (default: db/schema.sql)
import { readFileSync } from "node:fs";
import { checkSqlSchema } from "../src/lib/sqlSchemaCheck.ts";

const files = process.argv.slice(2);
let bad = 0;
for (const file of files.length ? files : ["db/schema.sql"]) {
  const violations = checkSqlSchema(readFileSync(file, "utf8"));
  for (const v of violations) console.error(`${file}:${v.line}: "${v.statement}" — ${v.table} is not in the cryptoport schema`);
  bad += violations.length;
  if (!violations.length) console.log(`OK: ${file} — every table is cryptoport.*`);
}
if (bad) {
  console.error(`\n${bad} statement(s) outside the cryptoport schema. The app's Supabase clients only see cryptoport.* (supabase.ts).`);
  process.exit(1);
}
