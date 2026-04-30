import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ingestTextAsDocument,
  type AdminClient,
  type IngestPage,
} from "@/lib/research/document-ingest";
import type { AcceptedSnippet, CopilotSession } from "@/lib/copilot/types";

function buildHeader(args: { companyName: string; session: CopilotSession; snippetCount: number }): string {
  return (
    `# Research copilot session for ${args.companyName || "Company"}\n` +
    `Session id: ${args.session.id}\n` +
    `Started: ${args.session.started_at}\n` +
    `Snippets: ${args.snippetCount}\n`
  );
}

function buildSnippetPage(args: {
  snippet: AcceptedSnippet;
  index: number;
}): { text: string; metadata: Record<string, unknown> } {
  const s = args.snippet;
  const label = s.source_label || s.hostname || "screen";
  const url = s.source_url ? ` (${s.source_url})` : "";
  const ts = s.accepted_at ? ` @ ${s.accepted_at}` : "";
  return {
    text: `## ${args.index + 1}. ${label}${url}${ts}\n${s.text.trim()}`,
    metadata: {
      snippet_index: args.index + 1,
      source_label: label,
      source_url: s.source_url ?? null,
      hostname: s.hostname ?? null,
      accepted_at: s.accepted_at ?? null,
      suggestion_event_id: s.suggestion_event_id ?? null,
    },
  };
}

export async function finalizeCopilotSessionToDocument(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  companyName: string;
  /** When set, refresh this document row in place instead of creating a new document id. */
  existingDocumentId?: string | null;
}): Promise<{ documentId: string | null }> {
  const meta = (args.session.metadata ?? {}) as { acceptedSnippets?: AcceptedSnippet[] };
  const snippets = Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets : [];
  if (snippets.length === 0) {
    return { documentId: null };
  }

  // Build pages: page 1 = session header, pages 2..N+1 = one accepted snippet each.
  // This keeps document_chunk char ranges aligned to snippet boundaries so the
  // debug panel + downstream tooling can audit accepted snippets individually.
  const headerText = buildHeader({
    companyName: args.companyName,
    session: args.session,
    snippetCount: snippets.length,
  });
  const pages: IngestPage[] = [
    {
      pageNumber: 1,
      text: headerText,
      metadata: { kind_detail: "session_header" },
    },
    ...snippets.map((s, i) => {
      const built = buildSnippetPage({ snippet: s, index: i });
      return {
        pageNumber: i + 2,
        text: built.text,
        metadata: { kind_detail: "snippet", ...built.metadata },
      } satisfies IngestPage;
    }),
  ];

  const existing = args.existingDocumentId?.trim();
  const ingested = await ingestTextAsDocument({
    admin: args.admin as unknown as AdminClient,
    userId: args.session.user_id,
    dealId: args.session.deal_id,
    pages,
    sourceKind: "copilot_session",
    docType: "copilot_research",
    originalFilename: `Copilot research – ${args.companyName || "deal"} (${new Date(args.session.started_at).toISOString().slice(0, 10)})`,
    mimeType: "text/markdown",
    storageBucket: "copilot",
    storagePathPrefix: `copilot/${args.session.user_id}`,
    folderPath: "copilot",
    routingReason: "copilot_session_finalize",
    pageMetadata: {
      kind: "copilot_session",
      session_id: args.session.id,
      snippet_count: snippets.length,
      hostnames: Array.from(
        new Set(
          snippets
            .map((s) => s.hostname || null)
            .filter((h): h is string => Boolean(h))
        )
      ),
    },
    // Skip synchronous embeddings; doc_refine_chunks worker fills them in.
    // Keeps the Finalize POST under ~500ms locally.
    fastEmbedLimit: 0,
    reuseDocumentId: existing || undefined,
  });

  return { documentId: ingested?.documentId ?? null };
}
