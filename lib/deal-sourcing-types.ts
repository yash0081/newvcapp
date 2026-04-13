/**
 * Shared types + UI metadata for the deal sourcing pipeline (safe for client import).
 */

/** Optional corpus-comparison block returned by thesis / 3C / 3D agents when similar peers exist. */
export type UserCorpusContextPayload = {
  summary?: string | null;
  peer_pattern_notes?: string[];
} | null;

/** Phase 4 optional block when peers inform risk patterns. */
export type UserCorpusRiskContextPayload = UserCorpusContextPayload;

export type DealSourcingPipelineStep =
  | "parse"
  | "thesis"
  | "traction"
  | "problem"
  | "solution"
  | "founder"
  | "assumptions_questions"
  | "summaries";

export const PIPELINE_STEP_META: {
  id: DealSourcingPipelineStep;
  label: string;
  description: string;
}[] = [
  { id: "parse", label: "Parse deck", description: "Extract structured data from the PDF" },
  { id: "thesis", label: "Thesis fit", description: "Score alignment with your fund thesis" },
  { id: "traction", label: "Traction", description: "Evidence and growth signals" },
  { id: "problem", label: "Problem quality", description: "Pain, buyer, and market depth" },
  { id: "solution", label: "Solution & defensibility", description: "Moat and differentiation" },
  { id: "founder", label: "Founder signals", description: "Team and founder-market fit" },
  {
    id: "assumptions_questions",
    label: "Assumptions & risk",
    description: "Strategic assumptions and interrogation",
  },
  { id: "summaries", label: "Summaries & questions", description: "Section previews and generated questions" },
];
