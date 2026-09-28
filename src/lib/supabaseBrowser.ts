import { createBrowserClient } from "@supabase/ssr";

// The one browser-side Supabase client: only for listening to Realtime
// broadcasts (Wallet Watch live updates). Reads and writes still go through
// the server. Created on first use, shared by every listener on the page.
let client: ReturnType<typeof createBrowserClient> | null = null;

export function browserSupabase() {
  client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}
