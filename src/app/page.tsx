import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";

// Deliberately its own top-level route, not under (app) — the old version
// of this page lived at (app)/page.tsx and unconditionally redirected to
// /wallets, which meant proxy.ts's session check ran first and sent every
// signed-out visitor to /login before this component ever got a say. A
// signed-out visitor now lands on /lookup instead — the one page that
// works without an account (see lookup/layout.tsx) — same as landing on
// DeBank/Rabby's own home page without connecting a wallet first.
export default async function RootPage() {
  const user = await getUser();
  redirect(user ? "/wallets" : "/lookup");
}
