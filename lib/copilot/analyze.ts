import "server-only";
import { randomUUID } from "node:crypto";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import { suggestionRepeatKey } from "@/lib/copilot/repeat-key";
import type { Extracted, Suggestion, SuggestionKind } from "@/lib/copilot/types";
import {
  DEAL_INTEL_RESEARCH_FOCUS_GUIDE,
  DEAL_INTEL_QUALITY_GUARDRAILS,
  USER_PREFERENCE_GUARDRAILS,
} from "@/lib/deal-intel/prompt-guidance";
import { isLowValueSaveSuggestion } from "@/lib/copilot/preference-signals";
import { suggestionMatchesSteeringFocus } from "@/lib/copilot/steering-focus";
import type { ResearchGap } from "@/lib/copilot/research-agenda";

const ANALYZE_MODEL_ENV = "COPILOT_ANALYZE_MODEL";
const MAX_RECENT_CLAIMS = 12;
/** Session accepts can lag facts-schema sync; surface enough for contradiction checks. */
const MAX_SESSION_ACCEPTED_SNIPPETS = 25;
const MAX_SUGGESTIONS = 6;
/** Keep in sync with ANALYZE_PROMPT confidence line so the model is not trained to self-suppress. */
const MIN_CONFIDENCE = 0.44;
/** Slightly looser when the user set a focus — junk still filtered via isLowValueSaveSuggestion. */
const MIN_CONFIDENCE_WITH_FOCUS = 0.42;
const MAX_VISIBLE_TEXT_CHARS = 5200;
const MAX_OUTBOUND_LINKS = 36;

function getCopilotAnalyzeModel(): string {
  const override = process.env[ANALYZE_MODEL_ENV]?.trim();
  if (override) return override;
  try {
    return getResearchModel("flash");
  } catch {
    return getResearchModel("flash_lite");
  }
}

export type DealContext = {
  companyName: string;
  metadata: Record<string, unknown>;
  /** Recent claims for the deal, surfaced as compact "key: value" strings. */
  recentClaims: Array<{ key?: string; value: string; source?: string }>;
  /** Snippets already accepted in this active research session (newest first). */
  sessionAcceptedSnippets?: Array<{ text: string; source_label?: string | null; accepted_at?: string | null }>;
  /** Recently surfaced suggestions in this session, used to suppress repeats. */
  recentSuggestionKeys?: string[];
  /** URLs already visited by auto-research in this session. */
  visitedUrls?: string[];
  /** Canonical fields still missing or weak after metadata + claims + session snippets. */
  openGaps?: ResearchGap[];
  preferredHostnames?: Array<{ domain: string; score: number; category?: string; focus_guidance?: string }>;
  dislikedHostnames?: string[];
};

const ANALYZE_PROMPT = `You are the research copilot. Compare the on-screen extraction against what we already know about a deal/company and produce 0-${MAX_SUGGESTIONS} high-quality actionable suggestions to log.

Prioritize suggestions that fill, verify, or contradict the canonical Deal Intel schema:
${DEAL_INTEL_RESEARCH_FOCUS_GUIDE}

${DEAL_INTEL_QUALITY_GUARDRAILS}

${USER_PREFERENCE_GUARDRAILS}

Return strict JSON:
{
  "suggestions": [
    {
      "summary": "<= 120 chars, what to add/check",
      "snippet": "<= 600 chars; factual snippet to save (no opinions)",
      "kind": "new" | "aligns" | "contradicts" | "explore",
      "confidence": 0.0 to 1.0,
      "link_url": "https://... (required for explore, omit otherwise)"
    }
  ]
}

Rules:
- Return at most ${MAX_SUGGESTIONS} suggestions; prefer quality over quantity.
- When "Outbound links visible on page" lists several URLs, include explore suggestions for distinct useful follow-ups (e.g. team, pricing, security, docs) when the current screen does not already answer the question—up to 2 explore items if justified, each with a different link_url.
- Prefer one strong suggestion over several weak ones; do not pad with low-value items.
- Treat "Open research gaps" as the main save target. Also treat a non-empty "Auto steering note" or user prompt as the user's live priority. A high-quality suggestion should fill, verify, or contradict either an open gap or that explicit focus.
- Resolve conflicts against this priority order:
  1) Accepted snippets from the current session (newest source of truth) — if a fact appears here, it wins over "Known company metadata" and "Recent recorded claims" even when they disagree (session may be ahead of the CRM until background sync runs).
  2) Existing CRM/deal claims
  If a current-session accepted snippet already resolves a previous contradiction, do NOT raise it again.
- Do not repeat substantially identical suggestions already surfaced in this session.
- "new"        => useful info not present in our context (metadata + recent claims + session snippets).
- "aligns"     => corroborates something we already have in CRM/metadata **or** recent claims. Use this whenever the **visible page** states the same fact with usable sourcing — even if CRM already lists it (e.g. founder name, title, education). Session research often needs on-record corroboration, not only net-new fields. Prefer **aligns** over skipping; the snippet should quote or paraphrase the **on-screen** fact and imply the source (page/section). "Material improvement" includes: independent source, fresher detail, exact quote, or confirmation while the user’s steering note or open gaps target that topic.
- "contradicts"=> meaningfully disagrees with existing facts; include conflicting value.
- Prefer schema-aligned snippets: people/team, makeup/origin, problem/customer/market, solution/pricing/defensibility/competitors, traction, or negative aspects.
- Surface negatives and missing-evidence facts when the page gives concrete support; do not manufacture criticism.
- Saved snippets for "new", "aligns", and "contradicts" must be concrete company facts. Never save meta-notes like "this page contains useful information about stock price" or "the source has good details about funding."
- If a page is useful but the current screen does not expose an actual fact/value, return an "explore" suggestion or no suggestion. For market/stock pages, save the actual ticker, price, market cap, date, or other stated value if present; otherwise do not save a generic stock-information note.
- For "contradicts", explicitly frame it as a decision between current vs new value.
- For "contradicts", format summary like "Contradiction: <field>" and snippet as:
  "Current: ... | New: ... | Source: ..."
- "explore"    => use only when current page lacks the answer but visible outbound links suggest where to verify.
- For "explore", include link_url and make summary specific (e.g. "Team page for founder bios").
- For "explore", snippet must be a neutral fact about what that URL is for (e.g. "Corporate leadership page lists executives."); never use imperatives in snippet ("Explore…", "Visit…", "Verify…").
- Do not propose explore suggestions that match URLs already visited in this session.
- Prefer links from preferred hostnames; avoid disliked hostnames unless no alternative exists.
- When "Auto steering note" is non-empty: treat it as the user's live priority for this session. Favor facts, aligns, and explore links that advance that focus; avoid unrelated tangents. When choosing explore targets, prefer outbound URLs on preferred hostnames whose category matches the steering topic (e.g. geography → maps / HQ / office pages).
- Skip generic chrome / navigation / cookie banners.
- Assign confidence honestly for each item. Keep substantive suggestions with confidence >= 0.44 when they cite a concrete on-screen fact, a clear contradiction, or a well-targeted explore link. Do not inflate confidence on vague meta-summaries.
- When "On-screen extracted text" has 300+ characters of real sentences (not only nav/footer/cookie boilerplate), return at least 1 suggestion unless the page truly has no fact, contradiction, or outbound link that advances open gaps or the steering note. Prefer 2–4 suggestions on dense pages (team, funding, product, news).
- If nothing is worth surfacing, return { "suggestions": [] }.`;

const FOCUS_MODE_APPEND = `

FOCUS MODE (only when "Auto steering note" is non-empty):
- The steering note is the **highest priority**. Every suggestion must **directly** serve that note — not merely "interesting" facts from the same company.
- **Hard rule:** If the user asked only about one angle (e.g. funding, investors, rounds), do **not** surface standalone founder bios, product descriptions, generic team pages, or customer logos unless the **snippet itself** ties to that angle (e.g. founder also named as lead investor, product milestone tied to a financing event). When in doubt, omit.
- If the focus is on **people / founders / team**, then team and leadership facts (including **aligns** with CRM) are in scope; do not pivot to funding or product unless the text explicitly connects them to the people question.
- If the focus is on **funding / investors / rounds**, snippets must mention financing, investors, rounds, valuation, cap table, or similar — not just company identity.
- Use **aligns** for on-page corroboration of CRM facts **only when** that fact is within the current focus scope (see above).
- Prefer 1–3 **on-focus** suggestions; return { "suggestions": [] } rather than padding with off-focus items.
- Explore links must obviously advance the steering note (e.g. funding focus → press release, Crunchbase, investor page), not generic navigation.`;

function normalizeSuggestionKind(v: unknown): SuggestionKind | null {
  return v === "new" || v === "aligns" || v === "contradicts" || v === "explore" ? v : null;
}

function normalizeExploreLink(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function analyzeAgainstDeal(args: {
  extracted: Extracted;
  deal: DealContext;
  userInstruction?: string;
  hostname?: string | null;
}): Promise<Suggestion[]> {
  const sourceLabel = args.hostname || args.extracted.hostname || args.extracted.page_title || "screen";

  const compactClaims = args.deal.recentClaims.slice(0, MAX_RECENT_CLAIMS).map((c) => ({
    key: c.key ?? null,
    value: c.value,
    source: c.source ?? null,
  }));
  const sessionAccepted = (args.deal.sessionAcceptedSnippets ?? []).slice(0, MAX_SESSION_ACCEPTED_SNIPPETS).map((s) => ({
    text: s.text,
    source_label: s.source_label ?? null,
    accepted_at: s.accepted_at ?? null,
  }));

  const visibleText = (args.extracted.visible_text || "").slice(0, MAX_VISIBLE_TEXT_CHARS);
  const outboundLinks = (args.extracted.outbound_links ?? []).slice(0, MAX_OUTBOUND_LINKS);

  const steeringTrim = (args.userInstruction ?? "").trim();
  const analyzePrompt = steeringTrim ? `${ANALYZE_PROMPT}${FOCUS_MODE_APPEND}` : ANALYZE_PROMPT;
  const minConfidence = steeringTrim ? MIN_CONFIDENCE_WITH_FOCUS : MIN_CONFIDENCE;

  const inputs = [
    { label: "Company name", value: args.deal.companyName || "Unknown" },
    { label: "Known company metadata", value: args.deal.metadata ?? {} },
    { label: "Accepted snippets in current session (highest precedence)", value: sessionAccepted },
    { label: "Open research gaps (prioritize filling or verifying these)", value: (args.deal.openGaps ?? []).slice(0, 20) },
    { label: "Recently surfaced suggestion keys", value: (args.deal.recentSuggestionKeys ?? []).slice(0, 40) },
    { label: "Recent recorded claims (subset)", value: compactClaims },
    { label: "On-screen extracted text", value: visibleText },
    { label: "On-screen extracted key-value claims", value: args.extracted.key_value_claims ?? [] },
    { label: "Outbound links visible on page", value: outboundLinks },
    { label: "Already visited URLs this session", value: (args.deal.visitedUrls ?? []).slice(0, 50) },
    { label: "Preferred hostnames", value: (args.deal.preferredHostnames ?? []).slice(0, 40) },
    { label: "Disliked hostnames", value: (args.deal.dislikedHostnames ?? []).slice(0, 40) },
    { label: "Auto steering note (from user, optional)", value: args.userInstruction ?? "" },
    { label: "Source label", value: sourceLabel },
  ];

  let raw: string;
  try {
    raw = await vertexRunWithTextMulti(getCopilotAnalyzeModel(), analyzePrompt, inputs, false);
  } catch (e) {
    throw new Error(`Copilot analyze failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const parsed = parseJsonFromResponseOrNull(raw) as { suggestions?: unknown } | null;
  const arr = parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  const out: Suggestion[] = [];
  const seenKeys = new Set((args.deal.recentSuggestionKeys ?? []).slice(0, 80));
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const summary = typeof r.summary === "string" ? r.summary.trim().slice(0, 240) : "";
    const kind = normalizeSuggestionKind(r.kind);
    const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0.5;
    const link_url = kind === "explore" ? normalizeExploreLink(r.link_url) : null;
    const snippetBase = typeof r.snippet === "string" ? r.snippet.trim() : "";
    const snippet = (snippetBase || summary).slice(0, 1200);
    if (!summary || !snippet || !kind) continue;
    if (confidence < minConfidence) continue;
    if (kind === "explore" && !link_url) continue;
    if (isLowValueSaveSuggestion({ kind, summary, snippet })) continue;
    if (
      steeringTrim &&
      !suggestionMatchesSteeringFocus({
        summary,
        snippet,
        linkUrl: link_url,
        steeringNote: steeringTrim,
      })
    ) {
      continue;
    }
    const repeatKey = suggestionRepeatKey(summary, snippet);
    if (seenKeys.has(repeatKey)) continue;
    seenKeys.add(repeatKey);
    out.push({
      client_id: randomUUID(),
      summary,
      snippet,
      kind,
      confidence,
      source_label: sourceLabel,
      hostname: args.hostname ?? args.extracted.hostname ?? null,
      link_url,
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
