import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAnalysisShell, runPipelineAndPersist } from "@/lib/run-analysis";

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
    return NextResponse.json({ error: "No PDF file provided" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  const maxBytes =
    Number(process.env.PITCH_DECK_PDF_MAX_BYTES) || 10 * 1024 * 1024;
  const minBytes = 50 * 1024;

  if (pdfBuffer.length < minBytes || pdfBuffer.length > maxBytes) {
    return NextResponse.json(
      {
        error: `PDF size must be between ${minBytes} and ${maxBytes} bytes`,
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  let fundThesisStatement: string | null = null;
  const { data: thesisRow } = await admin
    .from("fund_thesis")
    .select("thesis_text")
    .eq("user_id", user.id)
    .maybeSingle();
  if (thesisRow && typeof (thesisRow as { thesis_text?: string }).thesis_text === "string") {
    fundThesisStatement = (thesisRow as { thesis_text: string }).thesis_text;
  }

  try {
    const { dealId, analysisId, updateStatus } = await createAnalysisShell({
      admin,
      userId: user.id,
      pdfUrl: null,
    });

    await runPipelineAndPersist({
      admin,
      userId: user.id,
      dealId,
      analysisId,
      pdfBuffer,
      pdfUrl: null,
      fundThesisStatement,
      updateStatus,
    });

    return NextResponse.json({ ok: true, dealId, analysisId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Upload pitch deck failed:", err);
    return NextResponse.json(
      { error: "Failed to start analysis", detail: message },
      { status: 500 }
    );
  }
}

