import { vertexRunWithText } from "@/lib/vertex";
import type { TranscriptSegment } from "@/lib/live-assistant/transcript";

const SUMMARY_MODEL =
  process.env.GEMINI_MODEL_FLASH_SUMMARY?.trim() ||
  process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
  "gemini-2.5-flash-lite";

export type MemoryState = {
  runningSummary: string;
  lastSummarizedTMs: number;
};

export type SummarizeDecision = {
  shouldSummarize: boolean;
  reason: "time" | "char_budget" | "manual" | "none";
};

export function shouldSummarize(opts: {
  running_summary_chars: number;
  new_raw_chars_since_last: number;
  ms_since_last_summary: number;
}): SummarizeDecision {
  const running = Math.max(0, Math.floor(opts.running_summary_chars));
  const newRaw = Math.max(0, Math.floor(opts.new_raw_chars_since_last));
  const since = Math.max(0, Math.floor(opts.ms_since_last_summary));

  // If summary is tiny, let it grow a bit.
  if (running < 400 && newRaw < 1200) return { shouldSummarize: false, reason: "none" };

  // Time-based: keep it fresh every few minutes during long meetings.
  if (since >= 3 * 60_000 && newRaw >= 600) return { shouldSummarize: true, reason: "time" };

  // Char budget: if raw is growing quickly, compress sooner.
  if (newRaw >= 2200) return { shouldSummarize: true, reason: "char_budget" };

  return { shouldSummarize: false, reason: "none" };
}

function renderSegments(segments: TranscriptSegment[], maxChars: number): string {
  let out = "";
  for (const s of segments) {
    const line = `${s.text}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

/**
 * Rolling meeting summary: preserves numbers, commitments, decisions, open questions.
 * This is intentionally plain-text so it can be injected into later prompts.
 */
export async function updateRunningSummary(opts: {
  priorSummary: string;
  newSegments: TranscriptSegment[]; // usually final-only segments since last summary point
  maxNewChars?: number;
}): Promise<string> {
  const prior = String(opts.priorSummary || "").trim();
  const maxNew = Math.max(800, opts.maxNewChars ?? 6000);
  const delta = renderSegments(opts.newSegments, maxNew);
  if (!delta) return prior;

  const prompt = `You are maintaining a rolling meeting summary for a VC meeting assistant.\n\nUpdate the existing summary using the new transcript excerpt. Preserve:\n- company/deal names and people\n- numbers and metrics (ARR, revenue, growth, churn, runway, CAC/LTV, etc.)\n- decisions, commitments, timelines\n- open questions / follow-ups\n- any potential inconsistencies to revisit\n\nRules:\n- Keep it concise: 10–25 lines max.\n- Plain text. No markdown.\n- Prefer short lines. Keep key numbers and dates.\n\nExisting summary:\n---\n${prior.slice(0, 30_000)}\n---\n\nNew transcript excerpt:\n---\n${delta.slice(0, 30_000)}\n---\n\nReturn ONLY the updated summary text.`;

  const out = await vertexRunWithText(SUMMARY_MODEL, prompt, false);
  return String(out || "").trim().slice(0, 10_000);
}

