import { redirect } from "next/navigation";

// /wallets renders for a guest too now (a sign-in prompt in place of data —
// see (app)/wallets/page.tsx) so it's the front door regardless of session
// state, same landing page a signed-in user gets. No branching needed here.
export default function RootPage() {
  redirect("/wallets");
}
