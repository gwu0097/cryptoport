"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { userAuth, userDb } from "@/lib/supabase";
import { isValidTimeZone } from "@/lib/timezone";
import { requireUser } from "@/lib/auth";
import { validatePassword } from "@/lib/password";

function requireString(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value === "") {
    throw new Error(`"${field}" is required.`);
  }
  return value;
}

// Plain FormData signature (not (prevState, formData) like the /login,
// /signup, etc. actions in app/(auth)/actions.ts) since this form isn't
// wired through useActionState — same throw-on-error convention as every
// other settings-adjacent form in this app (e.g. the old changeCredentials
// this replaces). Doesn't ask for the current password first: being
// signed in here already proves a valid, current session, unlike the old
// Basic Auth scheme (no real session concept — every request re-sent the
// password, so re-checking it here was the only proof available).
export async function updateAccountPassword(formData: FormData) {
  // Now that (app)/layout.tsx no longer gates pages, this is reachable by a
  // guest POST — Supabase's own auth.updateUser() would reject it with no
  // session anyway, but that's not the invariant to rely on; check here
  // directly, same as every sibling action in this app.
  await requireUser();
  const password = requireString(formData, "password");
  const confirmPassword = requireString(formData, "confirmPassword");

  const passwordError = validatePassword(password, confirmPassword);
  if (passwordError) throw new Error(passwordError);

  const supabase = await userAuth();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(`Failed to update password: ${error.message}`);

  redirect("/profile?changed=1");
}

/** Settings → Language & region. "auto" clears the saved zone (back to the
 * browser-detected one); anything else must be a real IANA zone. Every page
 * shows times, so the whole layout is revalidated. */
export async function saveTimeZone(formData: FormData) {
  const user = await requireUser();
  const value = requireString(formData, "timezone");
  const timezone = value === "auto" ? null : value;
  if (timezone !== null && !isValidTimeZone(timezone)) throw new Error(`Unknown time zone "${timezone}".`);

  const db = await userDb();
  const { error } = await db
    .from("user_preferences")
    .upsert({ user_id: user.id, timezone, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(`Failed to save time zone: ${error.message}`);

  revalidatePath("/", "layout");
  redirect("/settings?saved=timezone");
}
