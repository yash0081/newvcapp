import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** List saved spreadsheets (newest first). */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_spreadsheets")
    .select("id, name, deal_ids, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ spreadsheets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { name?: string; deal_ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "Untitled";
  const dealIds = Array.isArray(body.deal_ids) ? body.deal_ids.filter((x): x is string => typeof x === "string") : [];

  const { data, error } = await supabase
    .from("user_spreadsheets")
    .insert({
      user_id: user.id,
      name,
      deal_ids: dealIds,
    })
    .select("id, name, deal_ids, created_at, updated_at")
    .single();

  if (error || !data) return NextResponse.json({ error: error?.message ?? "Failed" }, { status: 500 });
  return NextResponse.json({ spreadsheet: data });
}
