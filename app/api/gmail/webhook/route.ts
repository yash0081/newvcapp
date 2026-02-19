import { createAdminClient } from "@/lib/supabase/admin";
import { getGmailClient, fetchNewEmails } from "@/lib/gmail";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const message = body.message;
    if (!message?.data) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    const decoded = Buffer.from(message.data, "base64url").toString("utf-8");
    const { emailAddress, historyId } = JSON.parse(decoded) as {
      emailAddress?: string;
      historyId?: string;
    };

    if (!emailAddress || !historyId) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: conn, error: connError } = await admin
      .from("gmail_connections")
      .select("id, access_token, refresh_token, history_id")
      .eq("email", emailAddress)
      .single();

    if (connError || !conn) {
      console.error("Webhook: connection not found for", emailAddress);
      return NextResponse.json({ ok: true }); // 200 to ack, avoid retries
    }

    const startHistoryId = conn.history_id;
    if (!startHistoryId) {
      return NextResponse.json({ ok: true });
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
        console.error("Webhook: Authentication failed (token expired/invalid) for", emailAddress);
        // Delete the connection since tokens are invalid
        await admin.from("gmail_connections").delete().eq("id", conn.id);
        // Return ok: true to acknowledge and prevent retries
        return NextResponse.json({ ok: true });
      }
      
      console.error("Webhook: fetchNewEmails failed:", err);
      return NextResponse.json({ ok: false }, { status: 500 });
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

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
