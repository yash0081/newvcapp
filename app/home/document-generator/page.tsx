import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DocumentGenerator } from "@/components/document-generation/document-generator";

function companyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Untitled company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" && m.company_name.trim() ? m.company_name.trim() : "Untitled company";
}

export default async function DocumentGeneratorPage(props: { searchParams: Promise<{ dealId?: string }> }) {
  const { dealId } = await props.searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const dealsRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  const deals = ((dealsRes.data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>).map((d) => ({
    id: d.id,
    name: companyName(d.metadata),
  }));

  const initialDealId = typeof dealId === "string" && deals.some((d) => d.id === dealId) ? dealId : undefined;

  return <DocumentGenerator deals={deals} initialDealId={initialDealId} />;
}
