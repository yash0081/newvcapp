import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";

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
  return out;
}

