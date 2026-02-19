import { createClient } from "@/lib/supabase/server";
import { getAuthUrl } from "@/lib/gmail";
import { redirect } from "next/navigation";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const redirectUri =
    process.env.GOOGLE_GMAIL_REDIRECT_URI ??
    `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"}/api/gmail/callback`;

  const authUrl = getAuthUrl(redirectUri, user.id);
  redirect(authUrl);
}
