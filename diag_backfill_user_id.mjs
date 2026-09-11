// One-time multi-tenant migration helper — run only AFTER the schema
// migration in db/schema.sql has been applied AND you've signed up your
// own real account through /signup. Usage:
//   node diag_backfill_user_id.mjs you@example.com
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const email = process.argv[2];
if (!email) {
  console.error("Usage: node diag_backfill_user_id.mjs <email>");
  process.exit(1);
}

const authClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: usersPage, error: listError } = await authClient.auth.admin.listUsers();
if (listError) throw listError;
const user = usersPage.users.find((u) => u.email === email);
if (!user) {
  console.error(`No auth user found for ${email} — sign up through /signup first.`);
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "cryptoport" },
});

console.log(`Backfilling existing wallets/tags to user_id=${user.id} (${email})`);

const { data: wallets, error: walletsError } = await sb
  .from("wallets")
  .update({ user_id: user.id })
  .is("user_id", null)
  .select("id");
if (walletsError) throw walletsError;
console.log(`wallets updated: ${wallets.length}`);

const { data: tags, error: tagsError } = await sb
  .from("tags")
  .update({ user_id: user.id })
  .is("user_id", null)
  .select("id");
if (tagsError) throw tagsError;
console.log(`tags updated: ${tags.length}`);

console.log("\nDone. Run this in the Supabase SQL editor to lock the columns down:");
console.log("  alter table cryptoport.wallets alter column user_id set not null;");
console.log("  alter table cryptoport.tags alter column user_id set not null;");
