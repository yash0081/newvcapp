import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** List chat threads for the current user (newest first). Optional `dealId` returns at most one thread for that deal. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dealId = request.nextUrl.searchParams.get("dealId")?.trim();
  const limit = dealId ? 1 : 100;

  let q = supabase
    .from("chat_threads")
    .select("id, title, deal_id, created_at, updated_at")
    .eq("user_id", user.id);
  if (dealId) {
    q = q.eq("deal_id", dealId);
  }
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ threads: data ?? [] });
}

/** Create an empty thread (optionally scoped to a deal for “open chat” from a deal page). */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { deal_id?: string | null; title?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const titleRaw = typeof body.title === "string" ? body.title.trim() : "";
  const title = titleRaw ? titleRaw.slice(0, 80) : "New chat";

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chat_threads")
    .insert({
      user_id: user.id,
      deal_id: body.deal_id ?? null,
      title,
    })
    .select("id, title, deal_id, created_at, updated_at")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Failed to create thread" }, { status: 500 });
  }

  return NextResponse.json({ thread: data });
}
