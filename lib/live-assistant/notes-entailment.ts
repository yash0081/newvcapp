/**
 * Optional LLM gate: bullet must be fully entailed by cited source text.
 */

import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";

const FAST = getLiveAssistantModel("fast");

export type EntailmentResult = { ok: boolean; text: string | null };

/** ok=true means the bullet is supported by quotes; ok=false with text=repair suggestion; ok=false text=null means drop. */
export async function entailmentGate(bulletText: string, haystack: string): Promise<EntailmentResult> {
  const quotes = haystack.trim().slice(0, 7000);
  const bullet = bulletText.trim().slice(0, 400);
  const prompt = `You verify whether a meeting note bullet introduces ONLY facts present in the source quotes.

SOURCE_QUOTES (verbatim from the meeting; treat as ground truth):
${quotes}

BULLET_TO_CHECK:
${bullet}

Return strict JSON only:
{"supported": true | false, "replacement": string | null }

Rules:
- supported=true only if every factual assertion in the bullet appears in or clearly follows from SOURCE_QUOTES alone (no invented companies, names, or numbers).
- If supported=false, set replacement to a short investor-memo-style bullet (1–2 lines) that states only entailed facts. You may paraphrase for clarity; do NOT paste long transcript fragments or quote markers.
- Do not add new proper nouns not in SOURCE_QUOTES.`;

  try {
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return { ok: true, text: bulletText };

    const supported = parsed.supported === true || String(parsed.supported).toLowerCase() === "true";
    const repl = parsed.replacement;
    const replacement =
      repl === null || repl === undefined ? null : typeof repl === "string" ? repl.trim().slice(0, 320) : null;

    if (supported) return { ok: true, text: bulletText };
    if (replacement && replacement.length >= 6) return { ok: false, text: replacement };
    return { ok: false, text: null };
  } catch {
    return { ok: true, text: bulletText };
  }
}
