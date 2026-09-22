// Monthly snapshot archive: Supabase -> local Parquet -> verify -> delete.
//
//   node scripts/screener-archive.ts                 # dry run: export + verify, no delete
//   node scripts/screener-archive.ts --delete        # the monthly job (see scripts/launchd/)
//   node scripts/screener-archive.ts --from 2026-09-22T16:40:00Z --to 2026-09-22T16:45:00Z
//                                                                    # explicit small range, for testing
//
// Default window: every screener_asset_snapshots row observed more than
// ARCHIVE_AFTER_DAYS (400) days ago. Writes two files per run into the
// archive dir (SCREENER_ARCHIVE_DIR, default ~/cryptoport-archive/screener):
//   snapshots_<from>_<to>_<stamp>.parquet   the rows
//   runs_<from>_<to>_<stamp>.parquet        every screener_runs row they reference
//                                            (each row's provenance = its run's
//                                            manifest + its own provenance_override)
// and appends one line per run to index.jsonl there.
//
// Rows are deleted ONLY if (a) the fetched row count equals Postgres's own
// exact count for the window, and (b) the file reads back with a content
// fingerprint (SHA-256 over every column of every row) identical to what
// was fetched. Deletion is by the archived ids, never by date range, so a
// row that lands in the window mid-run is left alone, not lost.
// screener_runs rows are never deleted — they're tiny and still referenced.
//
// This archive is the only copy of any live (point-in-time) row it removes
// from Supabase — keep the archive dir on a backed-up disk.
import { createClient } from "@supabase/supabase-js";
import { parquetWriteFile } from "hyparquet-writer";
import { parquetReadObjects, asyncBufferFromFile } from "hyparquet/src/node.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SNAPSHOT_ARCHIVE_COLUMNS,
  RUN_ARCHIVE_COLUMNS,
  SNAPSHOT_SELECT,
  RUN_SELECT,
  toColumnData,
  fingerprint,
  archiveWindow,
} from "../src/lib/screener/archive.ts";

process.loadEnvFile(join(import.meta.dirname, "..", ".env.local"));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "cryptoport" },
  auth: { persistSession: false },
});

const PAGE = 1000;
const DELETE_CHUNK = 100; // ids per `in.(...)` filter — kept well under URL-length limits

type Row = Record<string, unknown> & { id: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function inWindow<Q extends { gte: (c: string, v: string) => Q; lt: (c: string, v: string) => Q }>(
  q: Q,
  w: { from: string | null; to: string },
): Q {
  const bounded = q.lt("observed_at", w.to);
  return w.from ? bounded.gte("observed_at", w.from) : bounded;
}

async function exactCount(w: { from: string | null; to: string }): Promise<number> {
  const { count, error } = await inWindow(db.from("screener_asset_snapshots").select("id", { count: "exact", head: true }), w);
  if (error) throw new Error(`count failed: ${error.message}`);
  return count ?? 0;
}

async function fetchWindow(w: { from: string | null; to: string }): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const { data, error } = await inWindow(db.from("screener_asset_snapshots").select(SNAPSHOT_SELECT), w)
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) throw new Error(`fetch failed: ${error.message}`);
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
    cursor = page[page.length - 1].id;
  }
}

async function fetchRuns(ids: string[]): Promise<Row[]> {
  const runs: Row[] = [];
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const { data, error } = await db.from("screener_runs").select(RUN_SELECT).in("id", ids.slice(i, i + DELETE_CHUNK));
    if (error) throw new Error(`runs fetch failed: ${error.message}`);
    runs.push(...((data ?? []) as unknown as Row[]));
  }
  return runs;
}

async function writeAndVerify(path: string, rows: Row[], columns: typeof SNAPSHOT_ARCHIVE_COLUMNS): Promise<string> {
  const tmp = `${path}.partial`;
  parquetWriteFile({ filename: tmp, columnData: toColumnData(rows, columns) as never });
  const readBack = (await parquetReadObjects({ file: await asyncBufferFromFile(tmp) })) as Row[];
  const want = fingerprint(rows, columns);
  const got = fingerprint(readBack, columns);
  if (want.rows !== got.rows || want.sha256 !== got.sha256) {
    throw new Error(`verification FAILED for ${path}: fetched ${want.rows} rows/${want.sha256}, file has ${got.rows} rows/${got.sha256}`);
  }
  renameSync(tmp, path);
  return want.sha256;
}

async function main() {
  const doDelete = process.argv.includes("--delete");
  const w = archiveWindow(new Date(), { from: arg("--from"), to: arg("--to") });
  const dir = process.env.SCREENER_ARCHIVE_DIR ?? join(homedir(), "cryptoport-archive", "screener");
  mkdirSync(dir, { recursive: true });
  console.log(`Window: [${w.from ?? "-inf"}, ${w.to})  mode: ${doDelete ? "archive + DELETE" : "dry run (no delete)"}  dir: ${dir}`);

  const expected = await exactCount(w);
  const rows = await fetchWindow(w);
  if (rows.length !== expected) throw new Error(`fetched ${rows.length} rows but Postgres counts ${expected} — aborting, nothing written`);
  console.log(`Rows in window: ${rows.length}`);
  if (rows.length === 0) {
    appendFileSync(join(dir, "index.jsonl"), JSON.stringify({ at: new Date().toISOString(), window: w, rows: 0 }) + "\n");
    console.log("Nothing to archive.");
    return;
  }

  const runIds = [...new Set(rows.map((r) => r.run_id as string))];
  const runs = await fetchRuns(runIds);
  if (runs.length !== runIds.length) throw new Error(`rows reference ${runIds.length} runs but only ${runs.length} were found — aborting`);

  const tag = `${(w.from ?? "start").slice(0, 10)}_${w.to.slice(0, 10)}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const snapshotsPath = join(dir, `snapshots_${tag}.parquet`);
  const runsPath = join(dir, `runs_${tag}.parquet`);
  const snapshotsSha = await writeAndVerify(snapshotsPath, rows, SNAPSHOT_ARCHIVE_COLUMNS);
  const runsSha = await writeAndVerify(runsPath, runs, RUN_ARCHIVE_COLUMNS);
  const fileSha = createHash("sha256").update(readFileSync(snapshotsPath)).digest("hex");
  console.log(`Verified: ${snapshotsPath} (${rows.length} rows, content ${snapshotsSha.slice(0, 12)}…)`);
  console.log(`Verified: ${runsPath} (${runs.length} runs, content ${runsSha.slice(0, 12)}…)`);

  let deleted = 0;
  if (doDelete) {
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const { count, error } = await db
        .from("screener_asset_snapshots")
        .delete({ count: "exact" })
        .in("id", ids.slice(i, i + DELETE_CHUNK));
      if (error) throw new Error(`delete failed after ${deleted} rows (archive file is complete and verified): ${error.message}`);
      deleted += count ?? 0;
    }
    if (deleted !== rows.length) throw new Error(`deleted ${deleted} of ${rows.length} archived rows — investigate before the next run`);
    console.log(`Deleted ${deleted} rows from Supabase. Rows still in window (landed mid-run, kept): ${await exactCount(w)}`);
  }

  appendFileSync(
    join(dir, "index.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      window: w,
      rows: rows.length,
      runs: runs.length,
      snapshots_file: snapshotsPath,
      runs_file: runsPath,
      content_sha256: snapshotsSha,
      file_sha256: fileSha,
      deleted,
    }) + "\n",
  );
}

main().catch((e) => {
  console.error("Archive failed:", e);
  process.exit(1);
});
