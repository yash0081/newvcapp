import "server-only";
import { randomUUID } from "node:crypto";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import type { Extracted, Suggestion, SuggestionKind } from "@/lib/copilot/types";

export type DealContext = {
  companyName: string;
  metadata: Record<string, unknown>;
  /** Recent claims for the deal, surfaced as compact "key: value" strings. */
  recentClaims: Array<{ key?: string; value: string; source?: string }>;
};

const ANALYZE_PROMPT = `You are the research copilot. Compare the on-screen extraction against what we already know about a deal/company and produce 0-4 actionable suggestions to log.

Return strict JSON:
{
  "suggestions": [
    {
      "summary": "<= 120 chars, what to add/check",
      "snippet": "<= 600 chars; the exact factual snippet a user would save (no opinions)",
      "kind": "new" | "aligns" | "contradicts",
      "confidence": 0.0 to 1.0
    }
  ]
}

Rules:
- "new"        => useful info not present in our context.
- "aligns"    => corroborates an existing fact; only include if it strengthens evidence (e.g. fresh source, more precise number).
- "contradicts" => meaningfully disagrees with our existing facts; include the conflicting value.
- Skip generic chrome / navigation / cookie banners.
- Drop suggestions whose confidence < 0.4.
- If nothing is worth surfacing, return { "suggestions": [] }.`;

function normalizeSuggestionKind(v: unknown): SuggestionKind | null {
  return v === "new" || v === "aligns" || v === "contradicts" ? v : null;
}

export async function analyzeAgainstDeal(args: {
  extracted: Extracted;
  deal: DealContext;
  userInstruction?: string;
  hostname?: string | null;
}): Promise<Suggestion[]> {
  const sourceLabel = args.hostname || args.extracted.hostname || args.extracted.page_title || "screen";

  const compactClaims = args.deal.recentClaims.slice(0, 50).map((c) => ({
    key: c.key ?? null,
    value: c.value,
    source: c.source ?? null,
  }));

  const inputs = [
    { label: "Company name", value: args.deal.companyName || "Unknown" },
    { label: "Known company metadata", value: args.deal.metadata ?? {} },
    { label: "Recent recorded claims (subset)", value: compactClaims },
    { label: "On-screen extracted text", value: args.extracted.visible_text },
    { label: "On-screen extracted key-value claims", value: args.extracted.key_value_claims ?? [] },
    { label: "User instruction (optional)", value: args.userInstruction ?? "" },
    { label: "Source label", value: sourceLabel },
  ];

  let raw: string;
  try {
    raw = await vertexRunWithTextMulti(getResearchModel("flash"), ANALYZE_PROMPT, inputs, false);
  } catch (e) {
    throw new Error(`Copilot analyze failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const parsed = parseJsonFromResponseOrNull(raw) as { suggestions?: unknown } | null;
  const arr = parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  const out: Suggestion[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const summary = typeof r.summary === "string" ? r.summary.trim().slice(0, 240) : "";
    const snippet = typeof r.snippet === "string" ? r.snippet.trim().slice(0, 1200) : "";
    const kind = normalizeSuggestionKind(r.kind);
    const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0.5;
    if (!summary || !snippet || !kind) continue;
    if (confidence < 0.4) continue;
    out.push({
      client_id: randomUUID(),
      summary,
      snippet,
      kind,
      confidence,
      source_label: sourceLabel,
      hostname: args.hostname ?? args.extracted.hostname ?? null,
    });
    if (out.length >= 4) break;
  }
  return out;
}
