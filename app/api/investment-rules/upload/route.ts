import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processInvestmentRuleDocument } from "@/lib/investment-rules";

const BUCKET = "investment-rules";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  const maxBytes = Number(process.env.INVESTMENT_RULES_PDF_MAX_BYTES) || 10 * 1024 * 1024;
  const minBytes = 10 * 1024;

  if (pdfBuffer.length < minBytes || pdfBuffer.length > maxBytes) {
    return NextResponse.json(
      { error: `PDF size must be between ${minBytes} and ${maxBytes} bytes` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const docId = randomUUID();
  const storagePath = `${user.id}/${docId}.pdf`;
  const originalName =
    typeof (file as File).name === "string" ? (file as File).name : "criteria.pdf";

  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: false,
  });

  if (upErr) {
    console.error("investment-rules storage upload:", upErr);
    return NextResponse.json(
      { error: upErr.message || "Storage upload failed. Ensure bucket 'investment-rules' exists." },
      { status: 500 }
    );
  }

  const { data: inserted, error: insErr } = await admin
    .from("investment_rule_documents")
    .insert({
      id: docId,
      user_id: user.id,
      storage_path: storagePath,
      original_filename: originalName,
      mime_type: "application/pdf",
      status: "processing",
    })
    .select("id")
    .single();

  if (insErr || !inserted?.id) {
    console.error("investment_rule_documents insert:", insErr);
    try {
      await admin.storage.from(BUCKET).remove([storagePath]);
    } catch {
      /* ignore */
    }
    return NextResponse.json({ error: insErr?.message || "Failed to create document row" }, { status: 500 });
  }

  try {
    const { rulesInserted } = await processInvestmentRuleDocument({
      admin,
      userId: user.id,
      documentId: docId,
      pdfBuffer,
    });
    await admin
      .from("investment_rule_documents")
      .update({ status: "processed", updated_at: new Date().toISOString(), error_message: null })
      .eq("id", docId)
      .eq("user_id", user.id);

    return NextResponse.json({ documentId: docId, rulesInserted, status: "processed" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("processInvestmentRuleDocument:", e);
    await admin
      .from("investment_rule_documents")
      .update({
        status: "failed",
        error_message: message.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId)
      .eq("user_id", user.id);
    return NextResponse.json({ error: message || "Processing failed", documentId: docId }, { status: 500 });
  }
}
