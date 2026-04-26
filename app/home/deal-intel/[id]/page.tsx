import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyDocuments } from "@/components/crm/company-documents";
import Link from "next/link";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
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

  const { data: deal, error: dealErr } = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, created_at, metadata")
    .eq("id", id)
    .maybeSingle();
  if (dealErr || !deal) {
    notFound();
  }

  const meta = (deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";
  const stage = typeof meta.crm_stage === "string" ? meta.crm_stage : null;

  const [{ data: docs }] = await Promise.all([
    supabase
      .schema("deal_intel")
      .from("document")
      .select("id, original_filename, folder_path, status, created_at")
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
        <Link className="crm-button w-full sm:w-auto text-center" href={`/home/deal-intel/${id}/meet`}>
          Start live meeting
        </Link>
      </div>

      <Card className="border-zinc-200/90 bg-white">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <CompanyDocuments dealId={id} initialDocs={((docs ?? []) as DocRow[])} />
        </CardContent>
      </Card>
    </div>
  );
}
