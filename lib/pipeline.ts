import {
  runWithPdf,
  runWithText,
} from "@/lib/gemini";
import {
  PROMPT_PARSING,
  PROMPT_PROBLEM_PDF,
  PROMPT_SOLUTION_PDF,
  PROMPT_PROBLEM_WEB,
  PROMPT_SOLUTION_WEB,
  PROMPT_FOUNDER_TEAM_WEB,
  PROMPT_METRICS_WEB,
} from "@/lib/pitch-prompts";

export interface PipelineResult {
  parsing_json: unknown;
  problem_extraction_json: unknown;
  solution_extraction_json: unknown;
  problem_quality_score: number;
  solution_quality_score: number;
  founder_team_quality_score: number;
  metrics_quality_score: number;
  composite_score: number;
  problem_web_json: unknown;
  solution_web_json: unknown;
  founder_web_json: unknown;
  metrics_web_json: unknown;
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  return 0;
}

/**
 * Run the full 7-step pitch deck pipeline. PDF is sent directly to Gemini (no text extraction).
 */
export async function runPitchDeckPipeline(pdfBuffer: Buffer): Promise<PipelineResult> {
  // Steps 1–3: PDF → extraction (Flash Lite)
  const [parsing_json, problem_extraction_json, solution_extraction_json] = await Promise.all([
    runWithPdf(PROMPT_PARSING, pdfBuffer, "flash_lite"),
    runWithPdf(PROMPT_PROBLEM_PDF, pdfBuffer, "flash_lite"),
    runWithPdf(PROMPT_SOLUTION_PDF, pdfBuffer, "flash_lite"),
  ]);

  // Steps 4–5: JSON + web (heavy model)
  const [problem_web_json, solution_web_json] = await Promise.all([
    runWithText(PROMPT_PROBLEM_WEB, problem_extraction_json, "heavy"),
    runWithText(PROMPT_SOLUTION_WEB, solution_extraction_json, "heavy"),
  ]);

  // Steps 6–7: parsing_json + web (Flash Lite)
  const [founder_web_json, metrics_web_json] = await Promise.all([
    runWithText(PROMPT_FOUNDER_TEAM_WEB, parsing_json, "flash_lite"),
    runWithText(PROMPT_METRICS_WEB, parsing_json, "flash_lite"),
  ]);

  const problem_quality_score = toNumber((problem_web_json as Record<string, unknown>)?.problem_quality_score);
  const solution_quality_score = toNumber((solution_web_json as Record<string, unknown>)?.solution_quality_score);
  const founder_team_quality_score = toNumber((founder_web_json as Record<string, unknown>)?.founder_team_quality_score);
  const metrics_quality_score = toNumber((metrics_web_json as Record<string, unknown>)?.metrics_quality_score);

  const composite_score =
    (problem_quality_score + solution_quality_score + founder_team_quality_score + metrics_quality_score) / 4;

  return {
    parsing_json,
    problem_extraction_json,
    solution_extraction_json,
    problem_quality_score,
    solution_quality_score,
    founder_team_quality_score,
    metrics_quality_score,
    composite_score,
    problem_web_json,
    solution_web_json,
    founder_web_json,
    metrics_web_json,
  };
}
