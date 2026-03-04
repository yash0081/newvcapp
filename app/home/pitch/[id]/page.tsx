import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { aggregateCommentaryStructured } from "@/lib/commentary";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AnalysisAccordion } from "@/components/analysis-accordion";

export default async function PitchAnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: emailId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const { data: connection } = await supabase
    .from("gmail_connections")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!connection) {
    notFound();
  }

  const { data: email, error: emailError } = await supabase
    .from("emails")
    .select("id, subject, from_address, date")
    .eq("id", emailId)
    .eq("gmail_connection_id", connection.id)
    .maybeSingle();

  if (emailError || !email) notFound();

  const { data: result, error: resultError } = await supabase
    .from("pitch_deck_results")
    .select(
      "email_id, composite_score, problem_quality_score, solution_quality_score, founder_team_quality_score, metrics_quality_score, thesis_fit_score, founder_signal_score, traction_signal_score, solution_defensibility_score, market_power_score, parsing_json, problem_extraction_json, solution_extraction_json, problem_web_json, solution_web_json, founder_web_json, metrics_web_json, thesis_fit_json, founder_signal_json, traction_signal_json, problem_quality_3c_json, solution_defensibility_json, market_power_json, core_assumption_json"
    )
    .eq("email_id", emailId)
    .maybeSingle();

  if (resultError || !result) notFound();

  const structured = aggregateCommentaryStructured({
    parsing_json: result.parsing_json as Record<string, unknown> | null,
    problem_extraction_json: result.problem_extraction_json as Record<string, unknown> | null,
    solution_extraction_json: result.solution_extraction_json as Record<string, unknown> | null,
    problem_web_json: result.problem_web_json as Record<string, unknown> | null,
    solution_web_json: result.solution_web_json as Record<string, unknown> | null,
    founder_web_json: result.founder_web_json as Record<string, unknown> | null,
    metrics_web_json: result.metrics_web_json as Record<string, unknown> | null,
    thesis_fit_json: result.thesis_fit_json as Record<string, unknown> | null,
    founder_signal_json: result.founder_signal_json as Record<string, unknown> | null,
    traction_signal_json: result.traction_signal_json as Record<string, unknown> | null,
    problem_quality_3c_json: result.problem_quality_3c_json as Record<string, unknown> | null,
    solution_defensibility_json: result.solution_defensibility_json as Record<string, unknown> | null,
    market_power_json: result.market_power_json as Record<string, unknown> | null,
    core_assumption_json: result.core_assumption_json as Record<string, unknown> | null,
  });

  return (
    <main className="min-h-screen bg-gray-50/50 flex flex-col">
      <div className="border-b border-gray-200 bg-white p-4 flex justify-between items-center">
        <Link
          href="/home"
          className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          ← Back to home
        </Link>
      </div>

      <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-lg font-semibold pr-2 text-gray-900">
                {email.subject || "(No subject)"}
              </CardTitle>
              <Badge variant="secondary" className="shrink-0 font-medium">
                {(result.composite_score ?? 0).toFixed(1)}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              From: {email.from_address}
              {email.date && (
                <> · {new Date(email.date).toLocaleString()}</>
              )}
            </p>
          </CardHeader>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-gray-900">Analysis</CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              Expand a section to see details, evidence, and scores.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <AnalysisAccordion data={structured} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
