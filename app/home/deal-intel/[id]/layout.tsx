import { notFound, redirect } from "next/navigation";
import { CompanyShell } from "@/components/crm/company-shell";
import { ensureCrmStages, normalizeStageKey } from "@/lib/crm/stages";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function safeMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function DealIntelLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const [{ data: deal, error }, stages] = await Promise.all([
    admin.schema("deal_intel").from("deal").select("id, metadata").eq("id", id).eq("user_id", user.id).maybeSingle(),
    ensureCrmStages(admin, user.id),
  ]);
  if (error) throw error;
  if (!deal) notFound();
  const meta = safeMeta(deal.metadata);
  const companyName = typeof meta.company_name === "string" && meta.company_name.trim() ? meta.company_name.trim() : "Company";
  const stageKey = normalizeStageKey(meta.crm_stage, stages);
  const stageLabel = stages.find((stage) => stage.key === stageKey)?.label ?? "Screened";

  return (
    <CompanyShell dealId={id} companyName={companyName} stageLabel={stageLabel}>
      {children}
    </CompanyShell>
  );
}

