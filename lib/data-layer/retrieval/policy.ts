export type QueryType = "similar_company" | "filter_semantic" | "analytical" | "exploratory";

export type ChatTask =
  | "similar_deal"
  | "filtering"
  | "deep_reasoning"
  | "why"
  | "questions";

/** Per plan A4: weight node types when ranking context for the LLM. */
export const QUERY_TYPE_NODE_WEIGHTS: Record<QueryType, Record<string, number>> = {
  similar_company: {
    root: 0.15,
    problem: 0.2,
    solution: 0.2,
    traction: 0.15,
    thesis_fit: 0.15,
    team: 0.15,
  },
  filter_semantic: {
    root: 0.1,
    problem: 0.15,
    solution: 0.15,
    traction: 0.25,
    thesis_fit: 0.2,
    team: 0.15,
  },
  analytical: {
    root: 0.1,
    problem: 0.2,
    solution: 0.2,
    traction: 0.2,
    thesis_fit: 0.15,
    team: 0.15,
  },
  exploratory: {
    root: 0.2,
    problem: 0.18,
    solution: 0.18,
    traction: 0.16,
    thesis_fit: 0.14,
    team: 0.14,
  },
};

/** Blend α in nodeScoreWithSubnodes: higher α weights the parent node embedding vs subnodes. */
const SUBNODE_BLEND_ALPHA_BY_TASK: Record<ChatTask, number> = {
  similar_deal: 0.38,
  filtering: 0.58,
  deep_reasoning: 0.48,
  why: 0.42,
  questions: 0.44,
};

const SUBNODE_BLEND_ALPHA_BY_QUERY: Record<QueryType, number> = {
  similar_company: 0.4,
  filter_semantic: 0.55,
  analytical: 0.48,
  exploratory: 0.5,
};

/**
 * Heuristic query type (plan: hardcoded keywords); extend with classifier later.
 */
export function classifyQueryType(userText: string): QueryType {
  const t = userText.toLowerCase();
  if (/\b(filter|where|stage|sector|only|list all)\b/.test(t)) return "filter_semantic";
  if (/\b(compare|versus|vs\.?|difference|benchmark)\b/.test(t)) return "analytical";
  if (/\b(similar|like this|comps?|comparable)\b/.test(t)) return "similar_company";
  return "exploratory";
}

export function mapTaskToQueryType(task: ChatTask): QueryType {
  switch (task) {
    case "similar_deal":
      return "similar_company";
    case "filtering":
      return "filter_semantic";
    case "deep_reasoning":
    case "why":
    case "questions":
      return "analytical";
    default:
      return "exploratory";
  }
}

export function subnodeBlendAlpha(chatTask: ChatTask | undefined, queryType: QueryType): number {
  if (chatTask && chatTask in SUBNODE_BLEND_ALPHA_BY_TASK) {
    return SUBNODE_BLEND_ALPHA_BY_TASK[chatTask];
  }
  return SUBNODE_BLEND_ALPHA_BY_QUERY[queryType] ?? 0.5;
}
