/**
 * Online per-user recommender weights for the auto-mode planner.
 *
 * Five-feature linear model + bias, scored as a logistic regression:
 *   score(c)  = w · x(c) + bias
 *   p(accept) = sigmoid(score)
 *
 * Weights live in `deal_intel.copilot_recommender_weights` (one row per user).
 * Every plan-next decision logs feature vectors to `deal_intel.copilot_ranking_event`
 * so attribution (accept / reject / skip / paywall / implicit dwell) can recover
 * the *moment-of-decision* features for the SGD update.
 *
 * Cold start: when no row exists, we use `RECOMMENDER_PRIORS` and the first
 * label seeds a fresh row.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type RecommenderFeatures = {
  task_fit: number;
  freq_penalty: number;
  accept_signal: number;
  reject_signal: number;
  page_relevance: number;
  // New hybrid exploration features
  same_host: number;
  is_trusted_seed: number;
  task_alignment_score: number;
  novelty_score: number;
  dead_end_penalty: number;
  unexplored_relevant_links: number;
};

export type RecommenderWeights = {
  w_task: number;
  w_freq: number;
  w_accept: number;
  w_reject: number;
  w_page: number;
  bias: number;
  // New hybrid exploration weights
  w_same_host: number;
  w_trusted_seed: number;
  w_task_alignment: number;
  w_novelty: number;
  w_dead_end: number;
};

export const RECOMMENDER_PRIORS: RecommenderWeights = {
  w_task: 1.0,
  w_freq: 0.7,
  w_accept: 0.6,
  w_reject: 1.2,
  w_page: 0.5,
  bias: 0.0,
  // Strong bias toward staying on current page
  w_same_host: 1.5,
  // Mild penalty for generic aggregators
  w_trusted_seed: -0.3,
  // Strong bias toward task-guided exploration
  w_task_alignment: 0.8,
  // Strong bias toward novel information
  w_novelty: 0.7,
  // Strong penalty for failed paths
  w_dead_end: -1.0,
};

/** Hard clip per weight after each SGD step so a single bad batch can't blow up the model. */
const WEIGHT_CLIP = 3.0;
/** Base learning rate; decays with sqrt(updates_count). */
const BASE_LR = 0.05;
/** L2 regularization strength toward priors. */
const L2_LAMBDA = 0.01;
/** Implicit signals carry half the gradient weight of explicit ones. */
export const IMPLICIT_SAMPLE_WEIGHT = 0.5;

export type LoadedWeights = {
  weights: RecommenderWeights;
  updates_count: number;
  /** True when the user has no row yet — caller should treat the score as cold-start. */
  cold_start: boolean;
};

/** Load this user's weights or fall back to priors. Never throws. */
export async function getUserRecommenderWeights(args: {
  admin: SupabaseClient;
  userId: string;
}): Promise<LoadedWeights> {
  try {
    const res = await args.admin
      .schema("deal_intel")
      .from("copilot_recommender_weights")
      .select("weights, updates_count")
      .eq("user_id", args.userId)
      .maybeSingle();
    if (res.error || !res.data) {
      return { weights: { ...RECOMMENDER_PRIORS }, updates_count: 0, cold_start: true };
    }
    const w = parseWeights(res.data.weights);
    const n = typeof res.data.updates_count === "number" ? Math.max(0, Math.round(res.data.updates_count)) : 0;
    return { weights: w, updates_count: n, cold_start: n === 0 };
  } catch {
    return { weights: { ...RECOMMENDER_PRIORS }, updates_count: 0, cold_start: true };
  }
}

function parseWeights(raw: unknown): RecommenderWeights {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (k: keyof RecommenderWeights, fallback: number): number => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  return {
    w_task: clip(num("w_task", RECOMMENDER_PRIORS.w_task)),
    w_freq: clip(num("w_freq", RECOMMENDER_PRIORS.w_freq)),
    w_accept: clip(num("w_accept", RECOMMENDER_PRIORS.w_accept)),
    w_reject: clip(num("w_reject", RECOMMENDER_PRIORS.w_reject)),
    w_page: clip(num("w_page", RECOMMENDER_PRIORS.w_page)),
    bias: clip(num("bias", RECOMMENDER_PRIORS.bias)),
    // New hybrid exploration weights
    w_same_host: clip(num("w_same_host", RECOMMENDER_PRIORS.w_same_host)),
    w_trusted_seed: clip(num("w_trusted_seed", RECOMMENDER_PRIORS.w_trusted_seed)),
    w_task_alignment: clip(num("w_task_alignment", RECOMMENDER_PRIORS.w_task_alignment)),
    w_novelty: clip(num("w_novelty", RECOMMENDER_PRIORS.w_novelty)),
    w_dead_end: clip(num("w_dead_end", RECOMMENDER_PRIORS.w_dead_end)),
  };
}

function clip(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v > WEIGHT_CLIP) return WEIGHT_CLIP;
  if (v < -WEIGHT_CLIP) return -WEIGHT_CLIP;
  return v;
}

function sigmoid(z: number): number {
  if (z >= 40) return 1;
  if (z <= -40) return 0;
  return 1 / (1 + Math.exp(-z));
}

/** Linear score (no sigmoid). Used at ranking time. */
export function scoreFeatures(x: RecommenderFeatures, w: RecommenderWeights): number {
  return (
    w.w_task * x.task_fit +
    w.w_freq * x.freq_penalty +
    w.w_accept * x.accept_signal +
    w.w_reject * x.reject_signal +
    w.w_page * x.page_relevance +
    w.w_same_host * x.same_host +
    w.w_trusted_seed * x.is_trusted_seed +
    w.w_task_alignment * x.task_alignment_score +
    w.w_novelty * x.novelty_score +
    w.w_dead_end * x.dead_end_penalty +
    w.bias
  );
}

/** ε-greedy exploration probability — high early, decays as we accumulate updates. */
export function explorationEpsilon(updatesCount: number): number {
  return Math.max(0.05, 0.3 / Math.sqrt(1 + Math.max(0, updatesCount) / 20));
}

/**
 * Single SGD step toward priors.
 *   z      = w · x + bias
 *   p      = sigmoid(z)
 *   η_eff  = base_lr / sqrt(1 + updates_count / 50)
 *   grad   = (p - y) * sample_weight
 *   w     ← w - η_eff * (grad * x + λ * (w - prior))
 *   bias  ← bias - η_eff * grad
 *
 * Pure function — caller persists the result.
 */
export function sgdUpdate(args: {
  weights: RecommenderWeights;
  features: RecommenderFeatures;
  label: 0 | 1;
  sampleWeight: number;
  updatesCount: number;
}): RecommenderWeights {
  const { weights: w, features: x, label: y } = args;
  const sw = args.sampleWeight > 0 ? args.sampleWeight : 1;
  const eta = BASE_LR / Math.sqrt(1 + Math.max(0, args.updatesCount) / 50);
  const z = scoreFeatures(x, w);
  const p = sigmoid(z);
  const grad = (p - y) * sw;
  const step = (wi: number, xi: number, prior: number): number =>
    clip(wi - eta * (grad * xi + L2_LAMBDA * (wi - prior)));
  return {
    w_task: step(w.w_task, x.task_fit, RECOMMENDER_PRIORS.w_task),
    w_freq: step(w.w_freq, x.freq_penalty, RECOMMENDER_PRIORS.w_freq),
    w_accept: step(w.w_accept, x.accept_signal, RECOMMENDER_PRIORS.w_accept),
    w_reject: step(w.w_reject, x.reject_signal, RECOMMENDER_PRIORS.w_reject),
    w_page: step(w.w_page, x.page_relevance, RECOMMENDER_PRIORS.w_page),
    w_same_host: step(w.w_same_host, x.same_host, RECOMMENDER_PRIORS.w_same_host),
    w_trusted_seed: step(w.w_trusted_seed, x.is_trusted_seed, RECOMMENDER_PRIORS.w_trusted_seed),
    w_task_alignment: step(w.w_task_alignment, x.task_alignment_score, RECOMMENDER_PRIORS.w_task_alignment),
    w_novelty: step(w.w_novelty, x.novelty_score, RECOMMENDER_PRIORS.w_novelty),
    w_dead_end: step(w.w_dead_end, x.dead_end_penalty, RECOMMENDER_PRIORS.w_dead_end),
    bias: clip(w.bias - eta * (grad + L2_LAMBDA * (w.bias - RECOMMENDER_PRIORS.bias))),
  };
}

/** Persist a single SGD step. Cold-start inserts a new row. */
export async function applyWeightUpdate(args: {
  admin: SupabaseClient;
  userId: string;
  features: RecommenderFeatures;
  label: 0 | 1;
  sampleWeight?: number;
}): Promise<void> {
  try {
    const cur = await getUserRecommenderWeights({ admin: args.admin, userId: args.userId });
    const next = sgdUpdate({
      weights: cur.weights,
      features: args.features,
      label: args.label,
      sampleWeight: args.sampleWeight ?? 1,
      updatesCount: cur.updates_count,
    });
    const nextCount = cur.updates_count + 1;
    await args.admin
      .schema("deal_intel")
      .from("copilot_recommender_weights")
      .upsert(
        {
          user_id: args.userId,
          weights: next as unknown as Record<string, number>,
          updates_count: nextCount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
  } catch {
    // Learning is best-effort — never fail user-facing routes for it.
  }
}

// ---------- Ranking-event logging + attribution ----------

export type RankingEventInsert = {
  session_id: string;
  user_id: string;
  candidate_url: string;
  candidate_host: string;
  features: RecommenderFeatures;
  chosen: boolean;
};

/** Insert top-K ranking events for a single plan-next tick. Best-effort. */
export async function logRankingEvents(args: {
  admin: SupabaseClient;
  events: RankingEventInsert[];
}): Promise<void> {
  if (!args.events.length) return;
  try {
    await args.admin
      .schema("deal_intel")
      .from("copilot_ranking_event")
      .insert(
        args.events.map((e) => ({
          session_id: e.session_id,
          user_id: e.user_id,
          candidate_url: e.candidate_url,
          candidate_host: e.candidate_host,
          features: e.features as unknown as Record<string, number>,
          chosen: e.chosen,
        })),
      );
  } catch {
    // Best-effort.
  }
}

export type LabelKind =
  | "accept_suggestion"
  | "accept_draft"
  | "reject_suggestion"
  | "skip_host"
  | "paywall"
  | "implicit_engaged"
  | "implicit_bounce";

/**
 * Attribute one or more recent unlabeled ranking events for a host to a label.
 * Returns the labeled rows so the caller can run SGD updates with the stored features.
 *
 * Window defaults to 30 minutes (matches the user's typical attention span on
 * a navigated page).
 */
export async function attributeRankingEvents(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  candidateHost: string;
  label: 0 | 1;
  labelKind: LabelKind;
  sampleWeight?: number;
  /** Match candidate_url exactly when given (preferred); falls back to host match. */
  candidateUrl?: string;
  windowMinutes?: number;
  /** When true, label all unlabeled events for the host in this session (used by skip-host). */
  bulk?: boolean;
}): Promise<RecommenderFeatures[]> {
  const sw = args.sampleWeight ?? 1;
  const windowMs = (args.windowMinutes ?? 30) * 60_000;
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();
  const labeled: RecommenderFeatures[] = [];
  try {
    let query = args.admin
      .schema("deal_intel")
      .from("copilot_ranking_event")
      .select("id, features")
      .eq("session_id", args.sessionId)
      .is("label", null)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false });
    if (args.candidateUrl) {
      query = query.eq("candidate_url", args.candidateUrl);
    } else {
      query = query.eq("candidate_host", args.candidateHost);
    }
    if (!args.bulk) query = query.limit(1);
    const res = await query;
    if (res.error || !Array.isArray(res.data) || res.data.length === 0) return labeled;
    const ids: number[] = [];
    for (const row of res.data as Array<{ id: number; features: unknown }>) {
      ids.push(row.id);
      labeled.push(parseFeatures(row.features));
    }
    await args.admin
      .schema("deal_intel")
      .from("copilot_ranking_event")
      .update({
        label: args.label,
        label_kind: args.labelKind,
        sample_weight: sw,
        labeled_at: new Date().toISOString(),
      })
      .in("id", ids);
  } catch {
    // ignore
  }
  return labeled;
}

function parseFeatures(raw: unknown): RecommenderFeatures {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (k: keyof RecommenderFeatures): number => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    task_fit: num("task_fit"),
    freq_penalty: num("freq_penalty"),
    accept_signal: num("accept_signal"),
    reject_signal: num("reject_signal"),
    page_relevance: num("page_relevance"),
    // New hybrid exploration features (default to 0 for backward compatibility)
    same_host: num("same_host"),
    is_trusted_seed: num("is_trusted_seed"),
    task_alignment_score: num("task_alignment_score"),
    novelty_score: num("novelty_score"),
    dead_end_penalty: num("dead_end_penalty"),
    unexplored_relevant_links: num("unexplored_relevant_links"),
  };
}

/**
 * High-level helper: attribute + run SGD updates in one shot.
 * Used by /decision, /skip-host, /auto-draft, /observe.
 */
export async function recordLabeledOutcome(args: {
  admin: SupabaseClient;
  sessionId: string;
  userId: string;
  candidateHost: string;
  candidateUrl?: string;
  label: 0 | 1;
  labelKind: LabelKind;
  sampleWeight?: number;
  bulk?: boolean;
}): Promise<void> {
  const featuresList = await attributeRankingEvents(args);
  if (!featuresList.length) return;
  for (const features of featuresList) {
    await applyWeightUpdate({
      admin: args.admin,
      userId: args.userId,
      features,
      label: args.label,
      sampleWeight: args.sampleWeight,
    });
  }
}

// ---------- Feature builders ----------

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function tokenOverlap(a: string[], b: ReadonlyArray<string>): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map((t) => t.toLowerCase()));
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits += 1;
  return hits / Math.max(1, Math.min(a.length, b.length));
}

export function clamp(v: number, lo = -1, hi = 1): number {
  if (!Number.isFinite(v)) return 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Build the feature vector for a single candidate.
 *
 * NOTE: the planner module (lib/copilot/plan-next.ts) calls this directly;
 * keeping it here avoids a circular import and keeps the SGD-feature contract
 * in one place so logging and ranking always agree.
 */
export type CandidateFeatureInput = {
  url: string;
  host: string;
  text: string;
  heading?: string;
  hostVisitCount: number;
  isOutboundLink: boolean;
  inViewedSection: boolean;
  // New hybrid exploration inputs
  currentHost: string;
  isTrustedSeed: boolean;
  unexploredRelevantLinks: number;
};

export type FeatureContext = {
  /** Tokens derived from the active task's evidence_need + query_terms + target_gap_fields. */
  taskTokens: string[];
  /** Source kinds the active task is willing to accept (matched via host/url/text substrings). */
  taskSourceKinds: ReadonlyArray<string>;
  /** Average visits-per-host the user historically tolerates (for normalization). */
  avgVisitsPerHost: number;
  /** Hosts where the user has previously accepted a snippet/draft (boost). */
  acceptedHosts: ReadonlySet<string>;
  /** Hosts the user has rejected from. */
  rejectedHosts: ReadonlySet<string>;
  /** Hard-blocked / paywalled hosts — used only for downstream filtering, not features. */
  blockedHosts: ReadonlySet<string>;
  // New hybrid exploration context
  currentHost: string;
  taskEvidenceNeed: string;
  informationGainHistory: Map<string, { claims: number; facts: number; entities: number; timestamp: string }>;
  failedPaths: Set<string>;
};

export function buildCandidateFeatures(c: CandidateFeatureInput, ctx: FeatureContext): RecommenderFeatures {
  // task_fit: token overlap against task tokens, plus a flat boost when host/url
  // matches one of the task's source-kind buckets.
  const candTokens = tokens(`${c.text} ${c.heading ?? ""} ${c.host} ${c.url}`);
  let taskFit = tokenOverlap(candTokens, ctx.taskTokens);
  if (sourceKindMatches(c, ctx.taskSourceKinds)) taskFit += 0.4;
  taskFit = clamp(taskFit, 0, 1);

  // freq_penalty: how much the user has already burned on this host this session.
  const tolerated = Math.max(3, ctx.avgVisitsPerHost || 0);
  const freqPenalty = -clamp(c.hostVisitCount / tolerated, 0, 1);

  // accept_signal: previously yielded host gets a boost.
  const acceptSignal = ctx.acceptedHosts.has(c.host) ? 1 : 0;

  // reject_signal: previously rejected host gets a strong negative.
  const rejectSignal = ctx.rejectedHosts.has(c.host) ? -1 : 0;

  // page_relevance: only meaningful for outbound links (not trusted seeds).
  let pageRelevance = 0;
  if (c.isOutboundLink) {
    pageRelevance = clamp(tokenOverlap(candTokens, ctx.taskTokens), 0, 1);
    if (c.inViewedSection) pageRelevance += 0.2;
    pageRelevance = clamp(pageRelevance, 0, 1);
  }

  // same_host: boost candidates from the current page
  const sameHost = c.host === c.currentHost ? 1 : 0;

  // is_trusted_seed: penalize generic aggregators
  const isTrustedSeed = c.isTrustedSeed ? 1 : 0;

  // task_alignment_score: how well candidate matches active task evidence_need
  const evidenceTokens = tokens(ctx.taskEvidenceNeed);
  const taskAlignmentScore = clamp(tokenOverlap(candTokens, evidenceTokens), 0, 1);

  // novelty_score: how much new information this host provides (from history)
  const gainHistory = ctx.informationGainHistory.get(c.host);
  let noveltyScore = 0.5; // Default for unknown hosts
  if (gainHistory) {
    const totalGain = gainHistory.claims + gainHistory.facts + gainHistory.entities;
    noveltyScore = Math.min(1, totalGain / 10); // Normalize to 0-1 range
  }

  // dead_end_penalty: penalty for previously failed paths
  const deadEndPenalty = ctx.failedPaths.has(c.host) ? -1 : 0;

  // unexplored_relevant_links: count of unvisited relevant links on current page
  const unexploredRelevantLinks = c.unexploredRelevantLinks;

  return {
    task_fit: taskFit,
    freq_penalty: freqPenalty,
    accept_signal: acceptSignal,
    reject_signal: rejectSignal,
    page_relevance: pageRelevance,
    same_host: sameHost,
    is_trusted_seed: isTrustedSeed,
    task_alignment_score: taskAlignmentScore,
    novelty_score: noveltyScore,
    dead_end_penalty: deadEndPenalty,
    unexplored_relevant_links: unexploredRelevantLinks,
  };
}

function sourceKindMatches(c: CandidateFeatureInput, kinds: ReadonlyArray<string>): boolean {
  if (!kinds.length) return false;
  const blob = `${c.text} ${c.url} ${c.host} ${c.heading ?? ""}`.toLowerCase();
  for (const kind of kinds) {
    const k = kind.replace(/_/g, " ");
    if (kind === "company_site" && /about|team|product|pricing|customers|case|blog|docs/.test(blob)) return true;
    if (kind === "database" && /crunchbase|pitchbook|wellfound|database|profile/.test(blob)) return true;
    if (kind === "news" && /news|reuters|bloomberg|techcrunch|article|press|media/.test(blob)) return true;
    if (kind === "filings" && /sec\.gov|filing|edgar|10-k|s-1/.test(blob)) return true;
    if (kind === "social" && /twitter|x\.com|linkedin|reddit|hackernews/.test(blob)) return true;
    if (kind === "reference" && /wikipedia|britannica|wiki/.test(blob)) return true;
    if (blob.includes(kind) || blob.includes(k)) return true;
  }
  return false;
}
