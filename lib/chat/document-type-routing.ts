import { isDocumentGenerationRequest } from "@/lib/research/fast-intent";

export type DocumentTypeSummary = {
  id: string;
  name: string;
  output_format: string | null;
  description: string | null;
  instructions: string | null;
  learned_preferences: string | null;
  updated_at: string | null;
};

export type DocumentDeliveryMode = "explicit" | "ambiguous" | "none";

export type DocumentClarifyField = "delivery_mode" | "which_type" | "which_company";

export const MIN_PICK_SCORE = 8;
export const MIN_MARGIN = 4;
export const MIN_SINGLE_TYPE_SCORE = 3;

const DOC_SHAPED_NOUN_RE =
  /\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary|teaser|write[- ]?up|overview|analysis)\b/i;

const QA_DELIVERY_RE =
  /\b(give me|tell me|can you|could you|would you|what(?:'s| is| are)|how (?:is|are)|summarize|summary of|overview of)\b/i;

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function inferDocumentTypeHint(message: string): string | null {
  const lower = message.toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/\b(ic|investment committee)\s+memo\b/, "investment memo"],
    [/\binvestment\s+memo\b/, "investment memo"],
    [/\bmemo\b/, "memo"],
    [/\b(notes?|meeting notes|call notes)\b/, "notes"],
    [/\bbrief\b/, "brief"],
    [/\breport\b/, "report"],
    [/\bemail\b/, "email"],
    [/\bsummary\b/, "summary"],
    [/\bteaser\b/, "teaser"],
    [/\bone[- ]?pager\b/, "one pager"],
    [/\bwrite[- ]?up\b/, "write up"],
    [/\boverview\b/, "overview"],
  ];
  for (const [regex, hint] of pairs) {
    if (regex.test(lower)) return hint;
  }
  return null;
}

export function hasDocShapedNoun(message: string): boolean {
  return DOC_SHAPED_NOUN_RE.test(message);
}

export function classifyDocumentDelivery(message: string): DocumentDeliveryMode {
  const trimmed = message.trim();
  if (!trimmed) return "none";
  if (isDocumentGenerationRequest(trimmed)) return "explicit";
  if (!hasDocShapedNoun(trimmed)) return "none";
  if (QA_DELIVERY_RE.test(trimmed) || trimmed.endsWith("?")) return "ambiguous";
  return "none";
}

export function hintMatchesSavedType(hint: string | null, types: DocumentTypeSummary[]): boolean {
  if (!hint || !types.length) return false;
  const normalizedHint = normalizeText(hint);
  return types.some((type) => {
    const hay = normalizeText(`${type.name} ${type.description ?? ""}`);
    return hay.includes(normalizedHint) || normalizedHint.includes(normalizeText(type.name));
  });
}

export function documentSignalFromMessage(
  message: string,
  types: DocumentTypeSummary[] = [],
): boolean {
  const delivery = classifyDocumentDelivery(message);
  if (delivery === "explicit" || delivery === "ambiguous") return true;
  const hint = inferDocumentTypeHint(message);
  return hintMatchesSavedType(hint, types) || (Boolean(hint) && hasDocShapedNoun(message));
}

export function scoreDocumentType(type: DocumentTypeSummary, message: string, hint: string | null): number {
  const hay = normalizeText(
    `${type.name} ${type.output_format ?? ""} ${type.description ?? ""} ${type.instructions ?? ""} ${type.learned_preferences ?? ""}`,
  );
  const query = normalizeText(`${hint ?? ""} ${message}`);
  if (!hay || !query) return 0;
  let score = 0;
  const typeName = normalizeText(type.name);
  if (hint && hay.includes(normalizeText(hint))) score += 10;
  if (query.includes(typeName)) score += 8;
  if (hint && typeName === normalizeText(hint)) score += 6;
  const tokens = query.split(" ").filter((t) => t.length >= 3);
  for (const t of tokens) {
    if (hay.includes(t)) score += 1;
  }
  return score;
}

export type ScoredDocumentType = {
  type: DocumentTypeSummary;
  score: number;
};

export function scoreAllDocumentTypes(
  types: DocumentTypeSummary[],
  message: string,
  hint: string | null,
): ScoredDocumentType[] {
  return types
    .map((type) => ({ type, score: scoreDocumentType(type, message, hint) }))
    .sort((a, b) => b.score - a.score);
}

export function pickDocumentType(
  types: DocumentTypeSummary[],
  message: string,
  hint: string | null,
): ScoredDocumentType | null {
  const scored = scoreAllDocumentTypes(types, message, hint);
  return scored[0]?.score ? scored[0] : null;
}

export type DocumentGenerationResolution =
  | { status: "skip" }
  | { status: "needs_setup" }
  | { status: "clarify_delivery"; suggestedTypes: string[] }
  | { status: "clarify_type"; candidates: DocumentTypeSummary[] }
  | { status: "ready"; type: DocumentTypeSummary };

function routerType(
  types: DocumentTypeSummary[],
  typeIdFromRouter: string | null,
): DocumentTypeSummary | null {
  if (!typeIdFromRouter) return null;
  return types.find((t) => t.id === typeIdFromRouter) ?? null;
}

function strongSemanticMismatch(type: DocumentTypeSummary, hint: string | null, topScore: number): boolean {
  if (topScore >= MIN_SINGLE_TYPE_SCORE) return false;
  if (!hint) return false;
  const hay = normalizeText(`${type.name} ${type.description ?? ""} ${type.instructions ?? ""}`);
  const normalizedHint = normalizeText(hint);
  if (hay.includes(normalizedHint) || normalizeText(type.name).includes(normalizedHint)) return false;
  const conflict: Array<[RegExp, RegExp]> = [
    [/\bemail\b/, /\b(memo|report|brief|summary|teaser)\b/],
    [/\b(memo|report|brief|summary|teaser)\b/, /\bemail\b/],
  ];
  return conflict.some(([hintRe, typeRe]) => hintRe.test(normalizedHint) && typeRe.test(hay));
}

export function resolveDocumentGeneration(args: {
  message: string;
  types: DocumentTypeSummary[];
  typeHint: string | null;
  typeIdFromRouter?: string | null;
  clarifyFromRouter?: DocumentClarifyField[];
  generateEnabled?: boolean;
}): DocumentGenerationResolution {
  const delivery = classifyDocumentDelivery(args.message);
  const hint = args.typeHint ?? inferDocumentTypeHint(args.message);
  const routerClarify = args.clarifyFromRouter ?? [];
  const explicitRequest =
    delivery === "explicit" || (args.generateEnabled === true && delivery !== "ambiguous");

  if (routerClarify.includes("delivery_mode") || delivery === "ambiguous") {
    const suggested = args.types
      .filter((type) => scoreDocumentType(type, args.message, hint) > 0)
      .map((type) => type.name)
      .slice(0, 4);
    if (delivery === "ambiguous" || routerClarify.includes("delivery_mode")) {
      return { status: "clarify_delivery", suggestedTypes: suggested };
    }
  }

  if (!explicitRequest && !args.generateEnabled) {
    return { status: "skip" };
  }

  if (!args.types.length) {
    if (explicitRequest || args.generateEnabled) return { status: "needs_setup" };
    return { status: "skip" };
  }

  if (routerClarify.includes("which_type")) {
    const scored = scoreAllDocumentTypes(args.types, args.message, hint);
    const candidates = scored.filter((row) => row.score > 0).map((row) => row.type).slice(0, 6);
    return {
      status: "clarify_type",
      candidates: candidates.length ? candidates : args.types.slice(0, 6),
    };
  }

  const routed = routerType(args.types, args.typeIdFromRouter ?? null);
  if (routed) {
    return { status: "ready", type: routed };
  }

  const scored = scoreAllDocumentTypes(args.types, args.message, hint);
  const top = scored[0];
  const runnerUp = scored[1];

  if (!top) {
    if (explicitRequest && args.types.length === 1) {
      return { status: "ready", type: args.types[0]! };
    }
    if (explicitRequest) {
      return { status: "clarify_type", candidates: args.types.slice(0, 6) };
    }
    return { status: "skip" };
  }

  if (args.types.length === 1) {
    if (explicitRequest || args.generateEnabled) {
      if (strongSemanticMismatch(top.type, hint, top.score)) {
        return { status: "clarify_type", candidates: args.types };
      }
      return { status: "ready", type: top.type };
    }
  }

  const margin = top.score - (runnerUp?.score ?? 0);
  const confident = top.score >= MIN_PICK_SCORE && margin >= MIN_MARGIN;

  if (confident) {
    return { status: "ready", type: top.type };
  }

  if (explicitRequest || args.generateEnabled) {
    const candidates = scored.filter((row) => row.score > 0).map((row) => row.type);
    return {
      status: "clarify_type",
      candidates: candidates.length >= 2 ? candidates.slice(0, 6) : args.types.slice(0, 6),
    };
  }

  return { status: "skip" };
}

export function formatDeliveryClarificationMessage(suggestedTypes: string[]): string {
  if (suggestedTypes.length) {
    const names = suggestedTypes.map((name) => `"${name}"`).join(", ");
    return `Do you want a quick answer here in chat, or should I generate a saved document using one of your templates (${names})?`;
  }
  return "Do you want a quick answer here in chat, or should I generate a saved document from one of your document types?";
}

export function formatTypeClarificationMessage(candidates: DocumentTypeSummary[]): string {
  const names = candidates.map((t) => `"${t.name}"`).join(", ");
  return `Which document type should I use? Your saved types include: ${names}.`;
}

export function formatNeedsSetupMessage(): string {
  return "To generate documents from chat, create at least one document type in Documents first (templates, instructions, and output format). Then ask me again to draft or generate using that type.";
}

export function documentLikelyNeedsCompany(type: DocumentTypeSummary, message: string): boolean {
  const text = normalizeText(`${type.name} ${type.description ?? ""} ${message}`);
  return /\b(memo|report|analysis|profile|brief|company|competitor|investment|ic|diligence)\b/.test(text);
}
