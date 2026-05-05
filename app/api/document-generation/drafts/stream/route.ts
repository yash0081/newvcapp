import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { buildGenerationContext, loadDocumentType, preflightDocument, skippedResearchPreflight } from "@/lib/document-generation/generator";
import type { DocumentTypeRow } from "@/lib/document-generation/generator";
import { getResearchModel } from "@/lib/research/research-model-env";
import { stripMarkdownText } from "@/lib/plain-text";
import { vertexStreamText } from "@/lib/vertex";

type StreamBody = {
  dealId?: string | null;
  typeId?: string | null;
  typeName?: string | null;
  outputFormat?: string | null;
  prompt?: string;
  skipResearch?: boolean;
};

function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function draftTitle(content: string, fallback: string): string {
  const firstLine = stripMarkdownText(content)
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || fallback || "Generated document").slice(0, 180);
}

function adHocDocumentType(userId: string, body: StreamBody): DocumentTypeRow {
  const requestedName = typeof body.typeName === "string" && body.typeName.trim()
    ? body.typeName.trim().slice(0, 120)
    : "Document";
  const format = body.outputFormat === "docx" || body.outputFormat === "pdf" || body.outputFormat === "markdown" || body.outputFormat === "text"
    ? body.outputFormat
    : "text";
  return {
    id: "",
    user_id: userId,
    name: requestedName,
    output_format: format,
    description: "Ad hoc document requested from workspace chat.",
    instructions: [
      `Create a complete ${requestedName}.`,
      "Use the user's prompt as the controlling document brief.",
      "Make the result editable as clean plain text.",
    ].join("\n"),
    learned_preferences: "",
    metadata: { ad_hoc: true, source: "chat" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as StreamBody | null;
  const typeId = typeof body?.typeId === "string" ? body.typeId : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 8000) : "";
  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });

  const admin = createAdminClient();
  const type = typeId ? await loadDocumentType(admin, user.id, typeId) : adHocDocumentType(user.id, body ?? {});
  if (!type) return NextResponse.json({ error: "Document type not found" }, { status: 404 });

  const dealId = typeof body?.dealId === "string" ? body.dealId : null;
  const skipResearch = Boolean(body?.skipResearch);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const preflight = skipResearch
          ? skippedResearchPreflight()
          : await preflightDocument({ admin, userId: user.id, dealId, type, prompt });
        if (!preflight.enoughInfo && !skipResearch) {
          controller.enqueue(sse({ type: "needs_research", preflight }));
          controller.close();
          return;
        }

        const context = await buildGenerationContext({ admin, userId: user.id, dealId, type, prompt });
        controller.enqueue(sse({ type: "start", title: `${type.name} draft` }));

        const generationPrompt = `Draft the requested business document.

Rules:
- Follow the saved document type instructions, examples, and learned preferences.
- Write the document itself only. Do not include process commentary.
- Use regular plain text only. Do not use Markdown syntax, markdown headings, bold markers, bullet markers, numbered-list markers, code fences, tables, or link markup.
- Use clear plain section titles when helpful, followed by polished paragraphs.
- Use available company facts and source context. Do not invent precise facts.
- If important information is missing, include a concise open questions section instead of fabricating.
- Keep the draft complete enough to be usable in the document workspace.

Document type:
${JSON.stringify(type)}

User prompt:
${prompt}

Preflight:
${JSON.stringify(preflight)}

Context:
${JSON.stringify(context).slice(0, 30000)}`;

        let rawContent = "";
        for await (const chunk of vertexStreamText(getResearchModel("flash"), generationPrompt, false)) {
          if (!chunk) continue;
          rawContent += chunk;
          controller.enqueue(sse({ type: "delta", text: chunk }));
        }

        const content = stripMarkdownText(rawContent).trim() || rawContent.trim() || "No usable draft was generated.";
        const title = draftTitle(content, `${type.name} draft`);
        const ins = await admin
          .schema("deal_intel")
          .from("generated_document_draft")
          .insert({
            user_id: user.id,
            deal_id: dealId,
            type_id: type.id || null,
            title,
            prompt,
            content,
            status: "ready",
            missing_info: preflight.missingInfo,
            research_steps: preflight.researchSteps,
            metadata: {
              preflight_rationale: preflight.rationale,
              skipped_research: skipResearch,
              output_format: type.output_format,
            },
          })
          .select("id, deal_id, type_id, title, prompt, content, status, missing_info, research_steps, metadata, created_at, updated_at")
          .single();

        if (ins.error) {
          controller.enqueue(sse({ type: "error", error: ins.error.message }));
          controller.close();
          return;
        }

        controller.enqueue(sse({ type: "done", draft: ins.data, preflight }));
        controller.close();
      } catch (error) {
        controller.enqueue(sse({ type: "error", error: error instanceof Error ? error.message : "Document generation failed" }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
