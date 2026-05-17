import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DocumentGenerator } from "@/components/document-generation/document-generator";

function companyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Untitled company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" && m.company_name.trim() ? m.company_name.trim() : "Untitled company";
}

export default async function DealDraftsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
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

  const initialDealId = deals.some((d) => d.id === id) ? id : undefined;

  return (
    <div className="h-full w-full overflow-y-auto flex flex-col min-h-0 bg-white p-5 md:p-6">
      <DocumentGenerator deals={deals} initialDealId={initialDealId} />
    </div>
  );
}
