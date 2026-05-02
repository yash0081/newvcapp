import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { generateDocumentContent, loadDocumentType, preflightDocument } from "@/lib/document-generation/generator";

export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .select("id, deal_id, type_id, title, prompt, content, status, missing_info, research_steps, metadata, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(40);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ drafts: res.data ?? [] });
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { dealId?: string | null; typeId?: string; prompt?: string; skipResearch?: boolean }
    | null;
  const typeId = typeof body?.typeId === "string" ? body.typeId : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 8000) : "";
  if (!typeId || !prompt) return NextResponse.json({ error: "typeId and prompt are required" }, { status: 400 });

  const admin = createAdminClient();
  const type = await loadDocumentType(admin, user.id, typeId);
  if (!type) return NextResponse.json({ error: "Document type not found" }, { status: 404 });

  const dealId = typeof body?.dealId === "string" ? body.dealId : null;
  const preflight = await preflightDocument({ admin, userId: user.id, dealId, type, prompt });
  if (!preflight.enoughInfo && !body?.skipResearch) {
    return NextResponse.json({ needsResearch: true, preflight }, { status: 409 });
  }

  const generated = await generateDocumentContent({ admin, userId: user.id, dealId, type, prompt, preflight });
  const ins = await admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .insert({
      user_id: user.id,
      deal_id: dealId,
      type_id: type.id,
      title: generated.title,
      prompt,
      content: generated.content,
      status: "ready",
      missing_info: preflight.missingInfo,
      research_steps: preflight.researchSteps,
      metadata: {
        preflight_rationale: preflight.rationale,
        skipped_research: Boolean(body?.skipResearch),
        output_format: type.output_format,
      },
    })
    .select("id, deal_id, type_id, title, prompt, content, status, missing_info, research_steps, metadata, created_at, updated_at")
    .single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
  return NextResponse.json({ draft: ins.data, preflight });
}
