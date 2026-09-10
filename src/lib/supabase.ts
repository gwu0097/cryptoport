import "server-only";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local.",
  );
}

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

// Every query goes through this — service_role key, cryptoport schema,
// never imported into a Client Component (the "server-only" import above
// throws a build error if that happens).
export function portfolioDb() {
  return client.schema("cryptoport");
}
