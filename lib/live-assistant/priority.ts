import type { ClaimIntent, ClaimSection } from "@/lib/live-assistant/claim-classifier";

export type PriorityClaim = {
  text: string;
  section: ClaimSection;
  intent: ClaimIntent;
  confidence: number;
  isNotable?: boolean;
  emittedAtMs: number;
};

export type PriorityPrefs = {
  sectionWeights?: Partial<Record<ClaimSection, number>>;
  preferenceConfidence?: number;
  domainBoost?: number;
  taskBoost?: number;
};

const DEFAULT_SECTION_WEIGHT: Record<ClaimSection, number> = {
  team: 0.9,
  problem: 1.0,
  solution: 1.0,
  market: 1.05,
  product: 1.0,
  traction: 1.3,
  gtm: 1.1,
  competition: 1.0,
  financials: 1.25,
  risks: 1.2,
  other: 0.8,
};

const INTENT_WEIGHT: Record<ClaimIntent, number> = {
  metric: 1.3,
  claim: 1.0,
  plan: 1.1,
  opinion: 0.8,
};

function clampPositive(v: number, fallback = 1): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function scoreClaimPriority(
  claim: PriorityClaim,
  opts: {
    nowMs?: number;
    prefs?: PriorityPrefs;
    novelty?: number;
  } = {},
): number {
  const nowMs = opts.nowMs ?? Date.now();
  const ageSec = Math.max(0, (nowMs - claim.emittedAtMs) / 1000);
  const recencyDecay = Math.max(0.4, 1 - ageSec / 180);
  const sectionWeight = clampPositive(opts.prefs?.sectionWeights?.[claim.section] ?? DEFAULT_SECTION_WEIGHT[claim.section]);
  const intentWeight = INTENT_WEIGHT[claim.intent] ?? 1;
  const novelty = clampPositive(opts.novelty ?? 1, 1);
  const confidence = Math.max(0.3, Math.min(1, claim.confidence || 0.5));
  const notableBoost = claim.isNotable ? 1.2 : 1;
  const prefConf = clampPositive(opts.prefs?.preferenceConfidence ?? 0.8, 0.8);
  const domainBoost = clampPositive(opts.prefs?.domainBoost ?? 1, 1);
  const taskBoost = clampPositive(opts.prefs?.taskBoost ?? 1, 1);
  return sectionWeight * intentWeight * novelty * confidence * recencyDecay * notableBoost * prefConf * domainBoost * taskBoost;
}

export function mapPriorityToQueueValue(score: number): number {
  // bg_job priority: lower numbers run first.
  const bounded = Math.max(0.1, Math.min(4, score));
  return Math.round(220 - bounded * 45);
}

