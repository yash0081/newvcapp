import type { AggregatedRulesBySection, InvestmentRuleRow } from "@/lib/investment-rules";
import type { ContextChunk } from "@/lib/retrieval-orchestrator";

function formatRuleRows(rows: InvestmentRuleRow[]): string {
  if (!rows.length) return "";
  return rows
    .map(
      (r) =>
        `- [${r.rule_section}/${r.polarity}] ${r.rule}${r.condition ? ` (when: ${r.condition})` : ""} → ${r.target_score_key}`
    )
    .join("\n");
}

export function formatInvestmentRulesForSystemPrompt(agg: AggregatedRulesBySection | null): string {
  if (!agg) return "";
  const parts = [
    agg.problem.length && `Problem rules:\n${formatRuleRows(agg.problem)}`,
    agg.solution.length && `Solution rules:\n${formatRuleRows(agg.solution)}`,
    agg.founder.length && `Founder rules:\n${formatRuleRows(agg.founder)}`,
  ].filter(Boolean);
  if (!parts.length) return "";
  return `## Fund investment criteria (inferred from your documents)\n${parts.join("\n\n")}`;
}

export function formatRetrievedChunksForPrompt(chunks: ContextChunk[]): string {
  if (!chunks.length) return "";
  const lines = chunks.map(
    (c, i) =>
      `[${i + 1}] deal=${c.deal_id.slice(0, 8)}… type=${c.node_type} polarity=${c.polarity}\n${(c.raw_text ?? "").slice(0, 1200)}`
  );
  return `## Retrieved deal context (ranked)\n${lines.join("\n\n")}`;
}

export function formatFundThesisForPrompt(thesisText: string | null | undefined, maxChars = 4000): string {
  if (!thesisText?.trim()) return "";
  const t = thesisText.trim().slice(0, maxChars);
  return `## Fund thesis (institutional)\n${t}`;
}

export function buildAgenticSystemPrompt(args: {
  taskLabel: string;
  dealName?: string | null;
  rulesBlock: string;
  contextBlock: string;
  /** Fund thesis and other non-rules institutional context (omit for pure tabular filter turns). */
  institutionalBlock?: string;
  /** Shown when not on a single-deal page (e.g. workspace assistant). */
  workspaceHint?: string;
}): string {
  const dealLine = args.dealName
    ? `You are assisting with diligence on **${args.dealName}**.`
    : "You are assisting with venture deal analysis across the user's corpus.";
  const hint = args.workspaceHint?.trim() ? `\n\n${args.workspaceHint.trim()}` : "";
  const inst = args.institutionalBlock?.trim() ? `\n\n${args.institutionalBlock.trim()}\n` : "";
  return `${dealLine}

User task type (routed): **${args.taskLabel}**.${hint}
${inst}
Use the retrieved context and fund criteria below. If information is missing, say so. Be direct and precise. Do not invent facts.

${args.rulesBlock ? `${args.rulesBlock}\n\n` : ""}${args.contextBlock ? `${args.contextBlock}\n\n` : ""}`.trim();
}
