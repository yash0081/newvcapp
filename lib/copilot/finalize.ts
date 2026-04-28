import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestTextAsDocument, type AdminClient } from "@/lib/research/document-ingest";
import type { AcceptedSnippet, CopilotSession } from "@/lib/copilot/types";

function buildRunningDocument(args: {
  companyName: string;
  session: CopilotSession;
}): string {
  const meta = (args.session.metadata ?? {}) as { acceptedSnippets?: AcceptedSnippet[] };
  const snippets = Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets : [];

  const header =
    `# Research copilot session for ${args.companyName || "Company"}\n` +
    `Session id: ${args.session.id}\n` +
    `Started: ${args.session.started_at}\n` +
    `Snippets: ${snippets.length}\n`;

  const body = snippets
    .map((s, i) => {
      const label = s.source_label || s.hostname || "screen";
      const url = s.source_url ? ` (${s.source_url})` : "";
      const ts = s.accepted_at ? ` @ ${s.accepted_at}` : "";
      return `## ${i + 1}. ${label}${url}${ts}\n${s.text.trim()}`;
    })
    .join("\n\n");

  return `${header}\n\n${body}`.trim();
}

export async function finalizeCopilotSessionToDocument(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  companyName: string;
}): Promise<{ documentId: string | null }> {
  const text = buildRunningDocument({ companyName: args.companyName, session: args.session });
  const meta = (args.session.metadata ?? {}) as { acceptedSnippets?: AcceptedSnippet[] };
  const snippets = Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets : [];
  if (snippets.length === 0 || text.length < 40) {
    return { documentId: null };
  }

  const ingested = await ingestTextAsDocument({
    admin: args.admin as unknown as AdminClient,
    userId: args.session.user_id,
    dealId: args.session.deal_id,
    text,
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
  });

  return { documentId: ingested?.documentId ?? null };
}
