import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { folderPath?: string | null } | null;
  const folderPathRaw = body?.folderPath;
  const folderPath =
    folderPathRaw == null ? null : typeof folderPathRaw === "string" && folderPathRaw.trim() ? folderPathRaw.trim() : null;

  const admin = createAdminClient();
  const { error } = await admin
    .schema("deal_intel")
    .from("document")
    .update({ folder_path: folderPath, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message || "Failed to move document" }, { status: 500 });
  return NextResponse.json({ ok: true, documentId, folderPath });
}

