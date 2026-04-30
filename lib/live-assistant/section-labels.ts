import type { ClassifiedClaim, ClaimSection } from "@/lib/live-assistant/claim-classifier";

/** Multi-label section tags for meeting_claim.section_labels (lightweight, no extra LLM). */
export function multiLabelSectionsForClaim(c: ClassifiedClaim): string[] {
  const labels = new Set<string>([c.section]);
  const add = (s: ClaimSection) => labels.add(s);

  const text = `${c.text}`.toLowerCase();
  if (/\b(problem|pain|challenge|workflow|legacy)\b/.test(text)) add("problem");
  if (/\b(solution|product|platform|api|feature|build)\b/.test(text)) add("solution");
  if (/\b(traction|revenue|arr|mrr|growth|customer|logo|churn|retention)\b/.test(text) || /\d/.test(text)) add("traction");
  if (/\b(risk|regulatory|dependency|concentration|key person|single)\b/.test(text)) add("risks");

  if (c.section === "market" || c.section === "competition") add("problem");
  if (c.section === "financials") add("traction");
  if (c.section === "gtm") add("solution");

  return [...labels];
}
