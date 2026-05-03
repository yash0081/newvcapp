export type ResearchStepStatus = "todo" | "blocked" | "queued" | "running" | "done" | "failed";

export type ResearchWorkflowStatus = "draft" | "ready" | "running" | "done" | "archived";

export type WebsiteCategory =
  | "founder"
  | "product"
  | "market"
  | "traction"
  | "hiring"
  | "legal"
  | "news"
  | "general";

export type ResearchSource = {
  url: string;
  title?: string;
  snippet?: string;
};

export type ResearchPlanStepInput = {
  website: string;
  task: string;
  category?: WebsiteCategory;
  dependsOnStepIds?: string[];
};

export type ResearchPlanScope = {
  userGoal: string;
  breadth: "narrow" | "standard" | "broad";
  requiredTopics: string[];
  excludedTopics: string[];
  allowedCategories: WebsiteCategory[];
  sourceStrategy: string;
  maxSteps: number;
  includeRiskCheck: boolean;
  mustCompare: boolean;
};

export type ResearchPlanSuggestion = {
  summary: string;
  steps: ResearchPlanStepInput[];
  intent?: ResearchPlanScope;
  pruningNotes?: string[];
};
