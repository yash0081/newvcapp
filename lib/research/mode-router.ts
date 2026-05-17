import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import type { ResearchModelTier } from "@/lib/research/research-model-env";
import { computeOpenGaps, type ResearchGap } from "@/lib/copilot/research-agenda";
import { isDocumentGenerationRequest, isInternalOnlyQuestion } from "@/lib/research/fast-intent";
import { vertexRunWithText } from "@/lib/vertex";

export { isInternalOnlyQuestion } from "@/lib/research/fast-intent";

export type ResearchProfile = "fast" | "standard" | "deep";

export type ResearchModeDecision = {
  profile: ResearchProfile;
  needsWeb: boolean;
  needsWorkflow: boolean;
  reason: string;
  suggestedMaxSteps: number;
};

const PROFILE_RANK: Record<ResearchProfile, number> = {
  fast: 0,
  standard: 1,
  deep: 2,
};

const PUBLIC_FACT_RE =
  /\b(current|latest|recent|today|now|new|news|ceo|founder|co-?founders?|technical background|engineering background|work history|education|linkedin|headquarters|hq|funding round|raised|valuation|announced|verify|confirm|stock price|market cap|competitors?|patents?)\b/i;

const EXPLICIT_DEEP_RE =
  /\b(everything|full|complete|comprehensive|deep dive|deep research|all fields|general diligence|full diligence)\b/i;

const EXPLICIT_RESEARCH_RE =
  /\b(research|look into|investigate|find out|dig into|web search|search the web)\b/i;

const WORKFLOW_ESCALATION_RE =
  /\b(landscape|competitors?|patents?|common investors?|funding history|market sizing|multiple sources|several sources|side[- ]?by[- ]?side|matrix|tabular|compare .+ (to|with|vs|against))\b/i;

const BROAD_DILIGENCE_RE =
  /\b(diligence|investment analysis|analyze (this )?company|company analysis|score (this )?deal|evaluate (this )?deal|full picture|all angles|thesis fit|risk assessment)\b/i;

const DOCUMENT_REQUEST_RE =
  /\b(write|draft|generate|create|make|prepare|produce)\b.{0,80}\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary)\b|\b(ic|investment committee|investment)\s+memo\b/i;

const MULTI_ASPECT_RE =
  /\b(funding|traction|team|founders?|market|competitors?|product|customers?|revenue|growth).{0,80}(and|&|,).{0,80}(funding|traction|team|founders?|market|competitors?|product|customers?|revenue|growth)\b/i;

export function maxResearchProfile(a: ResearchProfile, b: ResearchProfile): ResearchProfile {
  return PROFILE_RANK[a] >= PROFILE_RANK[b] ? a : b;
}

export function profileMaxSteps(profile: ResearchProfile): number {
  switch (profile) {
    case "fast":
      return 2;
    case "standard":
      return 4;
    case "deep":
      return 14;
    default:
      return 4;
  }
}

export function profileFollowUpLimit(profile: ResearchProfile): number {
  switch (profile) {
    case "fast":
      return 0;
    case "standard":
      return 1;
    case "deep":
      return 2;
    default:
      return 1;
  }
}

export function profileExecuteTimeoutMs(profile: ResearchProfile): number {
  switch (profile) {
    case "fast":
      return Number(process.env.RESEARCH_EXECUTE_TIMEOUT_FAST_MS || 55_000);
    case "standard":
      return Number(process.env.RESEARCH_EXECUTE_TIMEOUT_STANDARD_MS || 90_000);
    case "deep":
      return Number(process.env.RESEARCH_EXECUTE_TIMEOUT_DEEP_MS || 120_000);
    default:
      return 90_000;
  }
}

export function profilePlannerModelTier(profile: ResearchProfile): ResearchModelTier {
  return profile === "deep" ? "flash" : "flash_lite";
}

export function profileExecuteModelTier(profile: ResearchProfile): ResearchModelTier {
  return profile === "deep" ? "flash" : "flash_lite";
}

/**
 * Deep Research toggle ON sets a floor (prefer at least deep-capable work).
 * Toggle OFF does not cap the router — inferred profile (including deep) is kept.
 */
export function resolveResearchProfile(
  inferred: ResearchProfile,
  deepModeEnabled: boolean,
  message: string,
): ResearchProfile {
  if (!deepModeEnabled) return inferred;
  if (EXPLICIT_DEEP_RE.test(message) || BROAD_DILIGENCE_RE.test(message)) return "deep";
  return maxResearchProfile(inferred, "deep");
}

/** @deprecated Use resolveResearchProfile — kept for existing imports */
export function applyProfileCeiling(
  profile: ResearchProfile,
  deepModeEnabled: boolean,
  message: string,
): ResearchProfile {
  return resolveResearchProfile(profile, deepModeEnabled, message);
}

export function internalContextSufficient(args: {
  message: string;
  openGaps: ResearchGap[];
  factChunkCount: number;
  docChunkCount: number;
  minChunks?: number;
}): boolean {
  const minChunks = args.minChunks ?? 3;
  const totalChunks = args.factChunkCount + args.docChunkCount;
  if (totalChunks < minChunks) return false;
  if (PUBLIC_FACT_RE.test(args.message)) return false;
  if (/\b(founder|co-?founder|technical background|engineering background|team background|who is the|ceo|cto)\b/i.test(args.message)) {
    return false;
  }
  if (args.openGaps.length > 6) return false;
  if (MULTI_ASPECT_RE.test(args.message)) return false;
  if (BROAD_DILIGENCE_RE.test(args.message)) return false;
  return true;
}

export function quickLookupWeak(result: { text: string; citations: unknown[] }): boolean {
  const text = result.text.trim();
  if (text.length < 40) return true;
  if (!result.citations.length && text.length < 120) return true;
  if (/\b(could not|unable to|no reliable|not find|unclear|conflicting|insufficient)\b/i.test(text)) return true;
  return false;
}

function inferResearchProfileFromSignals(args: {
  message: string;
  openGaps: ResearchGap[];
  factChunkCount: number;
  docChunkCount: number;
  internalOk: boolean;
  wantsResearchFromPrecheck?: boolean;
  runResearchEnabled?: boolean;
  documentGenerationOnly?: boolean;
}): Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason"> {
  const { message, openGaps, internalOk } = args;

  if (args.documentGenerationOnly || (isDocumentGenerationRequest(message) && !args.wantsResearchFromPrecheck)) {
    return {
      profile: "fast",
      needsWeb: !internalOk,
      needsWorkflow: false,
      reason: internalOk
        ? "Document generation from saved workspace context."
        : "Document generation with a brief web check because saved context is thin.",
    };
  }
  const wantsResearch =
    Boolean(args.wantsResearchFromPrecheck) ||
    Boolean(args.runResearchEnabled && EXPLICIT_RESEARCH_RE.test(message));
  const manyGaps = openGaps.length > 7;
  const moderateGaps = openGaps.length > 4;

  if (
    !DOCUMENT_REQUEST_RE.test(message) &&
    (EXPLICIT_DEEP_RE.test(message) || (BROAD_DILIGENCE_RE.test(message) && !internalOk))
  ) {
    return {
      profile: "deep",
      needsWeb: true,
      needsWorkflow: true,
      reason: "Broad diligence or comprehensive research scope detected.",
    };
  }

  if (
    wantsResearch &&
    (MULTI_ASPECT_RE.test(message) || manyGaps || WORKFLOW_ESCALATION_RE.test(message))
  ) {
    return {
      profile: "deep",
      needsWeb: true,
      needsWorkflow: true,
      reason: "Multi-aspect or multi-source research request with substantial open gaps.",
    };
  }

  if (wantsResearch || (args.runResearchEnabled && EXPLICIT_RESEARCH_RE.test(message))) {
    return {
      profile: "standard",
      needsWeb: true,
      needsWorkflow: true,
      reason: "Explicit research workflow request.",
    };
  }

  if (WORKFLOW_ESCALATION_RE.test(message) && !internalOk) {
    return {
      profile: moderateGaps ? "deep" : "standard",
      needsWeb: true,
      needsWorkflow: true,
      reason: "Multi-source or landscape question with thin internal context.",
    };
  }

  if (PUBLIC_FACT_RE.test(message) || !internalOk) {
    const escalateWorkflow = WORKFLOW_ESCALATION_RE.test(message) || moderateGaps;
    return {
      profile: "fast",
      needsWeb: true,
      needsWorkflow: escalateWorkflow,
      reason: PUBLIC_FACT_RE.test(message)
        ? "Question likely needs current public web evidence."
        : "Internal workspace context is thin for this question.",
    };
  }

  if (openGaps.length > 0 && openGaps.length <= 4 && internalOk) {
    return {
      profile: "fast",
      needsWeb: !isInternalOnlyQuestion(message),
      needsWorkflow: false,
      reason: isInternalOnlyQuestion(message)
        ? "Workspace-only question; saved context is sufficient."
        : "Brief public-web check to verify saved context on limited open gaps.",
    };
  }

  return {
    profile: "fast",
    needsWeb: !isInternalOnlyQuestion(message),
    needsWorkflow: false,
    reason: isInternalOnlyQuestion(message)
      ? "Workspace-only question."
      : "Default fast path: quick web check plus saved workspace context.",
  };
}

function modeRouterLlmEnabled(): boolean {
  return process.env.RESEARCH_ENABLE_LLM_MODE_ROUTER === "1";
}

function modeRouterModel(): string {
  return (
    process.env.RESEARCH_MODE_ROUTER_MODEL?.trim() ||
    process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
    process.env.GEMINI_MODEL_FLASH_SUMMARY?.trim() ||
    "gemini-2.5-flash-lite"
  );
}

function asResearchProfile(v: unknown): ResearchProfile | null {
  return v === "fast" || v === "standard" || v === "deep" ? v : null;
}

/** True when regex/heuristics alone are likely insufficient — skips LLM on obvious cases. */
export function shouldUseLlmModeRouter(args: {
  message: string;
  heuristic: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason">;
  internalOk: boolean;
  openGapCount: number;
  wantsResearchFromPrecheck?: boolean;
  runResearchEnabled?: boolean;
}): boolean {
  if (modeRouterLlmEnabled()) return true;
  const msg = args.message.trim();
  if (msg.length < 12) return false;

  const wantsResearch =
    Boolean(args.wantsResearchFromPrecheck) ||
    Boolean(args.runResearchEnabled && EXPLICIT_RESEARCH_RE.test(msg));

  if (args.heuristic.profile === "standard") return true;

  if (wantsResearch && !args.heuristic.needsWeb && args.internalOk) return true;
  if (!wantsResearch && args.heuristic.needsWorkflow && args.internalOk) return true;

  if (PUBLIC_FACT_RE.test(msg) && (BROAD_DILIGENCE_RE.test(msg) || MULTI_ASPECT_RE.test(msg))) return true;

  if (args.openGapCount >= 4 && args.openGapCount <= 7 && !EXPLICIT_DEEP_RE.test(msg)) return true;

  if (WORKFLOW_ESCALATION_RE.test(msg) && args.heuristic.profile === "fast" && args.internalOk) return true;

  return false;
}

function mergeModeLayers(
  heuristic: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason">,
  llm: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason"> | null,
): Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason"> {
  if (!llm) return heuristic;
  const profile = maxResearchProfile(heuristic.profile, llm.profile);
  const needsWeb = heuristic.needsWeb || llm.needsWeb;
  let needsWorkflow = heuristic.needsWorkflow || llm.needsWorkflow;
  if (profile === "deep" || profile === "standard") needsWorkflow = true;
  const reason = llm.reason
    ? `${heuristic.reason} LLM router: ${llm.reason}`
    : heuristic.reason;
  return { profile, needsWeb, needsWorkflow, reason };
}

async function classifyResearchProfileWithLlm(args: {
  message: string;
  deepModeEnabled: boolean;
  heuristic: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason">;
  internalOk: boolean;
  openGaps: ResearchGap[];
  factChunkCount: number;
  docChunkCount: number;
}): Promise<Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason"> | null> {
  const prompt = `You are the research depth router for a VC workspace chat.

Choose how much public-web and multi-step research this turn needs. The deterministic heuristic already ran; refine or confirm its call when the request is ambiguous.

Return strict JSON only:
{
  "profile": "fast" | "standard" | "deep",
  "needsWeb": boolean,
  "needsWorkflow": boolean,
  "reason": "one short sentence"
}

Rules:
- fast: one grounded lookup or saved context is enough (single fact, quick verify, narrow question).
- standard: a short workflow (about 1-4 steps) is appropriate (explicit research, several sources, one main topic).
- deep: broad diligence, multi-aspect analysis, competitor landscape, or comprehensive company understanding.
- needsWeb: true when public/current web evidence is required.
- needsWorkflow: true when multiple searches or structured research steps are needed; false only for answer-from-CRM cases.
- Do not choose deep for a single factual lookup (CEO, HQ, one funding number).
- Deep Research user toggle ON is a preference for depth, not a command to ignore a narrow question.`;

  const inputs = [
    { label: "User message", value: args.message.slice(0, 2000) },
    { label: "Deep Research toggle ON", value: args.deepModeEnabled },
    { label: "Heuristic decision", value: args.heuristic },
    { label: "Internal context sufficient", value: args.internalOk },
    { label: "Open gap fields", value: args.openGaps.slice(0, 12).map((g) => g.field) },
    { label: "Retrieved fact chunks", value: args.factChunkCount },
    { label: "Retrieved document chunks", value: args.docChunkCount },
  ]
    .map(({ label, value }) => `${label}:\n${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n\n");

  try {
    const raw = await vertexRunWithText(
      modeRouterModel(),
      `${inputs}\n\n---\n\n${prompt}\n\nReturn strict JSON only, no other text.`,
      false,
    );
    const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const profile = asResearchProfile(parsed.profile);
    if (!profile) return null;
    return {
      profile,
      needsWeb: parsed.needsWeb === true,
      needsWorkflow: parsed.needsWorkflow === true,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 280) : "",
    };
  } catch {
    return null;
  }
}

export function finalizeResearchModeDecision(args: {
  message: string;
  deepModeEnabled: boolean;
  merged: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason">;
  heuristicProfile: ResearchProfile;
  documentGenerationOnly?: boolean;
}): ResearchModeDecision {
  if (args.documentGenerationOnly) {
    return {
      profile: "fast",
      needsWeb: args.merged.needsWeb,
      needsWorkflow: false,
      reason: args.merged.reason || "Document generation from saved workspace context.",
      suggestedMaxSteps: profileMaxSteps("fast"),
    };
  }

  const profile = resolveResearchProfile(args.merged.profile, args.deepModeEnabled, args.message);

  let needsWeb = args.merged.needsWeb;
  let needsWorkflow = args.merged.needsWorkflow;
  if (isDocumentGenerationRequest(args.message)) {
    return {
      profile: "fast",
      needsWeb,
      needsWorkflow: false,
      reason: args.merged.reason || "Document generation from saved workspace context.",
      suggestedMaxSteps: profileMaxSteps("fast"),
    };
  }
  if (profile === "deep") {
    needsWeb = true;
    needsWorkflow = true;
  } else if (profile === "standard") {
    needsWeb = true;
    needsWorkflow = true;
  } else if (profile === "fast" && !isInternalOnlyQuestion(args.message)) {
    needsWeb = true;
  }

  let reason = args.merged.reason;
  if (args.deepModeEnabled && profile !== args.heuristicProfile) {
    reason = `${reason} Deep Research toggle raised profile to ${profile}.`;
  }

  return {
    profile,
    needsWeb,
    needsWorkflow,
    reason,
    suggestedMaxSteps: profileMaxSteps(profile),
  };
}

function buildHeuristicModeDecision(args: {
  message: string;
  openGaps: ResearchGap[];
  factChunkCount: number;
  docChunkCount: number;
  wantsResearchFromPrecheck?: boolean;
  runResearchEnabled?: boolean;
  documentGenerationOnly?: boolean;
}): {
  internalOk: boolean;
  heuristic: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason">;
} {
  const internalOk = internalContextSufficient({
    message: args.message,
    openGaps: args.openGaps,
    factChunkCount: args.factChunkCount,
    docChunkCount: args.docChunkCount,
  });
  const heuristic = inferResearchProfileFromSignals({
    message: args.message,
    openGaps: args.openGaps,
    factChunkCount: args.factChunkCount,
    docChunkCount: args.docChunkCount,
    internalOk,
    wantsResearchFromPrecheck: args.wantsResearchFromPrecheck,
    runResearchEnabled: args.runResearchEnabled,
    documentGenerationOnly: args.documentGenerationOnly,
  });
  return { internalOk, heuristic };
}

/** Sync path: deterministic heuristics only (fast; used in tests and as fallback). */
export function classifyResearchMode(args: {
  message: string;
  deepModeEnabled: boolean;
  openGaps?: ResearchGap[];
  factChunkCount?: number;
  docChunkCount?: number;
  wantsResearchFromPrecheck?: boolean;
  runResearchEnabled?: boolean;
  documentGenerationOnly?: boolean;
}): ResearchModeDecision {
  const message = args.message.trim();
  const openGaps = args.openGaps ?? [];
  const { internalOk, heuristic } = buildHeuristicModeDecision({
    message,
    openGaps,
    factChunkCount: args.factChunkCount ?? 0,
    docChunkCount: args.docChunkCount ?? 0,
    wantsResearchFromPrecheck: args.wantsResearchFromPrecheck,
    runResearchEnabled: args.runResearchEnabled,
    documentGenerationOnly: args.documentGenerationOnly,
  });
  return finalizeResearchModeDecision({
    message,
    deepModeEnabled: args.deepModeEnabled,
    merged: heuristic,
    heuristicProfile: heuristic.profile,
    documentGenerationOnly: args.documentGenerationOnly,
  });
}

/**
 * Hybrid router: always runs regex/gap heuristics; adds a small LLM pass only when
 * RESEARCH_ENABLE_LLM_MODE_ROUTER=1 or the heuristic outcome is ambiguous.
 */
export async function classifyResearchModeAsync(args: {
  message: string;
  deepModeEnabled: boolean;
  openGaps?: ResearchGap[];
  factChunkCount?: number;
  docChunkCount?: number;
  wantsResearchFromPrecheck?: boolean;
  runResearchEnabled?: boolean;
  documentGenerationOnly?: boolean;
}): Promise<ResearchModeDecision> {
  const message = args.message.trim();
  const openGaps = args.openGaps ?? [];
  const factChunkCount = args.factChunkCount ?? 0;
  const docChunkCount = args.docChunkCount ?? 0;
  const { internalOk, heuristic } = buildHeuristicModeDecision({
    message,
    openGaps,
    factChunkCount,
    docChunkCount,
    wantsResearchFromPrecheck: args.wantsResearchFromPrecheck,
    runResearchEnabled: args.runResearchEnabled,
    documentGenerationOnly: args.documentGenerationOnly,
  });

  let llmLayer: Pick<ResearchModeDecision, "profile" | "needsWeb" | "needsWorkflow" | "reason"> | null = null;
  if (
    shouldUseLlmModeRouter({
      message,
      heuristic,
      internalOk,
      openGapCount: openGaps.length,
      wantsResearchFromPrecheck: args.wantsResearchFromPrecheck,
      runResearchEnabled: args.runResearchEnabled,
    })
  ) {
    llmLayer = await classifyResearchProfileWithLlm({
      message,
      deepModeEnabled: args.deepModeEnabled,
      heuristic,
      internalOk,
      openGaps,
      factChunkCount,
      docChunkCount,
    });
  }

  const merged = mergeModeLayers(heuristic, llmLayer);
  return finalizeResearchModeDecision({
    message,
    deepModeEnabled: args.deepModeEnabled,
    merged,
    heuristicProfile: heuristic.profile,
    documentGenerationOnly: args.documentGenerationOnly,
  });
}

/** In-memory query embedding cache (short TTL) to avoid duplicate embed calls per turn. */
const embedCache = new Map<string, { vec: number[]; expiresAt: number }>();
const EMBED_CACHE_TTL_MS = Number(process.env.RESEARCH_QUERY_EMBED_CACHE_TTL_MS || 180_000);

export function cacheKeyForQuery(userId: string, query: string): string {
  return `${userId}:${query.trim().slice(0, 500).toLowerCase()}`;
}

export function getCachedQueryEmbedding(key: string): number[] | null {
  const hit = embedCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    embedCache.delete(key);
    return null;
  }
  return hit.vec;
}

export function setCachedQueryEmbedding(key: string, vec: number[]): void {
  embedCache.set(key, { vec, expiresAt: Date.now() + EMBED_CACHE_TTL_MS });
  if (embedCache.size > 200) {
    const oldest = embedCache.keys().next().value;
    if (oldest) embedCache.delete(oldest);
  }
}

export function researchProfileFromMetadata(meta: unknown): ResearchProfile {
  if (!meta || typeof meta !== "object") return "standard";
  const raw = (meta as Record<string, unknown>).research_profile;
  if (raw === "fast" || raw === "standard" || raw === "deep") return raw;
  return "standard";
}

export function computeOpenGapsForMode(args: {
  metadata?: Record<string, unknown> | null;
  recentClaims?: Array<{ key?: string; value: string; source?: string }>;
}): ResearchGap[] {
  return computeOpenGaps({
    metadata: args.metadata,
    recentClaims: args.recentClaims ?? [],
    sessionAcceptedSnippets: [],
  });
}
