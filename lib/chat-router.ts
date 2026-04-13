import type { ChatTask } from "@/lib/retrieval-orchestrator";

/**
 * Lightweight task router (plan B3): replace with LLM classifier when needed.
 */
export function classifyChatTask(userMessage: string): ChatTask {
  const t = userMessage.toLowerCase();
  if (/\b(similar|comps?|comparable|like this company)\b/.test(t)) return "similar_deal";
  if (/\b(filter|list deals|which deals|stage|sector)\b/.test(t)) return "filtering";
  if (/\b(what should i ask|questions to ask|diligence questions)\b/.test(t)) return "questions";
  if (/\b(why|how do you know|prove|evidence)\b/.test(t)) return "why";
  return "deep_reasoning";
}
