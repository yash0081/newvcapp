import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealSourcingResult } from "@/lib/deal-sourcing-pipeline";
import { embedText } from "@/lib/vertex-embeddings";
import { registerKeywordPhrases } from "@/lib/keyword-vocabulary-graph";

function toRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two", "who", "way", "use", "that", "this", "with", "from", "they", "have", "been", "were", "said", "each", "which", "their", "time", "will", "about", "into", "than", "then", "them", "these", "some", "what", "when", "your", "more", "also", "such", "only", "other", "over", "most", "much", "very", "after", "being", "both", "those", "under", "while", "where", "would", "could", "should",
]);

export function extractKeywords(text: string, max = 40): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return Array.from(new Set(words)).slice(0, max);
}

function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

type NodeInsert = {
  deal_id: string;
  analysis_id: string;
  parent_id: string | null;
  node_type: string;
  depth: number;
  raw_text: string | null;
  structured_text: string | null;
  keywords: string[];
  embedding: string | null;
  node_weight: number;
  polarity: "positive" | "negative" | "neutral";
  subnode_weights_json: Record<string, number> | null;
};

/**
 * Build hierarchical deal_context_nodes + register keywords in global vocabulary.
 * Called after normalized pipeline tables are written for this analysis.
 */
export async function materializeDealContextFromPipeline(
  admin: SupabaseClient,
  dealId: string,
  analysisId: string,
  result: DealSourcingResult
): Promise<void> {
  await admin.from("deal_context_nodes").delete().eq("deal_id", dealId).eq("analysis_id", analysisId);

  const parsing = toRecord(result.parsing_json);
  const companyOverview = toRecord(parsing.company_overview);
  const problem = toRecord(parsing.problem);
  const solution = toRecord(parsing.solution);
  const problem3c = toRecord(result.problem_quality_3c_json);
  const solution3d = toRecord(result.solution_defensibility_json);
  const traction = toRecord(result.traction_signal_json);
  const thesisFit = toRecord(result.thesis_fit_json);
  const founder = toRecord(result.founder_signal_json);
  const coreAssumption = toRecord(result.core_assumption_json);
  const linchpin = toRecord(coreAssumption.the_linchpin_assumption);
  const riskDyn = toRecord(coreAssumption.risk_dynamics);

  const companyName =
    typeof companyOverview.company_name === "string" ? companyOverview.company_name : "Company";

  const problemStatement =
    typeof problem.problem_statement === "string" ? problem.problem_statement : "";
  const solutionSummary =
    typeof solution.solution_summary === "string"
      ? solution.solution_summary
      : typeof solution3d.summary_text === "string"
        ? solution3d.summary_text
        : "";

  const structuredProblem = [
    problem3c.root_cause_depth,
    problem3c.economic_gravity,
    problem3c.structural_urgency,
    problem3c.persona_clarity,
  ]
    .filter((x) => typeof x === "string")
    .join("\n");

  const structuredSolution = [
    solution3d.moat_type,
    solution3d.replication_difficulty,
    solution3d.compounding_potential,
  ]
    .filter((x) => typeof x === "string")
    .join("\n");

  const tractionText = [
    traction.inferred_context && typeof traction.inferred_context === "object"
      ? JSON.stringify(traction.inferred_context)
      : null,
    typeof traction.signal_completeness === "string" ? traction.signal_completeness : null,
  ]
    .filter(Boolean)
    .join("\n");

  const thesisText =
    typeof thesisFit.fit_summary === "string"
      ? thesisFit.fit_summary
      : typeof thesisFit.summary === "string"
        ? thesisFit.summary
        : JSON.stringify(thesisFit).slice(0, 4000);

  const teamText =
    typeof founder.collective === "object" && founder.collective !== null
      ? JSON.stringify(founder.collective).slice(0, 6000)
      : "";

  const nodesToInsert: Omit<NodeInsert, "parent_id" | "embedding">[] = [
    {
      deal_id: dealId,
      analysis_id: analysisId,
      node_type: "root",
      depth: 0,
      raw_text: `${companyName}. ${problemStatement.slice(0, 1500)} ${solutionSummary.slice(0, 1500)}`.trim(),
      structured_text: null,
      keywords: extractKeywords(`${companyName} ${problemStatement} ${solutionSummary}`),
      node_weight: 1,
      polarity: "neutral",
      subnode_weights_json: null,
    },
    {
      deal_id: dealId,
      analysis_id: analysisId,
      node_type: "problem",
      depth: 1,
      raw_text: problemStatement || null,
      structured_text: structuredProblem || null,
      keywords: extractKeywords(`${problemStatement} ${structuredProblem}`),
      node_weight: 1,
      polarity: "neutral",
      subnode_weights_json: null,
    },
    {
      deal_id: dealId,
      analysis_id: analysisId,
      node_type: "solution",
      depth: 1,
      raw_text: solutionSummary || null,
      structured_text: structuredSolution || null,
      keywords: extractKeywords(`${solutionSummary} ${structuredSolution}`),
      node_weight: 1,
      polarity: "neutral",
      subnode_weights_json: null,
    },
    {
      deal_id: dealId,
      analysis_id: analysisId,
      node_type: "traction",
      depth: 1,
      raw_text: tractionText || null,
      structured_text: null,
      keywords: extractKeywords(tractionText),
      node_weight: 1,
      polarity: "neutral",
      subnode_weights_json: null,
    },
    {
      deal_id: dealId,
      analysis_id: analysisId,
      node_type: "thesis_fit",
      depth: 1,
      raw_text: thesisText.slice(0, 8000) || null,
      structured_text: null,
      keywords: extractKeywords(thesisText),
      node_weight: 1,
      polarity: "neutral",
      subnode_weights_json: null,
    },
    {
      deal_id: dealId,
      analysis_id: analysisId,
      node_type: "team",
      depth: 1,
      raw_text: teamText || null,
      structured_text: null,
      keywords: extractKeywords(teamText),
      node_weight: 1,
      polarity: "neutral",
      subnode_weights_json: null,
    },
  ];

  const withEmbeddings: NodeInsert[] = [];
  for (const n of nodesToInsert) {
    const blob = [n.raw_text, n.structured_text].filter(Boolean).join("\n\n").trim();
    let embStr: string | null = null;
    if (blob.length > 20) {
      try {
        const vec = await embedText(blob.slice(0, 8000));
        embStr = vectorParam(vec);
      } catch (e) {
        console.warn("materializeDealContext: embed skip", n.node_type, e);
      }
    }
    withEmbeddings.push({ ...n, parent_id: null, embedding: embStr });
  }

  const { data: inserted, error: insErr } = await admin
    .from("deal_context_nodes")
    .insert(
      withEmbeddings.map(({ parent_id: _p, ...row }) => ({
        ...row,
        parent_id: null,
      }))
    )
    .select("id, node_type");

  if (insErr) {
    console.error("materializeDealContext: insert nodes failed", insErr);
    return;
  }

  const rows = (inserted ?? []) as { id: string; node_type: string }[];
  const rootId = rows.find((r) => r.node_type === "root")?.id;
  if (!rootId) return;

  const childTypes = ["problem", "solution", "traction", "thesis_fit", "team"] as const;
  const updates: { id: string; parent_id: string }[] = [];
  for (const t of childTypes) {
    const id = rows.find((r) => r.node_type === t)?.id;
    if (id) updates.push({ id, parent_id: rootId });
  }
  for (const u of updates) {
    await admin.from("deal_context_nodes").update({ parent_id: u.parent_id }).eq("id", u.id);
  }

  const problemId = rows.find((r) => r.node_type === "problem")?.id;
  const extraKeywords: string[] = [];
  if (problemId) {
    const subParts: { node_type: string; text: string }[] = [];
    const add = (node_type: string, v: unknown) => {
      if (typeof v === "string" && v.trim()) subParts.push({ node_type, text: v.trim() });
    };
    add("problem_sub_root_cause", problem3c.root_cause_depth);
    add("problem_sub_economic_gravity", problem3c.economic_gravity);
    add("problem_sub_structural_urgency", problem3c.structural_urgency);
    add("problem_sub_persona", problem3c.persona_clarity);
    for (const p of subParts) {
      let embStr: string | null = null;
      try {
        embStr = vectorParam(await embedText(p.text.slice(0, 8000)));
      } catch {
        /* skip embed */
      }
      const kws = extractKeywords(p.text);
      extraKeywords.push(...kws);
      await admin.from("deal_context_nodes").insert({
        deal_id: dealId,
        analysis_id: analysisId,
        parent_id: problemId,
        node_type: p.node_type,
        depth: 2,
        raw_text: p.text,
        structured_text: null,
        keywords: kws,
        embedding: embStr,
        node_weight: 1,
        polarity: "neutral",
        subnode_weights_json: null,
      });
    }
  }

  const mdReject =
    typeof (coreAssumption as { markdown_rejection_blob?: string }).markdown_rejection_blob === "string"
      ? (coreAssumption as { markdown_rejection_blob: string }).markdown_rejection_blob.trim()
      : "";
  const negPieces = [
    typeof linchpin.why_it_is_fragile === "string" ? linchpin.why_it_is_fragile : null,
    typeof riskDyn.failure_mode_analysis === "string" ? riskDyn.failure_mode_analysis : null,
    mdReject || null,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  const negText = negPieces.join("\n\n").trim();
  if (negText && rootId) {
    let embStr: string | null = null;
    try {
      embStr = vectorParam(await embedText(negText.slice(0, 8000)));
    } catch {
      /* skip */
    }
    const kws = extractKeywords(negText);
    extraKeywords.push(...kws);
    await admin.from("deal_context_nodes").insert({
      deal_id: dealId,
      analysis_id: analysisId,
      parent_id: rootId,
      node_type: "risk_negative",
      depth: 1,
      raw_text: negText,
      structured_text: null,
      keywords: kws,
      embedding: embStr,
      node_weight: 0.85,
      polarity: "negative",
      subnode_weights_json: null,
    });
  }

  const allKeywords = [...withEmbeddings.flatMap((n) => n.keywords), ...extraKeywords];
  await registerKeywordPhrases(admin, allKeywords);
}
