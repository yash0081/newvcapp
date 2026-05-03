import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { stripMarkdownText } from "@/lib/plain-text";

export async function PATCH(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { draftId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { title?: unknown; content?: unknown } | null;
  const title = typeof body?.title === "string" ? stripMarkdownText(body.title).trim().slice(0, 180) : "";
  const content = typeof body?.content === "string" ? stripMarkdownText(body.content).trim() : "";
  if (!content) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .update({
      ...(title ? { title } : {}),
      content,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .eq("user_id", user.id)
    .select("id, title, content, status, updated_at")
    .maybeSingle();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  if (!res.data) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  return NextResponse.json({ draft: res.data });
}
