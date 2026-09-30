"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Link2, LogOut, Share2, Users, X } from "lucide-react";
import type { WatchGroup } from "@/lib/watchQuery";
import { groupPeople, removeGroupMember, shareGroup, stopSharingGroup } from "@/app/(app)/wallet-watch/actions";
import { Button } from "@/components/ui/Button";
import { ConfirmActionButton } from "@/components/ui/ConfirmActionButton";

type Person = { userId: string; name: string; isCreator: boolean; isYou: boolean };

/**
 * The selected group's sharing (docs/wallet-watch/SHARED_GROUPS.md): its
 * creator shares it (the invite link is copied), sees and removes members,
 * or stops sharing (every member removed); a member sees who's in it and
 * can leave.
 */
export function GroupShareControls({ group }: { group: WatchGroup }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copyLink = (token: string) => {
    void navigator.clipboard.writeText(`${window.location.origin}/wallet-watch/join/${token}`).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const share = () =>
    start(async () => {
      const r = await shareGroup(group.id);
      if (r.ok) copyLink(r.token);
      else setError(r.error);
    });
  const toggleMembers = () =>
    start(async () => {
      if (people) return setPeople(null);
      const r = await groupPeople(group.id);
      if (r.ok) setPeople(r.people);
      else setError(r.error);
    });
  const remove = (userId: string) =>
    start(async () => {
      const r = await removeGroupMember(group.id, userId);
      if (r.ok) setPeople((p) => p?.filter((x) => x.userId !== userId) ?? null);
      else setError(r.error);
    });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {group.mine && !group.shareToken && (
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={share} title="Share this group: members see its wallets and add their own">
            <Share2 className="size-3.5" aria-hidden="true" /> Share group
          </Button>
        )}
        {group.mine && group.shareToken && (
          <Button type="button" variant="secondary" size="sm" onClick={() => copyLink(group.shareToken!)} title="Anyone signed in who opens it can join">
            {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Link2 className="size-3.5" aria-hidden="true" />} {copied ? "Link copied" : "Copy invite link"}
          </Button>
        )}
        {!group.mine && group.shareToken && (
          <Button type="button" variant="secondary" size="sm" onClick={() => copyLink(group.shareToken!)}>
            {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Link2 className="size-3.5" aria-hidden="true" />} {copied ? "Link copied" : "Invite link"}
          </Button>
        )}
        {group.shared && (
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={toggleMembers} aria-expanded={!!people}>
            <Users className="size-3.5" aria-hidden="true" /> Members
          </Button>
        )}
        {group.mine && group.shareToken && (
          <ConfirmActionButton
            message="Stop sharing? The link stops working and every member is removed."
            confirmLabel="Stop sharing"
            disabled={pending}
            onConfirm={() =>
              start(async () => {
                const r = await stopSharingGroup(group.id);
                if (!r.ok) setError(r.error);
                setPeople(null);
              })
            }
            trigger={(open) => (
              <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={open}>
                <X className="size-3.5" aria-hidden="true" /> Stop sharing
              </Button>
            )}
          />
        )}
        {!group.mine && (
          <ConfirmActionButton
            message={`Leave "${group.name}"? Wallets you added to it leave it too — they stay in your Wallet Watch.`}
            confirmLabel="Leave"
            disabled={pending}
            onConfirm={() =>
              start(async () => {
                const r = await removeGroupMember(group.id);
                if (r.ok) router.push("/wallet-watch?group=all");
                else setError(r.error);
              })
            }
            trigger={(open) => (
              <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={open}>
                <LogOut className="size-3.5" aria-hidden="true" /> Leave group
              </Button>
            )}
          />
        )}
      </div>
      {people && (
        <ul className="w-64 space-y-1 rounded-lg border border-border bg-surface-raised/40 p-2 text-xs">
          {people.map((p) => (
            <li key={p.userId} className="flex items-center justify-between gap-2">
              <span className="text-fg">
                {p.name}
                {p.isYou && <span className="text-fg-muted"> (you)</span>}
                {p.isCreator && <span className="text-fg-muted"> · created it</span>}
              </span>
              {group.mine && !p.isCreator && (
                <button type="button" onClick={() => remove(p.userId)} disabled={pending} aria-label={`Remove ${p.name}`} title="Remove from the group" className="rounded p-0.5 text-fg-muted hover:text-negative">
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
          {people.length <= 1 && <li className="text-fg-muted">No one has joined yet — send the invite link.</li>}
        </ul>
      )}
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}
