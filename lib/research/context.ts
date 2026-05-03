import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { retrieveContextNodesForQuery } from "@/lib/retrieval-orchestrator";
import { stripMarkdownText } from "@/lib/plain-text";

type DealLite = { id: string; metadata: Record<string, unknown> | null };
type TractionLite = { deal_id: string; investor_list: string[] | null; money_raised_per_stage: string[] | null };

function safeRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function companyNameFromMeta(meta: unknown): string {
  const m = safeRecord(meta);
  return typeof m.company_name === "string" && m.company_name.trim() ? m.company_name.trim() : "Company";
}

function normalizeInvestorName(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ") : "";
}

function asTextBlock(label: string, value: unknown, max = 4000): string {
  const body = stripMarkdownText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return body ? `${label}\n${body.slice(0, max)}` : "";
}

async function loadRelationalSnapshot(admin: SupabaseClient, dealId: string): Promise<Record<string, unknown>> {
  const di = admin.schema("deal_intel");
  const [deal, makeup, origin, problem, solution, traction, negative, people] = await Promise.all([
    di.from("deal").select("id, metadata").eq("id", dealId).maybeSingle(),
    di.from("company_makeup").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_origin_story").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_problem").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_solution").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_traction").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_negative").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di
      .from("company_person")
      .select("name, person_kind, company_role, general_description, age, location, misc, relevant_achievements")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  return {
    deal: deal.data ?? null,
    company_makeup: makeup.data ?? null,
    company_origin_story: origin.data ?? null,
    company_problem: problem.data ?? null,
    company_solution: solution.data ?? null,
    company_traction: traction.data ?? null,
    company_negative: negative.data ?? null,
    notable_people: people.data ?? [],
  };
}

async function loadTreeContext(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  query: string;
  limit?: number;
}): Promise<Array<{ node_type: string; text: string; score: number }>> {
  try {
    const rows = await retrieveContextNodesForQuery(args.admin, {
      userId: args.userId,
      queryText: args.query,
      focusDealId: args.dealId,
      queryType: "analytical",
      chatTask: "deep_reasoning",
      limit: args.limit ?? 8,
    });
    return rows
      .filter((row) => row.deal_id === args.dealId && row.raw_text)
      .map((row) => ({
        node_type: row.node_type,
        text: stripMarkdownText(row.raw_text).slice(0, 900),
        score: Number(row.score ?? 0),
      }))
      .slice(0, args.limit ?? 8);
  } catch {
    return [];
  }
}

async function loadDocumentContext(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  query: string;
  limit?: number;
}): Promise<Array<{ document_id: string; page_start: number; page_end: number; text: string; score: number }>> {
  const limit = args.limit ?? 6;
  const query = args.query.trim().slice(0, 700);
  if (!query) return [];
  const fts = await args.admin.rpc("deal_intel_match_document_chunks_fts", {
    p_user_id: args.userId,
    p_query: query,
    p_match_count: limit,
    p_deal_id: args.dealId,
  });
  const ftsRows = fts.error ? [] : ((fts.data ?? []) as Array<{ document_id: string; page_start: number; page_end: number; text: string; score: number }>);

  let vectorRows: typeof ftsRows = [];
  try {
    const emb = await embedText(query.slice(0, 8000));
    const vec = await args.admin.rpc("deal_intel_match_document_chunks_vector", {
      p_user_id: args.userId,
      p_query_embedding: vectorParam(emb),
      p_match_count: limit,
      p_deal_id: args.dealId,
    });
    if (!vec.error) {
      vectorRows = ((vec.data ?? []) as Array<{ document_id: string; page_start: number; page_end: number; text: string; similarity: number }>).map((row) => ({
        ...row,
        score: Number(row.similarity ?? 0),
      }));
    }
  } catch {
    vectorRows = [];
  }

  const byKey = new Map<string, (typeof ftsRows)[number]>();
  for (const row of [...vectorRows, ...ftsRows]) {
    const clean = stripMarkdownText(row.text).slice(0, 900);
    if (!clean) continue;
    const key = `${row.document_id}:${row.page_start}:${row.page_end}:${clean.slice(0, 80)}`;
    const prev = byKey.get(key);
    if (!prev || Number(row.score ?? 0) > Number(prev.score ?? 0)) byKey.set(key, { ...row, text: clean });
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0)).slice(0, limit);
}

async function loadPeerInvestorSignals(args: {
  admin: SupabaseClient;
  dealId: string;
  peerDealIds: string[];
}): Promise<string> {
  const ids = Array.from(new Set([args.dealId, ...args.peerDealIds])).filter(Boolean).slice(0, 8);
  if (ids.length < 2) return "";
  const di = args.admin.schema("deal_intel");
  const [dealsRes, tractionRes] = await Promise.all([
    di.from("deal").select("id, metadata").in("id", ids),
    di.from("company_traction").select("deal_id, investor_list, money_raised_per_stage").in("deal_id", ids),
  ]);
  const deals = (dealsRes.data ?? []) as DealLite[];
  const traction = (tractionRes.data ?? []) as TractionLite[];
  const nameByDeal = new Map(deals.map((deal) => [deal.id, companyNameFromMeta(deal.metadata)]));
  const investorsByDeal = new Map<string, Map<string, string>>();
  for (const row of traction) {
    const map = investorsByDeal.get(row.deal_id) ?? new Map<string, string>();
    for (const investor of row.investor_list ?? []) {
      const key = normalizeInvestorName(investor);
      if (key) map.set(key, investor.trim());
    }
    investorsByDeal.set(row.deal_id, map);
  }
  const current = investorsByDeal.get(args.dealId);
  if (!current?.size) return "";
  const lines: string[] = [];
  for (const peerId of args.peerDealIds) {
    const peer = investorsByDeal.get(peerId);
    if (!peer?.size) continue;
    const overlap = Array.from(current.keys()).filter((key) => peer.has(key));
    if (overlap.length) {
      lines.push(`${nameByDeal.get(args.dealId) ?? "Current company"} and ${nameByDeal.get(peerId) ?? "peer company"} share: ${overlap.map((key) => current.get(key) ?? key).join(", ")}.`);
    }
  }
  return lines.join("\n");
}

export async function loadResearchInternalContext(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  query: string;
  peerDealIds?: string[];
  mode?: "planning" | "execution";
}): Promise<string> {
  const [snapshot, tree, docs, investorSignals] = await Promise.all([
    loadRelationalSnapshot(args.admin, args.dealId).catch(() => ({})),
    loadTreeContext({ admin: args.admin, userId: args.userId, dealId: args.dealId, query: args.query, limit: args.mode === "planning" ? 6 : 10 }),
    loadDocumentContext({ admin: args.admin, userId: args.userId, dealId: args.dealId, query: args.query, limit: args.mode === "planning" ? 4 : 8 }),
    loadPeerInvestorSignals({ admin: args.admin, dealId: args.dealId, peerDealIds: args.peerDealIds ?? [] }).catch(() => ""),
  ]);

  const sections = [
    asTextBlock("Structured company data from the workspace", snapshot, args.mode === "planning" ? 4500 : 7000),
    tree.length ? asTextBlock("Relevant hierarchical deal-tree retrieval", tree, args.mode === "planning" ? 2500 : 5000) : "",
    docs.length ? asTextBlock("Relevant internal document chunks", docs, args.mode === "planning" ? 2500 : 5000) : "",
    investorSignals ? asTextBlock("Deterministic database signals", investorSignals, 2000) : "",
  ].filter(Boolean);

  return sections.join("\n\n").slice(0, args.mode === "planning" ? 11000 : 18000);
}

