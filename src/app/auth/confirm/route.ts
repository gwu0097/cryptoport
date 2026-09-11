import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { userAuth } from "@/lib/supabase";

// Where Supabase's signup-confirmation and password-reset emails land —
// both link here with a token_hash + type (and a `next` this app added
// itself, see signUp/requestPasswordReset in ../../(auth)/actions.ts).
// Supabase's *default* email templates link to their own hosted
// /auth/v1/verify endpoint instead — the templates need editing in the
// Supabase dashboard (Authentication → Email Templates) to point here
// with {{ .TokenHash }}/{{ .Type }} for this route to ever be reached; see
// commit message.
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/wallets";

  if (tokenHash && type) {
    const supabase = await userAuth();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      redirect(next);
    }
  }

  redirect("/login?error=confirmation-failed");
}
