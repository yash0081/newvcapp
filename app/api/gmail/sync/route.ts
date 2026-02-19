import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGmailClient, fetchNewEmails } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: conn, error: connError } = await admin
    .from("gmail_connections")
    .select("id, access_token, refresh_token, history_id")
    .eq("user_id", user.id)
    .single();

  if (connError || !conn) {
    return NextResponse.json(
      { error: "No Gmail connection" },
      { status: 400 }
    );
  }

  const startHistoryId = conn.history_id;
  if (!startHistoryId) {
    return NextResponse.json({ synced: 0 });
  }

  const gmail = getGmailClient(
    conn.access_token,
    conn.refresh_token ?? null
  );

  let result;
  try {
    result = await fetchNewEmails(gmail, startHistoryId);
  } catch (err: unknown) {
    // Check if it's an authentication error (expired/invalid token)
    const status = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    
    if (status === 401 || status === 403) {
      console.error("Sync failed: Authentication error (token expired/invalid)");
      // Delete the connection since tokens are invalid
      await admin.from("gmail_connections").delete().eq("id", conn.id);
      return NextResponse.json(
        { error: "Gmail connection expired. Please reconnect your Gmail account." },
        { status: 401 }
      );
    }
    
    console.error("Sync failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch emails" },
      { status: 500 }
    );
  }

  for (const email of result.emails) {
    // Check if this email was previously deleted
    const { data: existingEmail } = await admin
      .from("emails")
      .select("id, deleted_at")
      .eq("gmail_connection_id", conn.id)
      .eq("gmail_message_id", email.id)
      .single();

    // Skip if email was deleted (don't recreate deleted emails)
    if (existingEmail?.deleted_at) {
      continue;
    }

    await admin.from("emails").upsert(
      {
        gmail_connection_id: conn.id,
        gmail_message_id: email.id,
        subject: email.subject,
        from_address: email.from,
        date: email.date ? new Date(email.date) : null,
        snippet: email.snippet,
        deleted_at: null, // Ensure it's not deleted if updating
      },
      {
        onConflict: "gmail_connection_id,gmail_message_id",
      }
    );
  }

  await admin
    .from("gmail_connections")
    .update({ history_id: result.newHistoryId })
    .eq("id", conn.id);

  return NextResponse.json({ synced: result.emails.length });
}
