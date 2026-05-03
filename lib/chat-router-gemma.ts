import type { ChatTask } from "@/lib/retrieval-orchestrator";
import { classifyChatTask } from "@/lib/chat-router";
import { vertexRunWithText } from "@/lib/vertex";

const ROUTER_MODEL =
  process.env.GEMINI_MODEL_ROUTER?.trim() ||
  process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
  process.env.GEMINI_MODEL_FLASH_SUMMARY?.trim() ||
  "gemini-2.5-flash-lite";

const VALID: ChatTask[] = [
  "similar_deal",
  "filtering",
  "deep_reasoning",
  "why",
  "questions",
];

function isChatTask(s: string): s is ChatTask {
  return (VALID as string[]).includes(s);
}

/**
 * Gemma/Gemini router: classify user message into a ChatTask. Falls back to heuristics on failure.
 */
export async function classifyChatTaskWithGemma(userMessage: string): Promise<ChatTask> {
  const prompt = `You are a classifier for a VC deal workspace. Read the user message and respond with ONLY a JSON object, no formatting fences, no extra text:
{"task":"filtering"|"similar_deal"|"deep_reasoning"|"why"|"questions"}

Definitions:
- filtering: listing/filtering deals by stage, sector, metrics, "top N", tabular constraints
- similar_deal: find comparable companies, comps, "like this company"
- deep_reasoning: broad synthesis, strategy, multi-aspect comparison across corpus
- why: asking for evidence, proof, "how do you know"
- questions: what to ask founders, diligence questions

User message:
${userMessage.slice(0, 6000)}`;

  try {
    const text = await vertexRunWithText(ROUTER_MODEL, prompt, false);
    const m = text.match(/\{[\s\S]*"task"[\s\S]*\}/);
    const raw = m ? JSON.parse(m[0]) : JSON.parse(text);
    const t = (raw as { task?: string }).task;
    if (typeof t === "string" && isChatTask(t)) return t;
  } catch {
    /* fallback */
  }
  return classifyChatTask(userMessage);
}

export function retrieveLimitForTask(task: ChatTask): number {
  switch (task) {
    case "filtering":
      return 18;
    case "similar_deal":
      return 28;
    case "deep_reasoning":
      return 36;
    case "why":
    case "questions":
      return 26;
    default:
      return 22;
  }
}

export function chatModelForTask(task: ChatTask): string {
  const lite =
    process.env.GEMINI_MODEL_FLASH_LITE ||
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    "gemini-2.5-flash-lite";
  const full = process.env.GEMINI_MODEL_FLASH || lite;
  if (task === "deep_reasoning" || task === "why") return full;
  return lite;
}

/** Plan alias: same as classifyChatTaskWithGemma (deterministic fallback on failure). */
export const routeChatTaskWithGemma = classifyChatTaskWithGemma;
