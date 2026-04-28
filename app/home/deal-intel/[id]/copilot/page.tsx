import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { CopilotPanel } from "@/components/copilot/copilot-panel";
import type { CopilotSession } from "@/lib/copilot/types";

export default async function DealCopilotPage(props: { params: Promise<{ id: string }> }) {
  const { id: dealId } = await props.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const dealRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealRes.error || !dealRes.data) notFound();

  const meta =
    dealRes.data.metadata && typeof dealRes.data.metadata === "object"
      ? (dealRes.data.metadata as Record<string, unknown>)
      : {};
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";

  const sessionRes = await admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("id, deal_id, user_id, status, started_at, ended_at, finalized_document_id, metadata")
    .eq("deal_id", dealId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const session = (sessionRes.data ?? null) as CopilotSession | null;

  return (
    <div className="space-y-4">
      <CopilotPanel dealId={dealId} companyName={companyName} initialSession={session} />
    </div>
  );
}
