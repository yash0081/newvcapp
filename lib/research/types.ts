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

export type ResearchWorkflowRow = {
  id: string;
  deal_id: string;
  user_id: string;
  title: string;
  status: ResearchWorkflowStatus;
  version: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type ResearchStepRow = {
  id: string;
  workflow_id: string;
  position: number;
  status: ResearchStepStatus;
  website: string;
  task: string;
  notes: string | null;
  depends_on_step_ids: string[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

