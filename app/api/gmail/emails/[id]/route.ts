import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: emailId } = await params;
  if (!emailId) {
    return NextResponse.json({ error: "Email ID required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify the email belongs to the user
  const { data: email, error: emailError } = await admin
    .from("emails")
    .select("id, gmail_connection_id, gmail_connections!inner(user_id)")
    .eq("id", emailId)
    .single();

  if (emailError || !email) {
    return NextResponse.json({ error: "Email not found" }, { status: 404 });
  }

  // Check if email belongs to the user (via RLS, but double-check with admin)
  const connection = email.gmail_connections as unknown as { user_id: string };
  const connectionUserId = connection.user_id;
  if (connectionUserId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Soft delete by setting deleted_at timestamp
  const { error: deleteError } = await admin
    .from("emails")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", emailId);

  if (deleteError) {
    console.error("Failed to delete email:", deleteError);
    return NextResponse.json(
      { error: "Failed to delete email" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
