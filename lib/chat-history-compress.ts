import { vertexRunWithText } from "@/lib/vertex";

const HISTORY_CHAR_THRESHOLD = 7000;
const TARGET_SUMMARY_CHARS = 2200;

/**
 * Plan B5: compress multi-turn history with a lightweight model when over budget.
 */
export async function compressChatHistoryIfNeeded(
  historyBlock: string,
  summaryModel: string
): Promise<string> {
  const trimmed = historyBlock.trim();
  if (trimmed.length <= HISTORY_CHAR_THRESHOLD) return historyBlock;

  const prompt = `Summarize the following chat transcript for another model that will answer the next user message.
Preserve: company/deal names, decisions, numbers, open questions, and user intent.
Max ${TARGET_SUMMARY_CHARS} characters. Plain text, no bullets unless essential.

---TRANSCRIPT---
${trimmed.slice(0, 100_000)}
---END---`;

  try {
    const out = await vertexRunWithText(summaryModel, prompt, false);
    const s = out.trim().slice(0, TARGET_SUMMARY_CHARS + 500);
    return `Prior turns (compressed):\n${s}`;
  } catch {
    return `Prior turns (truncated):\n${trimmed.slice(-HISTORY_CHAR_THRESHOLD)}`;
  }
}
