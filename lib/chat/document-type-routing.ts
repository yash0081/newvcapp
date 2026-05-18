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

const DOC_SHAPED_NOUN_RE =
  /\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary|teaser|write[- ]?up|overview|analysis)\b/i;

const QA_DELIVERY_RE =
  /\b(give me|tell me|can you|could you|would you|what(?:'s| is| are)|how (?:is|are)|summarize|summary of|overview of)\b/i;

const IMPLICIT_GENERATE_RE =
  /\b(want|need|get|use|using|with)\b.{0,50}\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary|teaser|write[- ]?up|overview|analysis)\b/i;

const DOC_TYPE_REFERENCE_RE =
  /\b(document type|doc type|template|format)\b/i;

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function messageMentionsTypeName(message: string, typeName: string): boolean {
  const name = normalizeText(typeName);
  if (!name || name.length < 2) return false;
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(message);
}

export function typesNamedInMessage(message: string, types: DocumentTypeSummary[]): DocumentTypeSummary[] {
  return types.filter((type) => messageMentionsTypeName(message, type.name));
}

const DOC_NOUN_HINTS = ["report", "memo", "brief", "email", "teaser", "summary", "one pager", "write up"];

/** User asked for a specific doc kind (e.g. "report") that the saved type name does not cover. */
function hasUnresolvedDocNoun(message: string, typeName: string): boolean {
  const typeNorm = normalizeText(typeName);
  for (const noun of DOC_NOUN_HINTS) {
    if (!new RegExp(`\\b${escapeRegExp(noun)}\\b`, "i").test(message)) continue;
    if (!typeNorm.includes(noun.replace(/\s+/g, " "))) return true;
  }
  return false;
}

/** Prefer the longest saved type name that appears in the user message. */
export function findTypeMentionedInMessage(
  message: string,
  types: DocumentTypeSummary[],
): DocumentTypeSummary | null {
  const normalizedMessage = normalizeText(message);
  let best: { type: DocumentTypeSummary; score: number } | null = null;
  for (const type of types) {
    const name = normalizeText(type.name);
    if (!name || name.length < 2) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    const docTypePhrase = new RegExp(`\\b${escapeRegExp(name)}\\s+(?:doc(?:ument)?\\s+)?type\\b`, "i");
    const matches =
      pattern.test(message) ||
      docTypePhrase.test(message) ||
      normalizedMessage.includes(name);
    if (!matches) continue;
    const score = name.length + (pattern.test(message) ? 10 : 0) + (docTypePhrase.test(message) ? 12 : 0);
    if (!best || score > best.score) best = { type, score };
  }
  return best?.type ?? null;
}

export function hasDocShapedNoun(message: string): boolean {
  return DOC_SHAPED_NOUN_RE.test(message);
}

export function classifyDocumentDelivery(message: string): DocumentDeliveryMode {
  const trimmed = message.trim();
  if (!trimmed) return "none";
  if (isDocumentGenerationRequest(trimmed)) return "explicit";
  if (IMPLICIT_GENERATE_RE.test(trimmed)) return "explicit";
  if (DOC_TYPE_REFERENCE_RE.test(trimmed) && hasDocShapedNoun(trimmed)) return "explicit";
  if (!hasDocShapedNoun(trimmed)) return "none";
  if (QA_DELIVERY_RE.test(trimmed) || trimmed.endsWith("?")) return "ambiguous";
  return "none";
}

/** User wants a generated file (not a chat answer). */
export function messageRequestsSavedDocumentGeneration(
  message: string,
  types: DocumentTypeSummary[] = [],
): boolean {
  if (isDocumentGenerationRequest(message)) return true;
  if (findTypeMentionedInMessage(message, types)) return true;
  if (typesNamedInMessage(message, types).length > 0) return true;
  return false;
}

export function documentSignalFromMessage(message: string, types: DocumentTypeSummary[] = []): boolean {
  const delivery = classifyDocumentDelivery(message);
  if (delivery === "explicit" || delivery === "ambiguous") return true;
  return messageRequestsSavedDocumentGeneration(message, types);
}

export type SavedDocumentTypePick =
  | { kind: "ready"; type: DocumentTypeSummary }
  | { kind: "clarify"; types: DocumentTypeSummary[] };

/**
 * Pick a document type only from the user's saved list.
 * Never guesses from generic words like "report" unless a saved type name matches.
 */
export function pickSavedDocumentType(
  message: string,
  types: DocumentTypeSummary[],
  routerTypeId?: string | null,
): SavedDocumentTypePick {
  if (!types.length) return { kind: "clarify", types: [] };

  const mentioned = findTypeMentionedInMessage(message, types);
  if (mentioned) return { kind: "ready", type: mentioned };

  const namedInMessage = typesNamedInMessage(message, types);
  if (namedInMessage.length === 1) return { kind: "ready", type: namedInMessage[0]! };
  if (namedInMessage.length > 1) return { kind: "clarify", types: namedInMessage };

  if (types.length === 1) {
    const only = types[0]!;
    if (messageMentionsTypeName(message, only.name) || !hasUnresolvedDocNoun(message, only.name)) {
      return { kind: "ready", type: only };
    }
    return { kind: "clarify", types };
  }

  if (routerTypeId) {
    const routed = types.find((type) => type.id === routerTypeId);
    if (routed && messageMentionsTypeName(message, routed.name)) {
      return { kind: "ready", type: routed };
    }
  }

  return { kind: "clarify", types };
}

export type DocumentGenerationResolution =
  | { status: "skip" }
  | { status: "needs_setup" }
  | { status: "clarify_delivery"; suggestedTypes: string[] }
  | { status: "clarify_type"; candidates: DocumentTypeSummary[] }
  | { status: "ready"; type: DocumentTypeSummary };

export function resolveDocumentGeneration(args: {
  message: string;
  types: DocumentTypeSummary[];
  typeIdFromRouter?: string | null;
  clarifyFromRouter?: DocumentClarifyField[];
  generateEnabled?: boolean;
}): DocumentGenerationResolution {
  const delivery = classifyDocumentDelivery(args.message);
  const namedType = findTypeMentionedInMessage(args.message, args.types);
  const wantsGeneration =
    messageRequestsSavedDocumentGeneration(args.message, args.types) || args.generateEnabled === true;

  if (
    (args.clarifyFromRouter ?? []).includes("delivery_mode") ||
    (delivery === "ambiguous" && !namedType && !args.generateEnabled)
  ) {
    return {
      status: "clarify_delivery",
      suggestedTypes: args.types.map((type) => type.name).slice(0, 6),
    };
  }

  if (!wantsGeneration) return { status: "skip" };
  if (!args.types.length) return { status: "needs_setup" };

  const pick = pickSavedDocumentType(args.message, args.types, args.typeIdFromRouter ?? null);
  if (pick.kind === "ready") return { status: "ready", type: pick.type };
  return {
    status: "clarify_type",
    candidates: pick.types.length ? pick.types : args.types,
  };
}

export function formatDeliveryClarificationMessage(suggestedTypes: string[]): string {
  if (suggestedTypes.length) {
    const names = suggestedTypes.map((name) => `"${name}"`).join(", ");
    return `Do you want a quick answer here in chat, or should I generate a saved document using one of your templates (${names})?`;
  }
  return "Do you want a quick answer here in chat, or should I generate a saved document from one of your document types?";
}

export function formatTypeClarificationMessage(candidates: DocumentTypeSummary[]): string {
  const names = candidates.map((type) => `"${type.name}"`).join(", ");
  return `Choose which saved document type to generate. Your types: ${names}. Click one below.`;
}

export function formatNeedsSetupMessage(): string {
  return "To generate documents from chat, create at least one document type in Documents first (templates, instructions, and output format). Then ask me again using that type's exact name.";
}

export function documentLikelyNeedsCompany(type: DocumentTypeSummary, message: string): boolean {
  const text = normalizeText(`${type.name} ${type.description ?? ""} ${message}`);
  return /\b(memo|report|analysis|profile|brief|company|competitor|investment|ic|diligence)\b/.test(text);
}
