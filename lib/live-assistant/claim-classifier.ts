import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { findVerbatimSpan } from "@/lib/live-assistant/quote-grounding";
import { normalizeNumberFromText } from "@/lib/live-assistant/fast-crm-compare";

export type ClaimSection =
  | "team"
  | "problem"
  | "solution"
  | "market"
  | "product"
  | "traction"
  | "gtm"
  | "competition"
  | "financials"
  | "risks"
  | "other";

export type ClaimIntent = "metric" | "claim" | "plan" | "opinion";

export type ClassifiedClaim = {
  text: string;
  section: ClaimSection;
  intent: ClaimIntent;
  confidence: number;
};

const FAST_MODEL = getLiveAssistantModel("fast");
const SECTIONS: ClaimSection[] = [
  "team",
  "problem",
  "solution",
  "market",
  "product",
  "traction",
  "gtm",
  "competition",
  "financials",
  "risks",
  "other",
];
const INTENTS: ClaimIntent[] = ["metric", "claim", "plan", "opinion"];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Strip commas so "20,000" parses as twenty thousand, not 20. */
function primaryNumericValue(s: string): number | null {
  const cleaned = String(s).replace(/,/g, "");
  const n = normalizeNumberFromText(cleaned);
  return n && Number.isFinite(n.value) ? n.value : null;
}

function numericAnchorsAlign(chunk: string, claimText: string): boolean {
  const a = primaryNumericValue(chunk);
  const b = primaryNumericValue(claimText);
  if (a == null || b == null) return false;
  if (a === 0 && b === 0) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom <= 0.02;
}

function safeSection(v: unknown): ClaimSection {
  return typeof v === "string" && SECTIONS.includes(v as ClaimSection) ? (v as ClaimSection) : "other";
}

function safeIntent(v: unknown): ClaimIntent {
  return typeof v === "string" && INTENTS.includes(v as ClaimIntent) ? (v as ClaimIntent) : "claim";
}

export async function classifyClaimsFromChunk(text: string): Promise<ClassifiedClaim[]> {
  const trimmed = String(text || "").trim().slice(0, 2800);
  if (!trimmed) return [];

  const prompt = `Split the transcript chunk into atomic claims and classify each claim.
Return JSON only:
{
  "claims": [
    {"text":"...", "section":"team|problem|solution|market|product|traction|gtm|competition|financials|risks|other", "intent":"metric|claim|plan|opinion", "confidence":0.0}
  ]
}
Rules:
- Each claim "text" MUST be copied verbatim from the Chunk below (a contiguous substring / exact phrase). Do not paraphrase, infer, or invent sentences.
- Never invent numbers, metrics, or facts that do not appear in the Chunk. Do not pull wording from outside the Chunk (e.g. CRM fields you might imagine).
- Keep each claim concise and factual.
- Do not include duplicate claims.
- Confidence must be 0..1.

Chunk:
${trimmed}`;

  const raw = await vertexRunWithText(FAST_MODEL, prompt, false);
  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
    claims?: unknown;
  };
  const claims = Array.isArray(parsed?.claims) ? parsed.claims : [];
  const out: ClassifiedClaim[] = [];
  for (const c of claims) {
    const r = (c && typeof c === "object" ? (c as Record<string, unknown>) : {}) as Record<string, unknown>;
    const claimText = String(r.text ?? "").trim().slice(0, 500);
    if (!claimText) continue;
    out.push({
      text: claimText,
      section: safeSection(r.section),
      intent: safeIntent(r.intent),
      confidence: clamp01(typeof r.confidence === "number" ? r.confidence : 0.5),
    });
  }

  // Hard-drop hallucinated claims: the LLM sometimes invents metrics ("26B records") that
  // never appeared in the chunk. Downstream (claim checks, contradictions) trusts
  // `meeting_claim.text`, so we only persist grounded spans — same idea as
  // `findVerbatimSpan` on contradiction outputs.
  const grounded: ClassifiedClaim[] = [];
  for (const c of out) {
    const span = findVerbatimSpan(trimmed, c.text);
    if (span) {
      const matched = span.matched.trim().slice(0, 500);
      if (matched) grounded.push({ ...c, text: matched });
      continue;
    }
    // Bare numeric reply (e.g. chunk "20,000" only): allow when the model wrapped it in
    // a sentence that fails verbatim match but agrees on the primary parsed number.
    if (numericAnchorsAlign(trimmed, c.text)) {
      const verbatim = trimmed.trim().slice(0, 500);
      if (verbatim) grounded.push({ ...c, text: verbatim });
      continue;
    }
  }
  return grounded;
}

