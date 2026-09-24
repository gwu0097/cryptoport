// Every table this app owns lives in the `cryptoport` schema — the Supabase
// clients are pinned to it (serviceDb() = .schema("cryptoport"), see
// supabase.ts). A table created anywhere else is invisible to the app: on
// 2026-09-24 handover SQL for signals_load_log said `public.` and the insert
// failed with "Could not find the table 'cryptoport.signals_load_log'".
// This flags any statement that creates or targets a table outside
// cryptoport (or unqualified, which lands in public via search_path). See
// sqlSchemaCheck.test.ts and scripts/check-sql-schema.ts.

export interface SchemaViolation {
  line: number;
  statement: string;
  table: string;
}

const APP_SCHEMA = "cryptoport";
// Other schemas a statement may legitimately REFERENCE (never create in).
const REFERENCE_OK = new Set(["auth"]);

// Statement shapes that create or target a table, capturing the table name.
const PATTERNS: { re: RegExp; kind: "create" | "target" | "reference" }[] = [
  { re: /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi, kind: "create" },
  { re: /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)/gi, kind: "target" },
  { re: /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:[\w"]+\s+)?on\s+(?:only\s+)?([\w."]+)/gi, kind: "target" },
  { re: /\bcreate\s+policy\s+(?:"[^"]*"|\w+)\s+on\s+([\w."]+)/gi, kind: "target" },
  // Table grants only — not `on all tables in schema`, default privileges
  // (`on tables`), sequences, schemas or functions.
  { re: /\bgrant\s+[\w\s,]+?\s+on\s+(?:table\s+)?(?!(?:all|schema|sequence|sequences|tables|function|functions|routine|routines|type|domain)\b)([\w."]+)/gi, kind: "target" },
  { re: /\breferences\s+([\w."]+)/gi, kind: "reference" },
];

/** Strip `-- line comments` and block comments, keeping line numbers. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/--[^\n]*/g, "");
}

export function checkSqlSchema(sql: string): SchemaViolation[] {
  const text = stripComments(sql);
  const out: SchemaViolation[] = [];
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const table = m[1].replace(/"/g, "");
      const schema = table.includes(".") ? table.split(".")[0].toLowerCase() : null;
      const ok = schema === APP_SCHEMA || (kind === "reference" && schema !== null && REFERENCE_OK.has(schema));
      if (!ok) {
        out.push({ line: text.slice(0, m.index).split("\n").length, statement: m[0].replace(/\s+/g, " ").trim(), table });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
