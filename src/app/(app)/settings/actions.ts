"use server";

import { redirect } from "next/navigation";
import { userAuth } from "@/lib/supabase";

const MIN_PASSWORD_LENGTH = 8;

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
  const password = requireString(formData, "password");
  const confirmPassword = requireString(formData, "confirmPassword");

  if (password !== confirmPassword) {
    throw new Error("New password and confirmation do not match.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const supabase = await userAuth();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(`Failed to update password: ${error.message}`);

  redirect("/settings?changed=1");
}
