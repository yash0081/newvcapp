import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractPdfTextByPage } from "@/lib/deal-intel/pdf-text";

export async function POST(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: doc, error: docErr } = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id, storage_bucket, storage_path")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (docErr) {
    console.error("deal_intel.document parse lookup:", docErr);
    return NextResponse.json({ error: docErr.message || "Failed to load document" }, { status: 500 });
  }
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: downloaded, error: dlErr } = await admin.storage.from(doc.storage_bucket).download(doc.storage_path);
  if (dlErr || !downloaded) {
    console.error("storage download:", dlErr);
    return NextResponse.json({ error: dlErr?.message || "Failed to download PDF" }, { status: 500 });
  }

  const arrayBuffer = await downloaded.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  try {
    const pages = await extractPdfTextByPage(pdfBuffer);

    // Replace derived rows for idempotency.
    await admin.schema("deal_intel").from("document_page").delete().eq("document_id", documentId);

    const rows = pages.map((p) => ({
      document_id: documentId,
      page_number: p.pageNumber,
      text: p.text,
      char_count: p.text.length,
      metadata: {},
    }));

    if (rows.length > 0) {
      const { error: insErr } = await admin.schema("deal_intel").from("document_page").insert(rows);
      if (insErr) throw insErr;
    }

    await admin
      .schema("deal_intel")
      .from("document")
      .update({ status: "parsed", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("user_id", user.id);

    return NextResponse.json({ documentId, pages: rows.length, status: "parsed" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("parse pdf failed:", e);
    await admin
      .schema("deal_intel")
      .from("document")
      .update({ status: "error", error_message: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("user_id", user.id);
    return NextResponse.json({ error: message || "Parse failed", documentId }, { status: 500 });
  }
}

