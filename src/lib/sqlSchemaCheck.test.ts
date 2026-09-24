import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSqlSchema } from "./sqlSchemaCheck.ts";

test("the real mistake: a public-schema table is flagged", () => {
  const v = checkSqlSchema(`
create table public.signals_load_log (id bigint primary key);
alter table public.signals_load_log enable row level security;
create index signals_load_log_at on public.signals_load_log (at);`);
  assert.equal(v.length, 3);
  assert.deepEqual(
    v.map((x) => [x.line, x.table]),
    [
      [2, "public.signals_load_log"],
      [3, "public.signals_load_log"],
      [4, "public.signals_load_log"],
    ],
  );
});

test("unqualified names are flagged (they land in public via search_path)", () => {
  const v = checkSqlSchema(`create table if not exists foo (id int); grant select on foo to service_role;`);
  assert.deepEqual(
    v.map((x) => x.table),
    ["foo", "foo"],
  );
});

test("cryptoport tables, auth.users references and cleanup drops pass", () => {
  const sql = `
drop table if exists public.signals_load_log;
create table cryptoport.t (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  wallet_id uuid references cryptoport.wallets(id)
);
alter table cryptoport.t enable row level security;
create unique index if not exists t_idx on cryptoport.t (id);
create policy "t: owner only" on cryptoport.t using (user_id = auth.uid());
grant all on cryptoport.t to service_role;
grant all on all sequences in schema cryptoport to service_role;
-- create table public.commented_out (x int);`;
  assert.deepEqual(checkSqlSchema(sql), []);
});

test("a reference into public is flagged too", () => {
  const v = checkSqlSchema(`create table cryptoport.t (x uuid references public.other(id));`);
  assert.deepEqual(
    v.map((x) => x.table),
    ["public.other"],
  );
});

test("db/schema.sql itself is clean", () => {
  const sql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
  assert.deepEqual(checkSqlSchema(sql), []);
});
