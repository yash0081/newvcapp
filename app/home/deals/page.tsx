import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function DealsListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: deals } = await supabase
    .from("deals")
    .select("id, company_name, created_at, source, decision, deal_scores(dimension, raw_score)")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Deals</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Includes markdown corpus deals (Invested Companies profile) once seeded — same retrieval tree as PDF
            pipelines after backfill.
          </p>
        </div>
        <Link
          href="/home/deals/grid"
          className="inline-flex items-center justify-center rounded-full bg-zinc-900 text-white px-4 py-2 text-sm font-medium hover:bg-zinc-800 transition-colors shadow-sm"
        >
          Open spreadsheet →
        </Link>
      </div>

      {!deals || deals.length === 0 ? (
        <p className="text-sm text-zinc-500 rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-8 text-center">
          No deals yet. Run a deck from{" "}
          <Link href="/home/research" className="font-medium text-zinc-800 underline underline-offset-2">
            Deck research
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-1">
          {deals.map((deal: Record<string, unknown>) => {
            const scores = (deal.deal_scores as { dimension: string; raw_score: unknown }[]) ?? [];
            const normalizeScore = (v: unknown) => {
              if (typeof v !== "number" || Number.isNaN(v)) return null;
              return Math.max(0, Math.min(10, v));
            };
            const getScore = (dim: string) =>
              normalizeScore(scores.find((s) => s.dimension === dim)?.raw_score ?? null);
            const composite =
              (getScore("thesis_fit") ?? 0) +
              (getScore("founder") ?? 0) +
              (getScore("traction") ?? 0) +
              (getScore("problem") ?? 0) +
              (getScore("solution") ?? 0);
            const compositeScore = composite ? composite / 5 : 0;

            return (
              <Card
                key={deal.id as string}
                className="overflow-hidden border-zinc-200/90 shadow-sm rounded-2xl bg-white"
              >
                <Link
                  href={`/home/deal/${deal.id as string}`}
                  className="block hover:bg-zinc-50/80 transition-colors rounded-2xl"
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-base font-medium truncate pr-2 text-zinc-900">
                          {(deal.company_name as string) || "(Untitled deal)"}
                        </CardTitle>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {deal.source === "invested-companies-md" && (
                            <Badge variant="outline" className="text-[10px] font-normal border-amber-300 text-amber-900 bg-amber-50">
                              Markdown corpus
                            </Badge>
                          )}
                          {typeof deal.decision === "string" && deal.decision.trim() && (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              {deal.decision}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Badge variant="secondary" className="shrink-0 rounded-lg">
                        {compositeScore.toFixed(1)}
                      </Badge>
                    </div>
                    <p className="text-sm text-zinc-500">
                      Created{" "}
                      {deal.created_at
                        ? new Date(deal.created_at as string).toLocaleString()
                        : "—"}
                    </p>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                      {getScore("thesis_fit") != null && <span>Thesis: {getScore("thesis_fit")!.toFixed(1)}</span>}
                      {getScore("problem") != null && <span>Problem: {getScore("problem")!.toFixed(1)}</span>}
                      {getScore("solution") != null && <span>Solution: {getScore("solution")!.toFixed(1)}</span>}
                      {getScore("founder") != null && <span>Team: {getScore("founder")!.toFixed(1)}</span>}
                      {getScore("traction") != null && <span>Traction: {getScore("traction")!.toFixed(1)}</span>}
                    </div>
                  </CardContent>
                </Link>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
