import "server-only";
import { notFound } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getUser } from "./auth";
import { isAdminEmail } from "./adminEmail";

export { isAdminEmail };

/**
 * Every admin route/query calls this first, no exceptions — mirrors
 * requireUser() (auth.ts) exactly, plus the one email check that makes
 * this "admin," not just "signed in." `notFound()`, not
 * redirect("/login") — a non-admin hitting an admin URL directly gets a
 * plain 404, the same response as a route that doesn't exist, rather than
 * a response that confirms "something real is here, you're just not
 * allowed in."
 */
export async function requireAdmin(): Promise<User> {
  const user = await getUser();
  if (!user || !isAdminEmail(user.email, process.env.ADMIN_EMAIL)) notFound();
  return user;
}
