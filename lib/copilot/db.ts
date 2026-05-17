import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcceptedSnippet, CopilotSession } from "@/lib/copilot/types";
import { isNearDuplicateDraftSnippet } from "@/lib/copilot/draft-dedupe";
import { suggestionRepeatKey } from "@/lib/copilot/repeat-key";
import {
  type ResearchAgenda,
  parseStoredAgenda,
} from "@/lib/copilot/research-agenda";

type DealContextRow = {
  id: string;
  metadata: Record<string, unknown> | null;
};

export type AutoDraftSnippet = AcceptedSnippet & {
  id: string;
  confidence?: number | null;
  kind?: string | null;
  from_suggestion_event_id?: string | null;
};

/** Latest metadata row — avoids lost updates when concurrent routes merge metadata (e.g. auto_draft vs visitedUrls). */
async function loadLatestSessionMetadata(
  admin: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const res = await admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("metadata")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) return {};
  const m = res.data?.metadata;
  return (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
}

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
  const limit = Math.max(1, Math.min(200, args.limit ?? 12));
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
  /** When true (default), bump last_accept_at and unsynced_accept_count for background sync scheduling. */
  bumpAcceptCounters?: boolean;
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.session.id, args.session.user_id);
  const list = Array.isArray(meta.acceptedSnippets) ? (meta.acceptedSnippets as AcceptedSnippet[]) : [];
  const next = [...list, args.snippet].slice(-300);
  const bump = args.bumpAcceptCounters !== false;
  const nowIso = new Date().toISOString();
  const prevUnsynced = Number(meta.unsynced_accept_count ?? 0);
  const nextMeta: Record<string, unknown> = {
    ...meta,
    acceptedSnippets: next,
    last_observed_hostname: args.snippet.hostname ?? meta.last_observed_hostname ?? null,
  };
  if (bump) {
    nextMeta.last_accept_at = nowIso;
    nextMeta.unsynced_accept_count = prevUnsynced + 1;
  }
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: nextMeta,
      updated_at: nowIso,
    })
    .eq("id", args.session.id)
    .eq("user_id", args.session.user_id);
}

export function getVisitedUrls(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const m = meta as Record<string, unknown>;
  if (!Array.isArray(m.visitedUrls)) return [];
  return m.visitedUrls
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .slice(-50);
}

/** Map of lower-cased hostname → number of visits this session. */
/** Latest natural-language focus for auto mode (stored on session metadata). */
export function getAutoSteeringNote(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const v = m.auto_steering_note;
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim().slice(0, 600);
}

export async function setAutoSteeringNote(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  note: string;
}): Promise<void> {
  const trimmed = args.note.trim().slice(0, 600);
  const meta = await loadLatestSessionMetadata(args.admin, args.sessionId, args.userId);
  const nextMeta: Record<string, unknown> = { ...meta };
  if (!trimmed) delete nextMeta.auto_steering_note;
  else nextMeta.auto_steering_note = trimmed;
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: nextMeta,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId)
    .eq("user_id", args.userId);
}

export async function mergeSessionMetadata(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  transform: (current: Record<string, any>) => Record<string, any>;
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.sessionId, args.userId);
  const next = args.transform(meta);
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId)
    .eq("user_id", args.userId);
}

export function getVisitedHostCounts(visitedUrls: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of visitedUrls) {
    if (typeof raw !== "string" || !raw) continue;
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
}

export async function appendVisitedUrl(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  url: string;
}): Promise<void> {
  const trimmed = args.url.trim();
  if (!trimmed) return;
  const meta = await loadLatestSessionMetadata(args.admin, args.sessionId, args.userId);
  const prev = getVisitedUrls(meta);
  const deduped = [trimmed, ...prev.filter((u) => u !== trimmed)].slice(0, 50);
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: { ...meta, visitedUrls: deduped },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId)
    .eq("user_id", args.userId);
}

/** Parse research_agenda from session metadata (returns null if missing/malformed). */
export function getResearchAgenda(meta: unknown): ResearchAgenda | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  return parseStoredAgenda(m.research_agenda);
}

/**
 * Replace research_agenda on session metadata using the latest snapshot
 * (CAS-safe pattern: re-read metadata then write with merge).
 */
export async function setResearchAgenda(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  agenda: ResearchAgenda;
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.sessionId, args.userId);
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: { ...meta, research_agenda: args.agenda },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId)
    .eq("user_id", args.userId);
}

/**
 * Re-read agenda from latest metadata and apply a transform, persisting the result.
 * Use for downstream routes (observe, auto-draft) that need to update the agenda
 * without racing with plan-next writes.
 */
export async function mergeResearchAgenda(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  transform: (current: ResearchAgenda | null) => ResearchAgenda | null;
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.sessionId, args.userId);
  const current = parseStoredAgenda((meta as Record<string, unknown>).research_agenda);
  const next = args.transform(current);
  if (!next) return;
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: { ...meta, research_agenda: next },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId)
    .eq("user_id", args.userId);
}

export function getAutoDraft(meta: unknown): {
  status: "open" | "approved" | "discarded";
  started_at?: string;
  last_added_at?: string;
  snippets: AutoDraftSnippet[];
} {
  if (!meta || typeof meta !== "object") return { status: "open", snippets: [] };
  const m = meta as Record<string, unknown>;
  const raw = (m.auto_draft && typeof m.auto_draft === "object"
    ? m.auto_draft
    : {}) as Record<string, unknown>;
  const status = raw.status === "approved" || raw.status === "discarded" ? raw.status : "open";
  const snippets = Array.isArray(raw.snippets)
    ? raw.snippets.filter((s) => s && typeof s === "object").slice(-200) as AutoDraftSnippet[]
    : [];
  return {
    status,
    started_at: typeof raw.started_at === "string" ? raw.started_at : undefined,
    last_added_at: typeof raw.last_added_at === "string" ? raw.last_added_at : undefined,
    snippets,
  };
}

function acceptedSnippetTextsFromMeta(meta: Record<string, unknown>): string[] {
  const raw = meta.acceptedSnippets;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const t = (x as Record<string, unknown>).text;
    if (typeof t === "string" && t.trim()) out.push(t.trim());
  }
  return out;
}

export async function appendAutoDraftSnippet(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  snippet: AutoDraftSnippet;
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.session.id, args.session.user_id);
  const draft = getAutoDraft(meta);
  const incomingKey = suggestionRepeatKey("", args.snippet.text || "");
  const existingKeys = new Set(draft.snippets.map((s) => suggestionRepeatKey("", s.text || "")));
  if (existingKeys.has(incomingKey)) return;
  const fuzzyCorpus = [
    ...draft.snippets.map((s) => s.text || ""),
    ...acceptedSnippetTextsFromMeta(meta),
  ];
  if (isNearDuplicateDraftSnippet(args.snippet.text || "", fuzzyCorpus)) return;
  const nextSnippets = [...draft.snippets, args.snippet].slice(-200);
  const nowIso = new Date().toISOString();
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: {
        ...meta,
        auto_draft: {
          status: "open",
          started_at: draft.started_at ?? nowIso,
          last_added_at: nowIso,
          snippets: nextSnippets,
        },
      },
      updated_at: nowIso,
    })
    .eq("id", args.session.id)
    .eq("user_id", args.session.user_id);
}

export async function editAutoDraftSnippet(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  id: string;
  text: string;
}): Promise<void> {
  const trimmed = args.text.trim();
  if (!trimmed) return;
  const meta = await loadLatestSessionMetadata(args.admin, args.session.id, args.session.user_id);
  const draft = getAutoDraft(meta);
  const snippets = draft.snippets.map((s) => (s.id === args.id ? { ...s, text: trimmed.slice(0, 1200) } : s));
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: {
        ...meta,
        auto_draft: {
          ...draft,
          snippets,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.session.id)
    .eq("user_id", args.session.user_id);
}

export async function removeAutoDraftSnippet(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  id: string;
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.session.id, args.session.user_id);
  const draft = getAutoDraft(meta);
  const snippets = draft.snippets.filter((s) => s.id !== args.id);
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: {
        ...meta,
        auto_draft: {
          ...draft,
          snippets,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.session.id)
    .eq("user_id", args.session.user_id);
}

export async function setAutoDraftStatus(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  status: "open" | "approved" | "discarded";
}): Promise<void> {
  const meta = await loadLatestSessionMetadata(args.admin, args.session.id, args.session.user_id);
  const draft = getAutoDraft(meta);
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: {
        ...meta,
        auto_draft: {
          ...draft,
          status: args.status,
          snippets: args.status === "discarded" ? [] : draft.snippets,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.session.id)
    .eq("user_id", args.session.user_id);
}

export async function promoteAutoDraftToAccepted(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  snippetIds?: string[];
}): Promise<{ promoted: AutoDraftSnippet[] }> {
  const meta = await loadLatestSessionMetadata(args.admin, args.session.id, args.session.user_id);
  const draft = getAutoDraft(meta);
  const wanted = args.snippetIds?.length ? new Set(args.snippetIds) : null;
  const promoted = draft.snippets.filter((s) => (wanted ? wanted.has(s.id) : true));
  if (promoted.length === 0) return { promoted: [] };
  const existing = Array.isArray(meta.acceptedSnippets) ? (meta.acceptedSnippets as AcceptedSnippet[]) : [];
  const nextAccepted = [...existing, ...promoted.map((s) => ({
    text: s.text,
    source_label: s.source_label,
    hostname: s.hostname ?? null,
    source_url: s.source_url ?? null,
    accepted_at: s.accepted_at,
    suggestion_event_id: s.suggestion_event_id ?? s.from_suggestion_event_id ?? null,
  }))].slice(-300);
  const nowIso = new Date().toISOString();
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: {
        ...meta,
        acceptedSnippets: nextAccepted,
        auto_draft: {
          ...draft,
          status: "approved",
          snippets: draft.snippets.filter((s) => !promoted.some((p) => p.id === s.id)),
        },
        last_accept_at: nowIso,
        unsynced_accept_count: Number(meta.unsynced_accept_count ?? 0) + promoted.length,
      },
      updated_at: nowIso,
    })
    .eq("id", args.session.id)
    .eq("user_id", args.session.user_id);
  return { promoted };
}

/** Service-role / worker fetch by id (no user filter). */
export async function getCopilotSessionById(args: {
  admin: SupabaseClient;
  sessionId: string;
}): Promise<CopilotSession | null> {
  const res = await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("id, deal_id, user_id, status, started_at, ended_at, finalized_document_id, metadata")
    .eq("id", args.sessionId)
    .maybeSingle();
  if (res.error) return null;
  return (res.data ?? null) as CopilotSession | null;
}

export async function updateCopilotSessionMetadata(args: {
  admin: SupabaseClient;
  sessionId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      metadata: args.metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId);
}

export async function updateSessionFinalizedDocumentId(args: {
  admin: SupabaseClient;
  sessionId: string;
  documentId: string;
}): Promise<void> {
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      finalized_document_id: args.documentId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId);
}

export async function markSessionAbandoned(args: { admin: SupabaseClient; sessionId: string }): Promise<void> {
  await args.admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({
      status: "abandoned",
      ended_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.sessionId);
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
