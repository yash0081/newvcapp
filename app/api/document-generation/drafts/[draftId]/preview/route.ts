import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { buildGeneratedDocumentPreview } from "@/lib/document-generation/download";

export async function GET(_req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .select("id, title, content, metadata")
    .eq("id", draftId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  if (!res.data) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

  const draft = res.data as {
    title: string | null;
    content: string | null;
    metadata: Record<string, unknown> | null;
  };
  const format = typeof draft.metadata?.output_format === "string" ? draft.metadata.output_format : "markdown";
  const preview = buildGeneratedDocumentPreview({
    title: draft.title || "Generated document",
    content: draft.content || "",
    format,
  });

  let body: BodyInit;
  if (typeof preview.body === "string") {
    body = preview.body;
  } else {
    const arrayBuffer = new ArrayBuffer(preview.body.byteLength);
    new Uint8Array(arrayBuffer).set(preview.body);
    body = arrayBuffer;
  }

  return new NextResponse(body, {
    headers: {
      "Content-Type": preview.contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
