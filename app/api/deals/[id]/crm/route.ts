import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: dealId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { crm_notes?: string | null; crm_stage?: string | null; crm_next_step?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { error } = await supabase
    .from("deals")
    .update({
      crm_notes: body.crm_notes ?? null,
      crm_stage: body.crm_stage ?? null,
      crm_next_step: body.crm_next_step ?? null,
    })
    .eq("id", dealId)
    .eq("user_id", user.id);

  if (error) {
    console.error("CRM update:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
