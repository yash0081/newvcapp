import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_req: Request, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: docs, error } = await supabase
    .schema("deal_intel")
    .from("document")
    .select("id, original_filename, folder_path, source_kind, mime_type, status, created_at")
    .eq("deal_id", dealId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message || "Failed to load documents" }, { status: 500 });
  return NextResponse.json({ dealId, documents: docs ?? [] });
}

