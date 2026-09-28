import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/adminAuth";

/** Owner's console opens on its first tab. */
export default async function OwnerConsolePage() {
  await requireAdmin();
  redirect("/admin/users");
}
