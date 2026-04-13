import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runPipelineAndPersist } from "@/lib/run-analysis";
import { emitOrderedDeepResearchSections } from "@/lib/deep-research-ordered-sections";

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
  const threadIdRaw = formData.get("threadId");
  const threadId =
    typeof threadIdRaw === "string" && threadIdRaw.trim().length > 0 ? threadIdRaw.trim() : null;
  const fileNameRaw = formData.get("fileName");
  const fileLabel =
    typeof fileNameRaw === "string" && fileNameRaw.trim().length > 0 ? fileNameRaw.trim() : "deck.pdf";

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

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        if (threadId) {
          const { data: th } = await admin
            .from("chat_threads")
            .select("id")
            .eq("id", threadId)
            .eq("user_id", user.id)
            .maybeSingle();
          if (!th) {
            send({ type: "error", message: "Invalid thread" });
            return;
          }
          await admin.from("chat_messages").insert({
            thread_id: threadId,
            role: "user",
            content: `Deep research — PDF: ${fileLabel}`,
          });
        }

        const startedAt = Date.now();
        const { dealId, analysisId, result } = await runPipelineAndPersist({
          admin,
          userId: user.id,
          pdfBuffer,
          pdfUrl: null,
          fundThesisStatement,
          onStep: async (step) => {
            send({ type: "step", step });
          },
        });
        send({ type: "timing", elapsedMs: Date.now() - startedAt, phase: "pipeline" });

        const sectionMd = await emitOrderedDeepResearchSections({
          result,
          send,
        });

        const footer = `\n\n---\nDeep research complete.\n/home/deal/${dealId}`;
        const assistantContent = `${sectionMd}${footer}`;

        if (threadId) {
          await admin.from("chat_messages").insert({
            thread_id: threadId,
            role: "assistant",
            content: assistantContent,
          });
          await admin
            .from("chat_threads")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", threadId);
        }

        send({ type: "done", dealId, analysisId, threadId: threadId ?? undefined });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Upload pitch deck failed:", err);
        send({ type: "error", message: message || "Analysis failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
