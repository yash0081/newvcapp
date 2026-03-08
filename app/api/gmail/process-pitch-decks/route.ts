import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processPitchDecksForConnection } from "@/lib/process-pitch-decks";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const admin = createAdminClient();
  let conn: { id: string; user_id: string; access_token: string; refresh_token: string | null } | null = null;
  let messageIdsFilter: string[] | null = null;

  // Internal call from webhook: secret + messageIds + emailAddress (no user session)
  const internalSecret = request.headers.get("x-internal-secret");
  const secret = process.env.INTERNAL_SECRET;
  if (secret && internalSecret === secret) {
    try {
      const body = await request.json().catch(() => ({}));
      const { messageIds, emailAddress } = body as { messageIds?: string[]; emailAddress?: string };
      if (Array.isArray(messageIds) && messageIds.length && typeof emailAddress === "string") {
        const { data: connection, error: connError } = await admin
          .from("gmail_connections")
          .select("id, user_id, access_token, refresh_token")
          .eq("email", emailAddress)
          .single();
        if (!connError && connection) {
          conn = connection;
          messageIdsFilter = messageIds;
        }
      }
    } catch {
      // ignore
    }
  }

  // Normal call: require user session
  if (!conn) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: connection, error: connError } = await admin
      .from("gmail_connections")
      .select("id, user_id, access_token, refresh_token")
      .eq("user_id", user.id)
      .single();
    if (connError || !connection) {
      return NextResponse.json(
        { error: "No Gmail connection" },
        { status: 400 }
      );
    }
    conn = connection;
  }

  const result = await processPitchDecksForConnection(admin, conn, messageIdsFilter);

  if (result.total === 0 && messageIdsFilter?.length) {
    return NextResponse.json({
      ...result,
      message: "No matching emails to process",
    });
  }

  return NextResponse.json({
    processed: result.processed,
    total: result.total,
    skippedNoPdf: result.skippedNoPdf,
    skippedSize: result.skippedSize,
    skippedAlreadyScored: result.skippedAlreadyScored,
    errors: result.errors.length ? result.errors.slice(0, 10) : undefined,
    debug: result.debug.slice(0, 20),
  });
}
