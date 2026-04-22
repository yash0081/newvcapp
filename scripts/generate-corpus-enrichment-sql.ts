/**
 * Generates supabase/corpus-markdown-pipeline-enrichment.sql from Invested Companies_.md
 * for the fixed seed deal/analysis UUIDs. Run: npx tsx scripts/generate-corpus-enrichment-sql.ts
 *
 * Then run the SQL in Supabase (postgres), and:
 *   npx tsx scripts/backfill-deal-context-nodes.ts --index-deals --force
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  mergeMarkdownProfileWithSyntheticPipeline,
  syntheticResultFromMarkdownCompanyProfile,
  type MarkdownCorpusSynthContext,
} from "../lib/reconstruct-deal-sourcing-result";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const ID_SUFFIXES = [
  "000000000001",
  "000000000002",
  "000000000003",
  "000000000004",
  "000000000005",
  "000000000006",
  "000000000007",
  "000000000008",
  "000000000009",
  "00000000000a",
];

function dealId(i: number) {
  return `1a000000-0000-4000-8000-${ID_SUFFIXES[i]}`;
}
function analysisId(i: number) {
  return `1b000000-0000-4000-8000-${ID_SUFFIXES[i]}`;
}

function normalizeMarkdownJson(line: string) {
  let s = line;
  s = s.replace(/\\_/g, "_");
  s = s.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  s = s.replace(/\\\)/g, ")").replace(/\\\(/g, "(");
  s = s.replace(/\\-/g, "-");
  s = s.replace(/\\&/g, "&");
  s = s.replace(/\\\\"/g, '\\"');
  return s;
}

function parseJsonLine(line: string) {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  return JSON.parse(normalizeMarkdownJson(t)) as Record<string, unknown>;
}

function splitSections(md: string) {
  const acceptedMarker = "Info and Reasoning abt each company (Accepted):";
  const passedMarker = "Passed Companies (Rejection):";
  const iAccepted = md.indexOf(acceptedMarker);
  const iPassed = md.indexOf(passedMarker);
  return {
    acceptedBlock: md.slice(iAccepted + acceptedMarker.length, iPassed),
    passedBlock: md.slice(iPassed + passedMarker.length),
  };
}

function extractLines(sectionText: string) {
  const out: Record<string, unknown>[] = [];
  for (const line of sectionText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const p = parseJsonLine(t);
    if (p) out.push(p);
  }
  return out;
}

function dollarQuoteJson(obj: unknown): string {
  const s = JSON.stringify(obj);
  let tag = "j";
  while (s.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${s}$${tag}$`;
}

function sqlString(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

const mdPath = join(root, "Invested Companies_.md");
const outPath = join(root, "supabase", "corpus-markdown-pipeline-enrichment.sql");

const md = readFileSync(mdPath, "utf8");
const { acceptedBlock, passedBlock } = splitSections(md);
const invested = extractLines(acceptedBlock);
const passed = extractLines(passedBlock);
const all = [
  ...invested.map((o) => ({ ...o, _decision: "invested" as const })),
  ...passed.map((o) => ({ ...o, _decision: "passed" as const })),
];

if (all.length !== ID_SUFFIXES.length) {
  throw new Error(`Expected ${ID_SUFFIXES.length} companies, got ${all.length}`);
}

const analysisIds = ID_SUFFIXES.map((_, i) => analysisId(i)).map((id) => `'${id}'::uuid`).join(", ");

let sql = `-- Enrichment for markdown corpus (Invested Companies_.md seed UUIDs).
-- Updates deal_pipeline_json_* AND deal_analyses.raw_output (UI reads raw_output for thesis / founder / traction).
-- Run in Supabase SQL editor as postgres. Then from repo root:
--   npx tsx scripts/backfill-deal-context-nodes.ts --index-deals --force

BEGIN;

DELETE FROM public.deal_questions WHERE analysis_id IN (${analysisIds});
DELETE FROM public.deal_scores WHERE analysis_id IN (${analysisIds});

`;

for (let i = 0; i < all.length; i++) {
  const row = all[i] as Record<string, unknown> & { _decision: string };
  const { _decision, ...profile } = row;
  const did = dealId(i);
  const aid = analysisId(i);
  const ctx: MarkdownCorpusSynthContext = {
    decision: _decision === "invested" ? "invested" : "passed",
  };
  const synth = syntheticResultFromMarkdownCompanyProfile(profile, ctx);
  if (!synth) continue;

  const mergedRaw = mergeMarkdownProfileWithSyntheticPipeline(profile as Record<string, unknown>, synth);
  sql += `UPDATE public.deal_analyses SET raw_output = ${dollarQuoteJson(mergedRaw)}::jsonb WHERE id = '${aid}'::uuid;\n\n`;

  const investedBool = _decision === "invested";
  const base = investedBool ? 7.2 : 4.0;
  const dims = ["thesis_fit", "founder", "traction", "problem", "solution"] as const;
  for (let di = 0; di < dims.length; di++) {
    const dim = dims[di];
    const raw = Math.min(10, Math.max(0, base + (di - 2) * (investedBool ? 0.35 : -0.25)));
    sql += `INSERT INTO public.deal_scores (deal_id, analysis_id, dimension, raw_score, weighted_score, rubric_weight, scoring_stage)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${sqlString(dim)}, ${raw.toFixed(2)}, ${raw.toFixed(2)}, 1, 'corpus_markdown_inferred');\n`;
  }

  sql += `
INSERT INTO public.deal_pipeline_json_thesis_fit (deal_id, analysis_id, thesis_fit_json)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${dollarQuoteJson(synth.thesis_fit_json)}::jsonb)
ON CONFLICT (analysis_id) DO UPDATE SET thesis_fit_json = EXCLUDED.thesis_fit_json;

INSERT INTO public.deal_pipeline_json_founder_signals (deal_id, analysis_id, founder_signal_json)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${dollarQuoteJson(synth.founder_signal_json)}::jsonb)
ON CONFLICT (analysis_id) DO UPDATE SET founder_signal_json = EXCLUDED.founder_signal_json;

INSERT INTO public.deal_pipeline_json_traction_signals (deal_id, analysis_id, traction_signal_json)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${dollarQuoteJson(synth.traction_signal_json)}::jsonb)
ON CONFLICT (analysis_id) DO UPDATE SET traction_signal_json = EXCLUDED.traction_signal_json;

INSERT INTO public.deal_pipeline_json_problem_3c (deal_id, analysis_id, problem_quality_3c_json)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${dollarQuoteJson(synth.problem_quality_3c_json)}::jsonb)
ON CONFLICT (analysis_id) DO UPDATE SET problem_quality_3c_json = EXCLUDED.problem_quality_3c_json;

INSERT INTO public.deal_pipeline_json_solution_3d (deal_id, analysis_id, solution_defensibility_json)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${dollarQuoteJson(synth.solution_defensibility_json)}::jsonb)
ON CONFLICT (analysis_id) DO UPDATE SET solution_defensibility_json = EXCLUDED.solution_defensibility_json;

`;

  const qCombined = {
    questions_first_order_json: synth.questions_first_order_json,
    questions_structural_json: synth.questions_structural_json,
  };
  sql += `INSERT INTO public.deal_pipeline_json_questions_combined (deal_id, analysis_id, questions_combined_json)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${dollarQuoteJson(qCombined)}::jsonb)
ON CONFLICT (analysis_id) DO UPDATE SET questions_combined_json = EXCLUDED.questions_combined_json;

`;

  const cn = typeof profile.company_name === "string" ? profile.company_name : "Company";
  const qt = [
    `What single customer proof would most validate ${cn}'s core wedge?`,
    `How does ${cn} win vs the default incumbent workflow in the next 12 months?`,
    `What metric best predicts retention or expansion for ${cn}?`,
    `If capital markets tighten, what is ${cn}'s path to default-alive?`,
  ];
  for (const q of qt) {
    sql += `INSERT INTO public.deal_questions (deal_id, analysis_id, question_text, question_type, source_signal)
VALUES ('${did}'::uuid, '${aid}'::uuid, ${sqlString(q)}, 'corpus_synthetic', 'markdown_corpus_enrichment');\n`;
  }
}

sql += `
COMMIT;
`;

writeFileSync(outPath, sql, "utf8");
console.log(`Wrote ${outPath}`);
