import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { PitchDeckUpload } from "@/components/pitch-deck-upload";
import { FundThesisForm } from "@/components/fund-thesis-form";

async function HomePageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: deals } = await supabase
    .from("deals")
    .select("id, company_name, created_at, deal_scores(dimension, raw_score)")
    .order("created_at", { ascending: false });

  return (
    <main className="min-h-screen bg-white flex flex-col">
      <div className="border-b border-gray-200 p-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">Welcome home</h1>
        <SignOutButton />
      </div>

      <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        <PitchDeckUpload />

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Fund thesis</h2>
          <p className="text-sm text-gray-600">
            This thesis is used by the pipeline to score how well each deck fits your fund&apos;s focus.
          </p>
          <FundThesisForm />
        </div>

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Your deals</h2>
          {!deals || deals.length === 0 ? (
            <p className="text-sm text-gray-500">No deals yet. Upload a pitch deck to get started.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-1">
              {deals.map((deal: any) => {
                const scores = (deal.deal_scores as any[]) ?? [];
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
                  <Card key={deal.id} className="overflow-hidden">
                    <Link
                      href={`/home/deal/${deal.id}`}
                      className="block hover:bg-gray-50/80 transition-colors rounded-lg"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-base font-medium truncate pr-2">
                            {deal.company_name || "(Untitled deal)"}
                          </CardTitle>
                          <Badge variant="secondary" className="shrink-0">
                            {compositeScore.toFixed(1)}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Created{" "}
                          {deal.created_at
                            ? new Date(deal.created_at).toLocaleString()
                            : "—"}
                        </p>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                          {getScore("thesis_fit") != null && (
                            <span>Thesis: {getScore("thesis_fit")!.toFixed(1)}</span>
                          )}
                          {getScore("problem") != null && (
                            <span>Problem: {getScore("problem")!.toFixed(1)}</span>
                          )}
                          {getScore("solution") != null && (
                            <span>Solution: {getScore("solution")!.toFixed(1)}</span>
                          )}
                          {getScore("founder") != null && (
                            <span>Team: {getScore("founder")!.toFixed(1)}</span>
                          )}
                          {getScore("traction") != null && (
                            <span>Traction: {getScore("traction")!.toFixed(1)}</span>
                          )}
                        </div>
                      </CardContent>
                    </Link>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white flex items-center justify-center">Loading...</div>}>
      <HomePageContent />
    </Suspense>
  );
}
