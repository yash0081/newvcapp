import type { SupabaseClient } from "@supabase/supabase-js";

export type CompanyActivityItem = {
  id: string;
  type: "chat" | "research" | "tabular" | "generated_doc" | "document" | "meeting";
  title: string;
  href: string;
  at: string;
  status?: string | null;
};

function itemAt(row: Record<string, unknown>): string {
  return String(row.updated_at || row.created_at || new Date().toISOString());
}

function safeTitle(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export async function listCompanyActivity(admin: SupabaseClient, userId: string, dealId: string, limit = 20): Promise<CompanyActivityItem[]> {
  const [chat, research, tabular, generatedDocs, documents, meetings] = await Promise.all([
    admin
      .from("chat_threads")
      .select("id, title, created_at, updated_at")
      .eq("user_id", userId)
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(8),
    admin
      .schema("deal_intel")
      .from("deal_research_workflow")
      .select("id, title, status, created_at, updated_at")
      .eq("user_id", userId)
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(8),
    admin
      .schema("deal_intel")
      .from("diligence_matrix_cell")
      .select("id, status, updated_at")
      .eq("user_id", userId)
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(8),
    admin
      .schema("deal_intel")
      .from("generated_document_draft")
      .select("id, title, status, created_at, updated_at")
      .eq("user_id", userId)
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(8),
    admin
      .schema("deal_intel")
      .from("document")
      .select("id, original_filename, status, created_at, updated_at")
      .eq("user_id", userId)
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(8),
    admin
      .schema("deal_intel")
      .from("meeting_session")
      .select("id, status, created_at, updated_at")
      .eq("host_user_id", userId)
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(8),
  ]);

  for (const res of [chat, research, tabular, generatedDocs, documents, meetings]) {
    if (res.error) throw res.error;
  }

  const items: CompanyActivityItem[] = [
    ...((chat.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      type: "chat" as const,
      title: safeTitle(row.title, "Chat session"),
      href: `/home/deal-intel/${dealId}/chat?threadId=${row.id}`,
      at: itemAt(row),
    })),
    ...((research.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      type: "research" as const,
      title: safeTitle(row.title, "Research session"),
      href: `/home/deal-intel/${dealId}/research`,
      at: itemAt(row),
      status: typeof row.status === "string" ? row.status : null,
    })),
    ...((tabular.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      type: "tabular" as const,
      title: "Tabular review updated",
      href: `/home/deal-intel/${dealId}/tabular`,
      at: itemAt(row),
      status: typeof row.status === "string" ? row.status : null,
    })),
    ...((generatedDocs.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      type: "generated_doc" as const,
      title: safeTitle(row.title, "Generated document"),
      href: `/home/generated-documents/${row.id}`,
      at: itemAt(row),
      status: typeof row.status === "string" ? row.status : null,
    })),
    ...((documents.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      type: "document" as const,
      title: safeTitle(row.original_filename, "Uploaded document"),
      href: `/home/documents/${row.id}`,
      at: itemAt(row),
      status: typeof row.status === "string" ? row.status : null,
    })),
    ...((meetings.data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      type: "meeting" as const,
      title: "Live meeting session",
      href: `/home/deal-intel/${dealId}/meet`,
      at: itemAt(row),
      status: typeof row.status === "string" ? row.status : null,
    })),
  ];

  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

