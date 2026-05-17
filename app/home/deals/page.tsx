import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { CompaniesPipeline, type PipelineCompany } from "@/components/crm/companies-pipeline";
import { ensureCrmStages, normalizeStageKey } from "@/lib/crm/stages";
import { createAdminClient } from "@/lib/supabase/admin";

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export default async function DealsListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const admin = createAdminClient();
  const stages = await ensureCrmStages(admin, user.id);

  const { data: deals, error } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, created_at, metadata")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("deal_intel.deal list:", error);
  }

  const companies: PipelineCompany[] = (deals ?? []).map((deal: { id: string; created_at: string; metadata: unknown }) => {
    const meta = safeMeta(deal.metadata);
    const name = typeof meta.company_name === "string" && meta.company_name.trim() ? meta.company_name.trim() : "(Untitled company)";
    const website = typeof meta.website === "string" ? meta.website : "";
    return {
      id: deal.id,
      name,
      website,
      stage: normalizeStageKey(meta.crm_stage, stages),
      createdAt: deal.created_at,
    };
  });

  return <CompaniesPipeline initialCompanies={companies} stages={stages} />;
}
