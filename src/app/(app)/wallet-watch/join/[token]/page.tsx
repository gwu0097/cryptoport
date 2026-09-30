import { Users } from "lucide-react";
import { getUser } from "@/lib/auth";
import { joinGroup } from "../../actions";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SignInPrompt } from "@/components/SignInPrompt";
import { SubmitButton } from "@/components/ui/SubmitButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Join a shared group · CryptoPort" };

/** A shared Wallet Watch group's invite link (docs/wallet-watch/SHARED_GROUPS.md):
 * one button joins it (a GET never changes anything). */
export default async function JoinGroupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await getUser())) return <SignInPrompt message="Log in to join this shared Wallet Watch group." />;
  return (
    <>
      <PageHeader title="Join a shared group" />
      <Panel className="max-w-xl">
        <p className="flex items-start gap-2 text-sm text-fg-muted">
          <Users className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          Someone shared a Wallet Watch group with you. Once you join, it shows in your group tabs: you see its wallets and whatever its members add, and
          they see what you add to it. Your other groups and wallets stay private. You can leave it any time.
        </p>
        <form action={joinGroup.bind(null, token)} className="mt-4">
          <SubmitButton pendingLabel="Joining…">Join the group</SubmitButton>
        </form>
      </Panel>
    </>
  );
}
