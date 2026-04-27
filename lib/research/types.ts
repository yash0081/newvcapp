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

export type ResearchPlanSuggestion = {
  summary: string;
  steps: ResearchPlanStepInput[];
};

