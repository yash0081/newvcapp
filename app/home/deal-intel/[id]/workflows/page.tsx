import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listCustomWorkflowDefinitions, listCustomWorkflowRuns } from "@/lib/custom-workflows";
import { listChatDeals } from "@/lib/chat/workspace-chat";
import { WorkflowBuilder } from "@/components/workflows/workflow-builder";

export default async function CompanyWorkflowsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const [workflows, runs, deals, docTypesRes] = await Promise.all([
    listCustomWorkflowDefinitions(admin, user.id),
    listCustomWorkflowRuns(admin, user.id),
    listChatDeals(admin, user.id).catch(() => []),
    admin
      .schema("deal_intel")
      .from("document_generation_type")
      .select("id, name, output_format")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false }),
  ]);

  return (
    <div className="w-full h-full flex flex-col bg-white rounded-none border border-zinc-200 shadow-sm p-5 overflow-auto">
      <WorkflowBuilder
        initialWorkflows={workflows}
        initialRuns={runs}
        deals={deals}
        documentTypes={(docTypesRes.data ?? []) as Array<{ id: string; name: string; output_format: string | null }>}
      />
    </div>
  );
}
