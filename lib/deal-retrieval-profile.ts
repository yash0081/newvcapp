import type { SupabaseClient } from "@supabase/supabase-js";
import { runWithTextMulti } from "@/lib/gemini";
import { PROMPT_RETRIEVAL_KEYWORDS_PS, V2_MAX_ARRAY_ITEMS } from "@/lib/deal-sourcing-prompts";
import { embedText } from "@/lib/vertex-embeddings";

export type RetrievalSectionProfile = {
  search_concepts: string[];
  /** Fixed-length prose window used for embedding fusion (stored for debug / FTS). */
  normalized_slice: string;
};

/** Problem + solution keyword slices; market is deterministic text only (no LLM profiler). */
export type DealRetrievalProfile = {
  problem: RetrievalSectionProfile;
  solution: RetrievalSectionProfile;
  market_document: string;
};

export type DealRetrievalEmbeddings = {
  problem: number[];
  solution: number[];
  market: number[];
};

const PROSE_WORDS = 64;
const W_PROSE = 0.55;
const W_KW = 0.45;

function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n <= 1e-12) return v;
  return v.map((x) => x / n);
}

function addWeighted(a: number[], wa: number, b: number[], wb: number): number[] {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = wa * a[i] + wb * b[i];
  }
  return l2Normalize(out);
}

function averageVectors(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const dim = vecs[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  const n = vecs.length;
  return l2Normalize(acc.map((x) => x / n));
}

function takeWords(s: string, maxWords: number): string {
  const w = s.trim().split(/\s+/).filter(Boolean);
  return w.slice(0, maxWords).join(" ");
}

function joinProblemProse(parsing: Record<string, unknown>): string {
  const prob = (parsing.problem ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const ps = typeof prob.problem_statement === "string" ? prob.problem_statement.trim() : "";
  const tc = typeof prob.target_customer === "string" ? prob.target_customer.trim() : "";
  if (ps) parts.push(ps);
  if (tc) parts.push(`buyer: ${tc}`);
  const pp = Array.isArray(prob.pain_points) ? prob.pain_points : [];
  for (const p of pp.slice(0, V2_MAX_ARRAY_ITEMS)) {
    if (typeof p === "string" && p.trim()) parts.push(p.trim());
  }
  const raw = parts.join(" | ");
  return takeWords(raw, PROSE_WORDS);
}

function joinSolutionProse(parsing: Record<string, unknown>): string {
  const sol = (parsing.solution ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const ss = typeof sol.solution_summary === "string" ? sol.solution_summary.trim() : "";
  const pt = typeof sol.product_type === "string" ? sol.product_type.trim() : "";
  if (ss) parts.push(ss);
  if (pt) parts.push(`product: ${pt}`);
  for (const key of ["core_features", "claimed_differentiation", "claimed_defensibility"] as const) {
    const arr = Array.isArray(sol[key]) ? sol[key] : [];
    for (const x of arr as unknown[]) {
      if (typeof x === "string" && x.trim()) parts.push(x.trim());
    }
  }
  const raw = parts.join(" | ");
  return takeWords(raw, PROSE_WORDS);
}

export function buildMarketDocumentFromParsing(parsing: Record<string, unknown>): string {
  const m = (parsing.market ?? {}) as Record<string, unknown>;
  const co = (parsing.company_overview ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const sector = typeof co.sector_category === "string" ? co.sector_category.trim() : "";
  if (sector) parts.push(`sector: ${sector}`);
  for (const k of ["tam_claim", "sam_claim", "som_claim"] as const) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) parts.push(`${k.replace("_", " ")}: ${v.trim()}`);
  }
  const growth = Array.isArray(m.market_growth_claims) ? m.market_growth_claims : [];
  for (const g of growth) {
    if (typeof g === "string" && g.trim()) parts.push(g.trim());
  }
  const raw = parts.join(" | ").toLowerCase();
  return raw.trim().slice(0, 8000) || "unknown market";
}

function flattenKeywordRecord(
  rec: Record<string, unknown> | undefined,
  out: string[]
): void {
  if (!rec) return;
  for (const v of Object.values(rec)) {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x.trim()) out.push(x.trim().toLowerCase());
      }
    }
  }
}

function toSectionProfile(
  rawSection: unknown,
  proseFallback: string
): RetrievalSectionProfile {
  const rec = (rawSection ?? {}) as Record<string, unknown>;
  const concepts: string[] = [];
  flattenKeywordRecord(rec, concepts);
  const uniq = Array.from(new Set(concepts)).slice(0, 40);
  return {
    search_concepts: uniq,
    normalized_slice: proseFallback || "unknown",
  };
}

export async function buildRetrievalProfileFromParsing(
  parsing: Record<string, unknown>
): Promise<DealRetrievalProfile> {
  const raw = (await runWithTextMulti(
    PROMPT_RETRIEVAL_KEYWORDS_PS,
    [{ label: "phase1_parsing_json", value: parsing }],
    "flash_lite",
    false
  )) as Record<string, unknown>;

  const problemProse = joinProblemProse(parsing);
  const solutionProse = joinSolutionProse(parsing);

  const problem = toSectionProfile(raw.problem, problemProse);
  const solution = toSectionProfile(raw.solution, solutionProse);
  const market_document = buildMarketDocumentFromParsing(parsing);

  return {
    problem,
    solution,
    market_document,
  };
}

async function embedSectionFused(prose: string, phrases: string[]): Promise<number[]> {
  const proseVec = await embedText(prose || "unknown");
  const clean = phrases.filter((p) => p.length > 0).slice(0, 24);
  if (clean.length === 0) return proseVec;
  const kwVecs = await Promise.all(clean.map((p) => embedText(p)));
  const kwAvg = averageVectors(kwVecs);
  return addWeighted(proseVec, W_PROSE, kwAvg, W_KW);
}

export async function embedRetrievalProfile(profile: DealRetrievalProfile): Promise<DealRetrievalEmbeddings> {
  const [problem, solution, market] = await Promise.all([
    embedSectionFused(profile.problem.normalized_slice, profile.problem.search_concepts),
    embedSectionFused(profile.solution.normalized_slice, profile.solution.search_concepts),
    embedText(profile.market_document),
  ]);
  return { problem, solution, market };
}

export async function upsertDealRetrievalArtifacts(args: {
  admin: SupabaseClient;
  dealId: string;
  analysisId: string;
  profile: DealRetrievalProfile;
  embeddings: DealRetrievalEmbeddings;
}): Promise<void> {
  const { admin, dealId, analysisId, profile, embeddings } = args;

  const normalizedJson = {
    problem: profile.problem.normalized_slice,
    solution: profile.solution.normalized_slice,
    market: profile.market_document,
  };
  const conceptsJson = {
    problem: profile.problem.search_concepts,
    solution: profile.solution.search_concepts,
  };

  const { error: idxErr } = await admin.from("deal_retrieval_index").upsert(
    {
      deal_id: dealId,
      analysis_id: analysisId,
      problem_normalized: profile.problem.normalized_slice,
      solution_normalized: profile.solution.normalized_slice,
      market_normalized: profile.market_document,
      risk_normalized: null,
      concepts_json: conceptsJson,
      normalized_json: normalizedJson,
      problem_embedding: vectorParam(embeddings.problem),
      solution_embedding: vectorParam(embeddings.solution),
      market_embedding: vectorParam(embeddings.market),
      risk_embedding: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "deal_id" }
  );
  if (idxErr) {
    console.error("upsertDealRetrievalArtifacts: deal_retrieval_index", idxErr);
  }

  await admin.from("deal_keywords").delete().eq("deal_id", dealId).in("section_name", ["market", "risk"]);

  for (const section of ["problem", "solution"] as const) {
    const concepts = profile[section].search_concepts;
    const { error: kwErr } = await admin.from("deal_keywords").upsert(
      {
        deal_id: dealId,
        analysis_id: analysisId,
        section_name: section,
        concepts,
      },
      { onConflict: "deal_id,section_name" }
    );
    if (kwErr) {
      console.error(`upsertDealRetrievalArtifacts: deal_keywords(${section})`, kwErr);
    }
  }
}
