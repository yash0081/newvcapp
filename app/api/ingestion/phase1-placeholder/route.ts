import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ingestPhase1PlaceholderFromPdf,
  ingestPhase1PlaceholderFromText,
} from "@/lib/ingestion/ingest-phase1-placeholder";
import { formatSupabaseError } from "@/lib/supabase/error-format";

const MIN_TEXT_CHARS = 50;
const MAX_TEXT_CHARS = Number(process.env.INGEST_PLACEHOLDER_MAX_TEXT_CHARS) || 100_000;
const MIN_PDF_BYTES = Number(process.env.INGEST_PLACEHOLDER_MIN_PDF_BYTES) || 1 * 1024;
const MAX_PDF_BYTES = Number(process.env.PITCH_DECK_PDF_MAX_BYTES) || 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";

  const admin = createAdminClient();

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: "No PDF file provided" }, { status: 400 });
      }

      const arrayBuffer = await file.arrayBuffer();
      const pdfBuffer = Buffer.from(arrayBuffer);

      if (pdfBuffer.length < MIN_PDF_BYTES || pdfBuffer.length > MAX_PDF_BYTES) {
        return NextResponse.json(
          {
            error: `PDF size must be between ${MIN_PDF_BYTES} and ${MAX_PDF_BYTES} bytes`,
          },
          { status: 400 }
        );
      }

      const ids = await ingestPhase1PlaceholderFromPdf(admin, user.id, pdfBuffer);
      return NextResponse.json({ dealId: ids.dealId, revisionId: ids.revisionId, analysisId: ids.revisionId });
    }

    if (contentType.includes("application/json")) {
      let body: { text?: string };
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        return NextResponse.json({ error: "text is required" }, { status: 400 });
      }

      if (text.length < MIN_TEXT_CHARS) {
        return NextResponse.json(
          { error: `text must be at least ${MIN_TEXT_CHARS} characters` },
          { status: 400 }
        );
      }

      if (text.length > MAX_TEXT_CHARS) {
        return NextResponse.json(
          { error: `text exceeds maximum length (${MAX_TEXT_CHARS} characters)` },
          { status: 413 }
        );
      }

      const ids = await ingestPhase1PlaceholderFromText(admin, user.id, text);
      return NextResponse.json({ dealId: ids.dealId, revisionId: ids.revisionId, analysisId: ids.revisionId });
    }

    return NextResponse.json(
      { error: 'Expected Content-Type application/json or multipart/form-data' },
      { status: 400 }
    );
  } catch (e) {
    const msg = formatSupabaseError(e, "Phase1 placeholder ingestion failed");
    console.error("phase1-placeholder:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
