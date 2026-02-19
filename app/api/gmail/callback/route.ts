import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getTokensFromCode,
  getGmailClient,
  watchMailbox,
  fetchNewEmails,
} from "@/lib/gmail";
import { redirect } from "next/navigation";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state"); // user_id

  if (!code || !state || state !== user.id) {
    redirect("/home?error=missing_params");
  }

  const redirectUri =
    process.env.GOOGLE_GMAIL_REDIRECT_URI ??
    `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"}/api/gmail/callback`;

  const tokens = await getTokensFromCode(code, redirectUri);
  if (!tokens.access_token) {
    redirect("/home?error=no_tokens");
  }

  const gmail = getGmailClient(
    tokens.access_token,
    tokens.refresh_token ?? null
  );

  let profileRes;
  try {
    profileRes = await gmail.users.getProfile({ userId: "me" });
  } catch {
    redirect("/home?error=profile_fetch");
  }

  const email = profileRes.data.emailAddress;
  if (!email) {
    redirect("/home?error=no_email");
  }

  const topicName = process.env.GMAIL_PUBSUB_TOPIC;

  let historyId = profileRes.data.historyId ?? "";
  let watchExpiration: string | null = null;

  if (topicName) {
    try {
      const watchResult = await watchMailbox(gmail, topicName);
      historyId = watchResult.historyId;
      watchExpiration = watchResult.expiration
        ? new Date(parseInt(watchResult.expiration, 10)).toISOString()
        : null;
    } catch (err) {
      console.error("Watch failed (using profile historyId, push disabled):", err);
    }
  }

  const admin = createAdminClient();

  // Upsert the connection first to get the connection ID
  const { data: connectionData, error: upsertError } = await admin
    .from("gmail_connections")
    .upsert(
      {
        user_id: state,
        email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        watch_expiration: watchExpiration,
        history_id: historyId,
      },
      {
        onConflict: "user_id",
      }
    )
    .select("id")
    .single();

  if (upsertError || !connectionData) {
    console.error("Upsert gmail_connections failed:", upsertError);
    redirect("/home?error=db_failed");
  }

  // Fetch initial emails if we have a historyId
  // This ensures users see emails immediately after connecting
  if (historyId) {
    try {
      const result = await fetchNewEmails(gmail, historyId);
      
      // Save initial emails to database
      for (const emailData of result.emails) {
        // Check if this email was previously deleted
        const { data: existingEmail } = await admin
          .from("emails")
          .select("id, deleted_at")
          .eq("gmail_connection_id", connectionData.id)
          .eq("gmail_message_id", emailData.id)
          .single();

        // Skip if email was deleted (don't recreate deleted emails)
        if (existingEmail?.deleted_at) {
          continue;
        }

        await admin.from("emails").upsert(
          {
            gmail_connection_id: connectionData.id,
            gmail_message_id: emailData.id,
            subject: emailData.subject,
            from_address: emailData.from,
            date: emailData.date ? new Date(emailData.date) : null,
            snippet: emailData.snippet,
            deleted_at: null, // Ensure it's not deleted if updating
          },
          {
            onConflict: "gmail_connection_id,gmail_message_id",
          }
        );
      }

      // Update history_id with the latest from fetch
      await admin
        .from("gmail_connections")
        .update({ history_id: result.newHistoryId })
        .eq("id", connectionData.id);
    } catch (err) {
      // Log but don't fail the connection if initial fetch fails
      // User can still sync manually or wait for webhook
      console.error("Initial email fetch failed (non-critical):", err);
    }
  }

  redirect("/home");
}
