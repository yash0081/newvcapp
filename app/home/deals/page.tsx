import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StageMenu } from "@/components/crm/stage-menu";
import { NewCompanyForm } from "@/components/crm/new-company-form";

type Stage = "screened" | "in_process" | "invested" | "passed";

export default async function DealsListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: deals, error } = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, created_at, metadata")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("deal_intel.deal list:", error);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Companies</h1>
          <p className="text-sm text-zinc-500 mt-1">Create a company, set a stage, upload decks.</p>
        </div>
      </div>

      <Card className="border-zinc-200/90 bg-white">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">New company</CardTitle>
        </CardHeader>
        <CardContent>
          <NewCompanyForm />
        </CardContent>
      </Card>

      {!deals || deals.length === 0 ? (
        <p className="text-sm text-zinc-500 rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-10 text-center">
          No companies yet. Create one above.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {deals.map((deal: { id: string; created_at: string; metadata: unknown }) => {
            const meta = (deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : {}) as Record<
              string,
              unknown
            >;
            const name = typeof meta.company_name === "string" ? meta.company_name : "(Untitled company)";
            const stage = (typeof meta.crm_stage === "string" ? (meta.crm_stage as Stage) : null) as Stage | null;
            return (
              <Card
                key={deal.id as string}
                className="border-zinc-200/90 bg-white hover:shadow-md transition-shadow"
              >
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-[15px] font-semibold leading-tight truncate pr-2 text-zinc-900">
                        <a className="hover:underline" href={`/home/deal-intel/${deal.id}`}>
                          {name}
                        </a>
                      </CardTitle>
                    </div>
                    <StageMenu dealId={deal.id} current={stage ?? "screened"} />
                  </div>
                  <p className="text-xs text-zinc-400 mt-2">
                    Created {deal.created_at ? new Date(deal.created_at).toLocaleDateString() : "—"}
                  </p>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
