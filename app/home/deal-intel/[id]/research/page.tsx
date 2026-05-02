import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { ResearchPlanner } from "@/components/research/research-planner";

type Workflow = {
  id: string;
  title: string;
  status: string;
  version: number;
  metadata: Record<string, unknown> | null;
};

type Step = {
  id: string;
  workflow_id: string;
  position: number;
  status: "todo" | "blocked" | "queued" | "running" | "done" | "failed";
  website: string;
  task: string;
  notes: string | null;
  depends_on_step_ids: string[];
  metadata: Record<string, unknown> | null;
};

type Run = {
  id: string;
  step_id: string;
  run_status: string;
  output_notes: string | null;
  sources: Array<{ url: string; title?: string; snippet?: string }> | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export default async function DealResearchPage(props: { params: Promise<{ id: string }> }) {
  const { id: dealId } = await props.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const dealViaRls = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  let deal = dealViaRls.data ?? null;
  if (!deal) {
    const fallback = await admin
      .schema("deal_intel")
      .from("deal")
      .select("id, metadata")
      .eq("id", dealId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (fallback.error) {
      console.error("research deal fallback load:", fallback.error);
    }
    deal = fallback.data ?? null;
  }
  if (!deal) notFound();

  const meta =
    deal.metadata && typeof deal.metadata === "object"
      ? (deal.metadata as Record<string, unknown>)
      : {};
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";

  const wfRes = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id, title, status, version, metadata")
    .eq("deal_id", dealId)
    .eq("user_id", user.id)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let workflow: Workflow | null = null;
  let steps: Step[] = [];
  let runs: Run[] = [];

  if (wfRes.data) {
    workflow = wfRes.data as Workflow;
    const [stepRes, runRes] = await Promise.all([
      admin
        .schema("deal_intel")
        .from("deal_research_step")
        .select("id, workflow_id, position, status, website, task, notes, depends_on_step_ids, metadata")
        .eq("workflow_id", workflow.id)
        .order("position", { ascending: true }),
      admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .select("id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
        .eq("workflow_id", workflow.id)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    if (stepRes.error) {
      console.error(stepRes.error);
    } else {
      steps = (stepRes.data ?? []) as Step[];
    }
    if (runRes.error) {
      console.error(runRes.error);
    } else {
      runs = (runRes.data ?? []) as Run[];
    }
  }

  return (
    <div className="space-y-4">
      <ResearchPlanner
        dealId={dealId}
        companyName={companyName}
        initialWorkflow={workflow}
        initialSteps={steps}
        initialRuns={runs}
      />
    </div>
  );
}
