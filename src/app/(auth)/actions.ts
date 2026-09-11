"use server";

import { redirect } from "next/navigation";
import { userAuth, siteUrl } from "@/lib/supabase";

export type AuthFormState = { error?: string; success?: string } | undefined;

const MIN_PASSWORD_LENGTH = 8;

function requiredField(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function signIn(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = requiredField(formData, "email");
  const password = typeof formData.get("password") === "string" ? (formData.get("password") as string) : "";
  if (!email || !password) return { error: "Email and password are both required." };

  const supabase = await userAuth();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // Deliberately the same message whether the email doesn't exist or the
  // password is wrong — distinguishing them lets an attacker enumerate
  // registered emails.
  if (error) return { error: "Invalid email or password." };

  redirect("/wallets");
}

export async function signUp(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = requiredField(formData, "email");
  const password = typeof formData.get("password") === "string" ? (formData.get("password") as string) : "";
  const confirmPassword =
    typeof formData.get("confirmPassword") === "string" ? (formData.get("confirmPassword") as string) : "";

  if (!email) return { error: "Email is required." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirmPassword) return { error: "Passwords do not match." };

  const supabase = await userAuth();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${siteUrl()}/auth/confirm?next=/wallets` },
  });
  if (error) return { error: error.message };

  // Same success message regardless of whether this email was already
  // registered — Supabase itself avoids confirming/denying that in its
  // response for the same anti-enumeration reason as signIn's error above.
  return { success: "Check your email for a confirmation link to finish creating your account." };
}

export async function signOut(): Promise<void> {
  const supabase = await userAuth();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = requiredField(formData, "email");
  if (!email) return { error: "Email is required." };

  const supabase = await userAuth();
  // Errors here aren't surfaced either, same anti-enumeration reasoning —
  // whether this email exists in the system should never be observable
  // from this form's response.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl()}/auth/confirm?next=/update-password`,
  });

  return { success: "If that email has an account, a password reset link is on its way." };
}

export async function updatePassword(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = typeof formData.get("password") === "string" ? (formData.get("password") as string) : "";
  const confirmPassword =
    typeof formData.get("confirmPassword") === "string" ? (formData.get("confirmPassword") as string) : "";

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirmPassword) return { error: "Passwords do not match." };

  const supabase = await userAuth();
  // Only reachable with a valid session — the /update-password page is
  // authenticated (see proxy.ts's comment on why it's not in PUBLIC_PATHS),
  // established by following a password-reset email link through
  // /auth/confirm just before landing here.
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };

  redirect("/wallets");
}
