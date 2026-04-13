import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: docs, error: docsErr } = await supabase
    .from("investment_rule_documents")
    .select("id, storage_path, original_filename, status, error_message, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (docsErr) {
    return NextResponse.json({ error: docsErr.message }, { status: 500 });
  }

  const { data: ctxRow } = await supabase
    .from("user_investment_rules_context")
    .select("aggregated_by_section, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    documents: docs ?? [],
    aggregatedBySection: ctxRow?.aggregated_by_section ?? null,
    contextUpdatedAt: ctxRow?.updated_at ?? null,
  });
}
