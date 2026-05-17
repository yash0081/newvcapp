import type { WebsiteCategory } from "@/lib/research/types";

/** Generate memo/report/etc. — use stored workspace context, not a research workflow. */
export const DOCUMENT_GENERATION_RE =
  /\b(write|draft|generate|create|make|prepare|produce)\b.{0,80}\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary)\b|\b(ic|investment committee|investment)\s+memo\b/i;

/** Questions that usually need public web even when CRM has some data. */
const PUBLIC_ENTITY_RE =
  /\b(founder|co-?founders?|ceo|cto|cmo|team|leadership|technical background|engineering background|work history|career|education|degree|phd|mba|linkedin|pedigree|background of|who is|executive|prior (?:role|company|exit))\b/i;

/** User is asking only about saved workspace / CRM content — skip web. */
const INTERNAL_ONLY_RE =
  /\b(what did we (save|record|note)|in our (crm|database|records|workspace|files|decks)|from (?:the )?saved|internal(?:ly)?|already (?:in|on) (?:file|record)|our notes|uploaded (?:deck|doc)|in the deck we have|summarize what we know|from workspace)\b/i;

const EXPLICIT_WEB_RE =
  /\b(search the web|web search|look up online|on the internet|public(?:ly)? available|current|latest|recent|verify online|check online)\b/i;

export function isDocumentGenerationRequest(message: string): boolean {
  return DOCUMENT_GENERATION_RE.test(message.trim());
}

export function isDocumentPrimaryRequest(args: {
  message: string;
  generateDocumentEnabled: boolean;
  wantsResearchFromPrecheck: boolean;
}): boolean {
  if (!args.generateDocumentEnabled) return false;
  if (args.wantsResearchFromPrecheck) return false;
  if (isDocumentGenerationRequest(args.message)) return true;
  return args.generateDocumentEnabled;
}

export type FastResearchIntent = {
  userGoal: string;
  requiredTopics: string[];
  allowedCategories: WebsiteCategory[];
  excludedTopics: string[];
  includeRiskCheck: boolean;
  mustCompare: boolean;
};

export function isInternalOnlyQuestion(message: string): boolean {
  const msg = message.trim();
  if (!msg) return false;
  if (EXPLICIT_WEB_RE.test(msg)) return false;
  if (PUBLIC_ENTITY_RE.test(msg)) return false;
  if (isDocumentGenerationRequest(msg)) return false;
  if (INTERNAL_ONLY_RE.test(msg)) return true;
  if (/\bwhat do we know about\b/i.test(msg)) return true;
  return false;
}

export function buildQuickLookupQuery(args: {
  message: string;
  companyName?: string | null;
  intent: FastResearchIntent;
}): string {
  const base = args.message.trim().slice(0, 600);
  const parts: string[] = [];
  if (args.companyName && !base.toLowerCase().includes(args.companyName.toLowerCase())) {
    parts.push(args.companyName.trim());
  }
  parts.push(base);
  const extraTopics = args.intent.requiredTopics
    .filter((topic) => topic.length >= 3 && !base.toLowerCase().includes(topic.toLowerCase()))
    .slice(0, 2);
  if (extraTopics.length) parts.push(`Verify: ${extraTopics.join("; ")}`);
  return parts.join(" — ").slice(0, 700);
}

export function formatFastIntentForPrompt(intent: FastResearchIntent): string {
  const lines = [
    `Goal: ${intent.userGoal}`,
    intent.requiredTopics.length ? `Topics: ${intent.requiredTopics.slice(0, 6).join(", ")}` : "",
    intent.allowedCategories.length ? `Angles: ${intent.allowedCategories.join(", ")}` : "",
    intent.excludedTopics.length ? `Exclude: ${intent.excludedTopics.slice(0, 4).join(", ")}` : "",
    intent.includeRiskCheck ? "Include material risks if directly relevant." : "",
    intent.mustCompare ? "Comparison or overlap may be required." : "",
  ].filter(Boolean);
  return lines.join("\n");
}
