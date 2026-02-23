/**
 * Aggregate commentary fields from web step JSONs into a single description (paragraphs).
 */

export interface WebJsons {
  problem_web_json: Record<string, unknown> | null;
  solution_web_json: Record<string, unknown> | null;
  founder_web_json: Record<string, unknown> | null;
  metrics_web_json: Record<string, unknown> | null;
}

function getStr(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function aggregateCommentary(web: WebJsons): string {
  const paragraphs: string[] = [];

  const pQuality = getStr(web.problem_web_json, "problem_quality_commentary");
  const pUncertainty = getStr(web.problem_web_json, "uncertainty_commentary");
  if (pQuality) paragraphs.push(pQuality);
  if (pUncertainty) paragraphs.push(pUncertainty);

  const sQuality = getStr(web.solution_web_json, "solution_quality_commentary");
  const sUncertainty = getStr(web.solution_web_json, "uncertainty_commentary");
  if (sQuality) paragraphs.push(sQuality);
  if (sUncertainty) paragraphs.push(sUncertainty);

  const founder = getStr(web.founder_web_json, "founder_team_quality_commentary");
  if (founder) paragraphs.push(founder);

  const metrics = getStr(web.metrics_web_json, "metrics_quality_commentary");
  if (metrics) paragraphs.push(metrics);

  return paragraphs.join("\n\n");
}
