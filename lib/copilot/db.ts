import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcceptedSnippet, CopilotSession } from "@/lib/copilot/types";

type DealContextRow = {
  id: string;
  metadata: Record<string, unknown> | null;
};

export async function getDealForUser(args: {
  admin: SupabaseClient;
  dealId: string;
  userId: string;
}): Promise<DealContextRow | null> {
  const res = await args.admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", args.dealId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (res.error) return null;
  return (res.data ?? null) as DealContextRow | null;
}

export async function getRecentDealClaims(args: {
  admin: SupabaseClient;
  dealId: string;
  userId: string;
  limit?: number;
}): Promise<Array<{ key?: string; value: string; source?: string }>> {
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const res = await args.admin
    .schema("deal_intel")
    .from("claim")
    .select("key, value_text, value_jsonb, claim_type, document_id")
    .eq("user_id", args.userId)
    .eq("deal_id", args.dealId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (res.error) return [];
  const rows = (res.data ?? []) as Array<{
    key: string | null;
    value_text: string | null;
    value_jsonb: unknown;
    claim_type: string | null;
    document_id: string | null;
  }>;
  const out: Array<{ key?: string; value: string; source?: string }> = [];
  for (const r of rows) {
    const value =
      (typeof r.value_text === "string" && r.value_text) ||
      (r.value_jsonb ? JSON.stringify(r.value_jsonb).slice(0, 200) : "");
    if (!value) continue;
    const entry: { key?: string; value: string; source?: string } = { value };
    const key = r.key ?? r.claim_type ?? null;
    if (key) entry.key = key;
    if (r.document_id) entry.source = r.document_id;
    out.push(entry);
  }
  return out;
}

export async function getActiveSession(args: {
  admin: SupabaseClient;
  dealId: string;
  userId: string;
}): Promise<CopilotSession | null> {
  const res = await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("id, deal_id, user_id, status, started_at, ended_at, finalized_document_id, metadata")
    .eq("deal_id", args.dealId)
    .eq("user_id", args.userId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) return null;
  return (res.data ?? null) as CopilotSession | null;
}

export async function getSessionForUser(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
}): Promise<CopilotSession | null> {
  const res = await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("id, deal_id, user_id, status, started_at, ended_at, finalized_document_id, metadata")
    .eq("id", args.sessionId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (res.error) return null;
  return (res.data ?? null) as CopilotSession | null;
}

export async function appendAcceptedSnippet(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  snippet: AcceptedSnippet;
}): Promise<void> {
  const meta = (args.session.metadata && typeof args.session.metadata === "object" ? args.session.metadata : {}) as Record<string, unknown>;
  const list = Array.isArray(meta.acceptedSnippets) ? (meta.acceptedSnippets as AcceptedSnippet[]) : [];
  const next = [...list, args.snippet].slice(-300);
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: {
        ...meta,
        acceptedSnippets: next,
        last_observed_hostname: args.snippet.hostname ?? meta.last_observed_hostname ?? null,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.session.id);
}

export async function markSessionFinalized(args: {
  admin: SupabaseClient;
  sessionId: string;
  documentId: string | null;
}): Promise<void> {
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      status: "finalized",
      ended_at: new Date().toISOString(),
      finalized_document_id: args.documentId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId);
}

export async function markSessionsAbandonedForDeal(args: {
  admin: SupabaseClient;
  dealId: string;
  userId: string;
}): Promise<void> {
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      status: "abandoned",
      ended_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("deal_id", args.dealId)
    .eq("user_id", args.userId)
    .eq("status", "active");
}

export type CopilotEventInsert = {
  session_id: string;
  kind: "observation" | "suggestion" | "accepted" | "rejected" | "prompt" | "reply" | "error";
  payload: Record<string, unknown>;
  hostname?: string | null;
  parent_event_id?: string | null;
};

export async function insertCopilotEvent(args: {
  admin: SupabaseClient;
  event: CopilotEventInsert;
}) {
  const res = await args.admin
    .schema("deal_intel")
    .from("copilot_event")
    .insert(args.event)
    .select("id, session_id, kind, payload, hostname, parent_event_id, created_at")
    .single();
  return res;
}

export async function insertCopilotEvents(args: {
  admin: SupabaseClient;
  events: CopilotEventInsert[];
}) {
  if (!args.events.length) return { data: [], error: null };
  const res = await args.admin
    .schema("deal_intel")
    .from("copilot_event")
    .insert(args.events)
    .select("id, session_id, kind, payload, hostname, parent_event_id, created_at");
  return res;
}
