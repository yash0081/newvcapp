import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGmailClient, stopWatchMailbox } from "@/lib/gmail";
import { redirect } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  
  // Get the connection before deleting it
  const { data: conn, error: connError } = await admin
    .from("gmail_connections")
    .select("id, access_token, refresh_token, watch_expiration")
    .eq("user_id", user.id)
    .single();

  if (connError || !conn) {
    return NextResponse.json(
      { error: "No Gmail connection found" },
      { status: 404 }
    );
  }

  // Try to stop the watch subscription if it exists and hasn't expired
  if (conn.watch_expiration) {
    const expirationDate = new Date(conn.watch_expiration);
    const now = new Date();
    
    // Only try to stop if the watch hasn't expired yet
    if (expirationDate > now) {
      try {
        const gmail = getGmailClient(
          conn.access_token,
          conn.refresh_token ?? null
        );
        await stopWatchMailbox(gmail);
      } catch (err) {
        // If stopping fails (e.g., tokens expired), log but continue with deletion
        // The watch will expire naturally anyway
        console.error("Failed to stop watch subscription (may be expired):", err);
      }
    }
  }

  // Delete the connection (this will cascade delete emails due to ON DELETE CASCADE)
  const { error: deleteError } = await admin
    .from("gmail_connections")
    .delete()
    .eq("id", conn.id);

  if (deleteError) {
    console.error("Failed to delete Gmail connection:", deleteError);
    return NextResponse.json(
      { error: "Failed to disconnect Gmail" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
