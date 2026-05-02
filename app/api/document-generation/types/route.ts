import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";

function asOutputFormat(v: unknown): "markdown" | "docx" | "pdf" | "text" {
  return v === "docx" || v === "pdf" || v === "text" ? v : "text";
}

export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("document_generation_type")
    .select("id, name, output_format, description, instructions, learned_preferences, metadata, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ types: res.data ?? [] });
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { name?: string; outputFormat?: string; description?: string; instructions?: string }
    | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("document_generation_type")
    .insert({
      user_id: user.id,
      name,
      output_format: asOutputFormat(body?.outputFormat),
      description: typeof body?.description === "string" ? body.description.trim().slice(0, 4000) : "",
      instructions: typeof body?.instructions === "string" ? body.instructions.trim().slice(0, 12000) : "",
    })
    .select("id, name, output_format, description, instructions, learned_preferences, metadata, created_at, updated_at")
    .single();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ type: res.data });
}
