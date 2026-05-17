import { ingestTextAsDocument, type AdminClient } from "@/lib/research/document-ingest";
import type { ResearchSource } from "@/lib/research/types";
import { sanitizeResearchNotes, sanitizeResearchSources } from "@/lib/research/public-output";
import { stripMarkdownText } from "@/lib/plain-text";

function formatSources(sources: ResearchSource[]): string {
  if (!sources.length) return "";
  const lines = sources.map((s) => {
    const title = s.title?.trim();
    const url = s.url?.trim();
    if (!url) return null;
    return `Source: ${title ? `${title} - ` : ""}${url}`;
  }).filter(Boolean) as string[];
  return lines.length ? `\n\nSources:\n${lines.join("\n")}` : "";
}

export async function ingestResearchStepOutputAsDocument(args: {
  admin: AdminClient;
  userId: string;
  dealId: string;
  workflowId: string;
  stepId: string;
  runId: string;
  website: string;
  task: string;
  notes: string;
  sources: ResearchSource[];
}): Promise<{ documentId: string } | null> {
  const notes = sanitizeResearchNotes(args.notes);
  const sources = sanitizeResearchSources(args.sources);

  const docText = `${notes}${formatSources(sources)}`.trim();
  if (!docText) return null;

  // Chunk aligned to citations: one chunk for the notes + one per source.
  const chunkTextsOverride = [
    notes,
    ...sources
      .filter((s) => s?.url)
      .map((s) => {
        const title = s.title?.trim() ? `Title: ${s.title!.trim()}\n` : "";
        const snippet = s.snippet?.trim() ? `Snippet: ${s.snippet!.trim()}\n` : "";
        return `SOURCE ${s.url}\n${title}${snippet}`.trim();
      }),
  ].map((t) => String(t || "").trim()).filter(Boolean);

  return ingestTextAsDocument({
    admin: args.admin,
    userId: args.userId,
    dealId: args.dealId,
    text: docText,
    sourceKind: "web",
    docType: "research_step_output",
    originalFilename: `Research step - ${args.website}: ${stripMarkdownText(args.task)}`.slice(0, 180),
    mimeType: "text/plain",
    storageBucket: "web",
    storagePathPrefix: `web/${args.userId}`,
    folderPath: "Web research",
    routingReason: "research_step_output",
    pageMetadata: {
      kind: "research_step_output",
      workflow_id: args.workflowId,
      step_id: args.stepId,
      run_id: args.runId,
      website: args.website,
      task: args.task,
      sources,
    },
    fastEmbedLimit: 6,
    maxChunks: 64,
    chunkTextsOverride,
  });
}
