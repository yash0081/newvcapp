import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getResearchModel } from "@/lib/research/research-model-env";
import { getDealContext } from "@/lib/live-assistant/tools";

function companyNameFromDeal(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" && m.company_name.trim() ? m.company_name.trim() : "Company";
}

export type MeetingClaimResearchVerdict = "supports" | "contradicts" | "inconclusive";

type Citation = { url: string; title: string; snippet: string };

function normalizeResearchVerdict(v: unknown): MeetingClaimResearchVerdict {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "supports" || s === "contradicts" || s === "inconclusive") return s;
  return "inconclusive";
}

function normalizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    if (!url.startsWith("http")) continue;
    out.push({
      url: url.slice(0, 2000),
      title: typeof o.title === "string" ? o.title.trim().slice(0, 240) : "",
      snippet: typeof o.snippet === "string" ? o.snippet.trim().slice(0, 400) : "",
    });
    if (out.length >= 6) break;
  }
  return out;
}

export async function runMeetingClaimResearchVerify(
  admin: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const meetingId = String(payload.meeting_id ?? "");
  const claimId = String(payload.claim_id ?? "");
  const userId = String(payload.user_id ?? "");
  const dealId = String(payload.deal_id ?? "");
  if (!meetingId || !claimId || !userId || !dealId) return;

  const claimRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("text")
    .eq("id", claimId)
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (!claimRes.data) {
    await admin
      .schema("deal_intel")
      .from("meeting_claim_verification")
      .update({ stage: "failed", updated_at: new Date().toISOString() })
      .eq("meeting_id", meetingId)
      .eq("claim_id", claimId);
    return;
  }

  const claimText = String((claimRes.data as { text?: string }).text ?? "").trim().slice(0, 800);

  const verRes = await admin
    .schema("deal_intel")
    .from("meeting_claim_verification")
    .select("auto_verdict, auto_summary")
    .eq("meeting_id", meetingId)
    .eq("claim_id", claimId)
    .maybeSingle();
  const vr = verRes.data as { auto_verdict?: string | null; auto_summary?: string | null } | null;
  const autoVerdict = vr?.auto_verdict ?? null;
  const autoSummary = typeof vr?.auto_summary === "string" ? vr.auto_summary : "";

  const ctx = await getDealContext(admin, { userId, dealId });
  const dealRow = ctx.deal && typeof ctx.deal === "object" ? (ctx.deal as Record<string, unknown>) : null;
  const companyName = companyNameFromDeal(dealRow?.metadata);

  const prompt = `You verify a spoken company claim using web search when helpful.

Company: ${companyName}

Claim (from live meeting): "${claimText}"

Prior automated assessment (deal CRM / memo only, not web): ${autoVerdict ?? "unknown"}${autoSummary ? ` — ${autoSummary}` : ""}

Return strict JSON only:
{"verdict":"supports|contradicts|inconclusive","summary":"<=2 sentences","citations":[{"url":"https://...","title":"...","snippet":"..."}]}

Rules:
- supports: reputable public sources corroborate the claim (or it is a precise factual statement clearly confirmed).
- contradicts: reputable public sources contradict the claim.
- inconclusive: insufficient or conflicting weak sources, ambiguous wording, or no substantive public evidence.
- citations: 1–5 items with real https URLs; prefer primary sources (official site, filings, regulator), then reputable press.

`;

  let researchVerdict: MeetingClaimResearchVerdict = "inconclusive";
  let researchSummary = "";
  let citations: Citation[] = [];

  try {
    const raw = await vertexRunWithText(getResearchModel("flash"), prompt, true);
    const parsed = (parseJsonFromResponseOrNull(raw) ??
      (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      researchVerdict = normalizeResearchVerdict(parsed.verdict);
      researchSummary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 600) : "";
      citations = normalizeCitations(parsed.citations);
    }
  } catch {
    await admin
      .schema("deal_intel")
      .from("meeting_claim_verification")
      .update({ stage: "failed", updated_at: new Date().toISOString() })
      .eq("meeting_id", meetingId)
      .eq("claim_id", claimId);
    return;
  }

  await admin
    .schema("deal_intel")
    .from("meeting_claim_verification")
    .update({
      stage: "research_done",
      research_verdict: researchVerdict,
      research_summary: researchSummary || null,
      research_citations: citations,
      updated_at: new Date().toISOString(),
    })
    .eq("meeting_id", meetingId)
    .eq("claim_id", claimId);

  // The card we need to attach research output to could be either the auto-verify card or
  // the contradiction card (auto-verify suppresses its own emit when a contradiction already
  // exists for this `meeting_claim_id`). Look up by claim id across both kinds and prefer
  // contradiction (it's the canonical card when both could exist).
  const evList = await admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("id, kind, source_map, body, created_at")
    .eq("meeting_id", meetingId)
    .in("kind", ["contradiction", "claim_verification"])
    .filter("source_map->>meeting_claim_id", "eq", claimId)
    .order("created_at", { ascending: false })
    .limit(8);

  let evRow: { id: string; source_map: unknown; body: string } | null = null;
  if (Array.isArray(evList.data) && evList.data.length) {
    const rows = evList.data as Array<{ id: string; kind: string; source_map: unknown; body: string }>;
    const contra = rows.find((r) => r.kind === "contradiction");
    const fallback = rows.find((r) => r.kind === "claim_verification");
    evRow = contra ?? fallback ?? null;
  }

  // Legacy lookup for cards emitted before the `meeting_claim_id` source_map field was added.
  if (!evRow) {
    const legacy = await admin
      .schema("deal_intel")
      .from("meeting_assistant_event")
      .select("id, source_map, body")
      .eq("meeting_id", meetingId)
      .eq("kind", "claim_verification")
      .filter("source_map->>dedupe_key", "eq", `claim_verify:${claimId}`)
      .order("created_at", { ascending: false })
      .limit(1);
    evRow = Array.isArray(legacy.data) && legacy.data[0] ? (legacy.data[0] as { id: string; source_map: unknown; body: string }) : null;
  }

  if (!evRow) return;

  const sm =
    evRow.source_map && typeof evRow.source_map === "object" ? ({ ...(evRow.source_map as Record<string, unknown>) } as Record<string, unknown>) : {};
  sm.research_verdict = researchVerdict;
  sm.research_summary = researchSummary;
  sm.research_citations = citations;
  sm.verification_stage = "research_done";

  const quoteBody = claimText ? `“${claimText}”` : String(evRow.body ?? "");
  const newBody = [quoteBody, autoSummary ? `\nDeal check: ${autoSummary}` : "", `\nWeb research: ${researchSummary || researchVerdict}`]
    .filter(Boolean)
    .join("");

  const nextSeverity: "low" | "med" | "high" =
    researchVerdict === "contradicts" ? "high" : researchVerdict === "supports" ? "low" : "med";

  await admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .update({
      body: newBody.slice(0, 8000),
      severity: nextSeverity,
      source_map: sm,
    })
    .eq("id", evRow.id)
    .eq("meeting_id", meetingId);
}
