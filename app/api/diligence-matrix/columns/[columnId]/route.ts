import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";

export async function DELETE(_: Request, ctx: { params: Promise<{ columnId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { columnId } = await ctx.params;
  if (!columnId) return NextResponse.json({ error: "columnId is required" }, { status: 400 });
  const admin = createAdminClient();
  try {
    const res = await admin
      .schema("deal_intel")
      .from("diligence_matrix_column")
      .delete()
      .eq("id", columnId)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) return NextResponse.json({ error: "Column not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete column";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
