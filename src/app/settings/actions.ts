"use server";

import { redirect } from "next/navigation";
import { hashPassword, verifyCurrentPassword } from "@/lib/authCredentials";
import { portfolioDb } from "@/lib/supabase";

function requireString(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value === "") {
    throw new Error(`"${field}" is required.`);
  }
  return value;
}

export async function changeCredentials(formData: FormData) {
  const currentPassword = requireString(formData, "currentPassword");
  const newUsername = requireString(formData, "newUsername").trim();
  const newPassword = requireString(formData, "newPassword");
  const confirmPassword = requireString(formData, "confirmPassword");

  if (newPassword !== confirmPassword) {
    throw new Error("New password and confirmation do not match.");
  }
  if (newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters.");
  }

  const currentOk = await verifyCurrentPassword(currentPassword);
  if (!currentOk) {
    throw new Error("Current password is incorrect.");
  }

  const { error } = await portfolioDb()
    .from("app_credentials")
    .update({
      username: newUsername,
      password_hash: hashPassword(newPassword),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw new Error(`Failed to update login: ${error.message}`);

  redirect("/settings?changed=1");
}
