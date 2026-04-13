import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Create a user-defined column (explicit or inferred template). Values filled separately / via jobs. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    key: string;
    label: string;
    data_type?: "number" | "text" | "bool" | "json";
    origin?: "explicit_user" | "inferred_llm";
    compute_tier?: "cheap" | "expensive";
    formula_or_prompt_ref?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim().toLowerCase().replace(/\s+/g, "_") : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!key || !label) return NextResponse.json({ error: "key and label required" }, { status: 400 });

  const { data, error } = await supabase
    .from("deal_feature_definitions")
    .insert({
      user_id: user.id,
      key,
      label,
      data_type: body.data_type ?? "text",
      origin: body.origin ?? "explicit_user",
      compute_tier: body.compute_tier ?? "cheap",
      formula_or_prompt_ref: body.formula_or_prompt_ref ?? null,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Column key already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ id: data?.id });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("deal_feature_definitions")
    .select("id, key, label, data_type, origin, compute_tier")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ columns: data ?? [] });
}
