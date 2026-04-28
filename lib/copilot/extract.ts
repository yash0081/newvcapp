import "server-only";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithImage } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import type { Extracted, ExtractedKeyValue } from "@/lib/copilot/types";

const VISION_MODEL_ENV = "COPILOT_VISION_MODEL";

function getCopilotVisionModel(): string {
  const override = process.env[VISION_MODEL_ENV]?.trim();
  if (override) return override;
  return getResearchModel("flash");
}

const EXTRACT_PROMPT = `You analyze a single screenshot from the user's research browser tab and produce a strict JSON object describing what is on it.

Return JSON of this exact shape:
{
  "visible_text": "string with the readable text from the page (skip nav/cookie banners; keep numbers and proper nouns)",
  "page_title": "string if you can read the document title or main heading, else omit",
  "hostname": "string hostname if visible in the browser chrome / URL bar, else omit",
  "key_value_claims": [
    { "key": "short noun phrase", "value": "concise factual value", "confidence": 0.0 to 1.0 }
  ]
}

Rules:
- Be conservative: only include claims you can read directly. No speculation.
- Limit visible_text to ~3000 characters; preserve numbers, dates, named entities.
- Limit key_value_claims to <= 12; each value <= 200 characters.
- If the screen is mostly chrome/empty/login, return key_value_claims: [] and a short visible_text describing what you do see.`;

function normalizeKeyValueClaims(v: unknown): ExtractedKeyValue[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedKeyValue[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim().slice(0, 200) : "";
    const value = typeof r.value === "string" ? r.value.trim().slice(0, 400) : "";
    const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence))
      : 0.5;
    if (!key || !value) continue;
    out.push({ key, value, confidence });
    if (out.length >= 12) break;
  }
  return out;
}

export async function extractFromImage(args: {
  imageBase64: string;
  mimeType?: string;
  hintText?: string;
}): Promise<Extracted | null> {
  const mime = args.mimeType ?? "image/jpeg";
  const promptWithHint = args.hintText
    ? `${EXTRACT_PROMPT}\n\nUser instruction (focus extraction here when relevant):\n${args.hintText.slice(0, 600)}`
    : EXTRACT_PROMPT;

  let raw: string;
  try {
    raw = await vertexRunWithImage(getCopilotVisionModel(), args.imageBase64, mime, promptWithHint);
  } catch (e) {
    throw new Error(`Vision extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const parsed = parseJsonFromResponseOrNull(raw) as
    | { visible_text?: unknown; page_title?: unknown; hostname?: unknown; key_value_claims?: unknown }
    | null;
  if (!parsed || typeof parsed !== "object") return null;

  const visible_text = typeof parsed.visible_text === "string" ? parsed.visible_text.slice(0, 5000) : "";
  if (!visible_text || visible_text.length < 10) return null;

  return {
    visible_text,
    page_title: typeof parsed.page_title === "string" ? parsed.page_title.slice(0, 240) : undefined,
    hostname: typeof parsed.hostname === "string" ? parsed.hostname.toLowerCase().slice(0, 240) : undefined,
    key_value_claims: normalizeKeyValueClaims(parsed.key_value_claims),
  };
}
