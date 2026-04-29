import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyDocuments } from "@/components/crm/company-documents";
import { DealContentsDebug } from "@/components/crm/deal-contents-debug";
import Link from "next/link";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
  source_kind?: string | null;
  mime_type?: string | null;
  status: string;
  created_at: string;
};

export default async function DealIntelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/");
  }

  const { data: dealViaRls, error: dealErr } = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, created_at, metadata")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  let deal = dealViaRls;
  if (!deal) {
    const admin = createAdminClient();
    const fallback = await admin
      .schema("deal_intel")
      .from("deal")
      .select("id, created_at, metadata")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (fallback.error) {
      console.error("deal detail fallback load:", fallback.error);
    }
    deal = fallback.data ?? null;
  }
  if (dealErr || !deal) notFound();

  const meta = (deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";
  const stage = typeof meta.crm_stage === "string" ? meta.crm_stage : null;

  // Lightweight, non-HttpOnly hint cookie so the Chrome extension knows which
  // deal to default to. Only contains id + display name (no secrets).
  try {
    const cookieStore = await cookies();
    cookieStore.set("vcapp_active_deal", JSON.stringify({ id, name: companyName }), {
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
      httpOnly: false,
    });
  } catch {
    // setting cookies in some render contexts can be a no-op; ignore
  }

  const [{ data: docs }] = await Promise.all([
    supabase
      .schema("deal_intel")
      .from("document")
      .select("id, original_filename, folder_path, source_kind, mime_type, status, created_at")
      .eq("deal_id", id)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{companyName}</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Stage: <span className="font-medium text-zinc-700">{stage ?? "screened"}</span>
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Link className="crm-button-secondary w-full sm:w-auto text-center" href={`/home/deal-intel/${id}/research`}>
            Research planner
          </Link>
          <Link className="crm-button-secondary w-full sm:w-auto text-center" href={`/home/deal-intel/${id}/copilot`}>
            Research copilot
          </Link>
          <Link className="crm-button w-full sm:w-auto text-center" href={`/home/deal-intel/${id}/meet`}>
            Start live meeting
          </Link>
        </div>
      </div>

      <Card className="border-zinc-200/90 bg-white">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <CompanyDocuments dealId={id} initialDocs={((docs ?? []) as DocRow[])} />
        </CardContent>
      </Card>

      <Card className="border-zinc-200/90 bg-white">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Deal contents (debug)</CardTitle>
        </CardHeader>
        <CardContent>
          <DealContentsDebug dealId={id} userId={user.id} />
        </CardContent>
      </Card>
    </div>
  );
}
