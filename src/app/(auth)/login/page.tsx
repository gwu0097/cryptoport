import { LoginForm } from "./LoginForm";

// Surfaces a failed email-confirmation link (see auth/confirm/route.ts)
// as an actual message instead of a silent bounce to a blank login form.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const initialError =
    error === "confirmation-failed"
      ? "That confirmation link is invalid or has expired — try signing in, or request a new one."
      : undefined;

  return <LoginForm initialError={initialError} />;
}
