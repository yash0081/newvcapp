import { randomUUID, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = process.env.CRM_DOCS_BUCKET || "crm_docs";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeFilename(name: string): string {
  const trimmed = name.trim() || "document.pdf";
  return trimmed.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const folderPathRaw = formData.get("folderPath");
  const folderPath =
    typeof folderPathRaw === "string" && folderPathRaw.trim().length > 0 ? folderPathRaw.trim() : null;

  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No PDF file provided" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  const maxBytes = Number(process.env.CRM_DOCS_PDF_MAX_BYTES) || 25 * 1024 * 1024;
  const minBytes = Number(process.env.CRM_DOCS_PDF_MIN_BYTES) || 1; // only reject empty uploads by default
  if (pdfBuffer.length < minBytes || pdfBuffer.length > maxBytes) {
    return NextResponse.json(
      { error: `PDF size must be between ${minBytes} and ${maxBytes} bytes` },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Ensure deal exists and belongs to user (in deal_intel).
  const { data: deal, error: dealErr } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealErr) {
    console.error("deal_intel.deal lookup:", dealErr);
    return NextResponse.json({ error: dealErr.message || "Failed to validate company" }, { status: 500 });
  }
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const documentId = randomUUID();
  const originalName =
    typeof (file as File).name === "string" && (file as File).name.trim() ? (file as File).name : "document.pdf";
  const filename = safeFilename(originalName);
  const yyyyMm = new Date().toISOString().slice(0, 7); // YYYY-MM
  // Deterministic, company-scoped storage layout (per PDFs/plan):
  // companies/<deal_id>/<yyyy-mm>/<document_id>/<filename>
  const storagePath = `companies/${dealId}/${yyyyMm}/${documentId}/${filename}`;

  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upErr) {
    console.error("crm_docs storage upload:", upErr);
    return NextResponse.json(
      { error: upErr.message || `Storage upload failed. Ensure bucket '${BUCKET}' exists.` },
      { status: 500 },
    );
  }

  const digest = sha256(pdfBuffer);
  const { data: inserted, error: insErr } = await admin
    .schema("deal_intel")
    .from("document")
    .insert({
      id: documentId,
      user_id: user.id,
      deal_id: dealId,
      source_kind: "pitch_deck",
      original_filename: originalName,
      mime_type: "application/pdf",
      byte_size: pdfBuffer.length,
      sha256: digest,
      storage_provider: "supabase_storage",
      storage_bucket: BUCKET,
      storage_path: storagePath,
      folder_path: folderPath,
      status: "uploaded",
      error_message: null,
    })
    .select("id")
    .single();

  if (insErr || !inserted?.id) {
    console.error("deal_intel.document insert:", insErr);
    try {
      await admin.storage.from(BUCKET).remove([storagePath]);
    } catch {
      /* ignore */
    }
    return NextResponse.json({ error: insErr?.message || "Failed to create document row" }, { status: 500 });
  }

  return NextResponse.json({
    documentId,
    bucket: BUCKET,
    storagePath,
    status: "uploaded",
  });
}

