import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { extractPdfTextByPage } from "@/lib/deal-intel/pdf-text";

type RefKind = "description" | "template" | "sample" | "notes";

function asKind(v: unknown): RefKind {
  return v === "template" || v === "sample" || v === "notes" || v === "description" ? v : "description";
}

async function fileToReferenceContent(file: Blob): Promise<{ filename: string; content: string; metadata: Record<string, unknown> }> {
  const filename = typeof (file as File).name === "string" && (file as File).name.trim()
    ? (file as File).name.slice(0, 240)
    : "uploaded-reference";
  const mimeType = file.type || "application/octet-stream";
  const isPdf = mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return {
      filename,
      content: (await file.text()).slice(0, 120000),
      metadata: { mime_type: mimeType, extraction: "text" },
    };
  }

  const pdfBuffer = Buffer.from(await file.arrayBuffer());
  const pages = await extractPdfTextByPage(pdfBuffer);
  const content = pages
    .filter((p) => p.text.trim())
    .map((p) => `Page ${p.pageNumber}\n${p.text}`)
    .join("\n\n")
    .slice(0, 120000);
  return {
    filename,
    content,
    metadata: {
      mime_type: mimeType,
      extraction: "pdf_text_by_page",
      page_count: pages.length,
    },
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ typeId: string }> }) {
  const { typeId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("document_generation_reference")
    .select("id, type_id, kind, filename, content, metadata, created_at")
    .eq("type_id", typeId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ references: res.data ?? [] });
}

export async function POST(req: Request, ctx: { params: Promise<{ typeId: string }> }) {
  const { typeId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();

  const typeRes = await admin
    .schema("deal_intel")
    .from("document_generation_type")
    .select("id")
    .eq("id", typeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (typeRes.error) return NextResponse.json({ error: typeRes.error.message }, { status: 500 });
  if (!typeRes.data) return NextResponse.json({ error: "Document type not found" }, { status: 404 });

  const contentType = req.headers.get("content-type") || "";
  let kind: RefKind = "description";
  let filename: string | null = null;
  let content = "";
  let metadata: Record<string, unknown> = {};

  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData();
    kind = asKind(fd.get("kind"));
    const file = fd.get("file");
    const text = fd.get("content");
    if (file instanceof Blob) {
      const extracted = await fileToReferenceContent(file);
      filename = extracted.filename;
      content = extracted.content;
      metadata = extracted.metadata;
    } else if (typeof text === "string") {
      content = text.slice(0, 120000);
      metadata = { extraction: "pasted_text" };
    }
  } else {
    const body = (await req.json().catch(() => null)) as
      | { kind?: string; filename?: string; content?: string }
      | null;
    kind = asKind(body?.kind);
    filename = typeof body?.filename === "string" && body.filename.trim() ? body.filename.trim().slice(0, 240) : null;
    content = typeof body?.content === "string" ? body.content.slice(0, 120000) : "";
    metadata = { extraction: "json_text" };
  }

  if (!content.trim()) return NextResponse.json({ error: "No extractable text found in this reference." }, { status: 400 });
  const ins = await admin
    .schema("deal_intel")
    .from("document_generation_reference")
    .insert({ type_id: typeId, user_id: user.id, kind, filename, content, metadata })
    .select("id, type_id, kind, filename, content, metadata, created_at")
    .single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
  return NextResponse.json({ reference: ins.data });
}
