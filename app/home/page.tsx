import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { ConnectGmailButton } from "@/components/connect-gmail-button";
import { SyncButton } from "@/components/sync-button";
import { DisconnectGmailButton } from "@/components/disconnect-gmail-button";
import { DeleteEmailButton } from "@/components/delete-email-button";
import { EmailListRefresh } from "@/components/email-list-refresh";
import { TriggerScoringOnLoad } from "@/components/trigger-scoring-on-load";
import { ScorePitchDecksButton } from "@/components/score-pitch-decks-button";
import { FundThesisForm } from "@/components/fund-thesis-form";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { aggregateCommentary, getAnalysisPreview, PREVIEW_CHARS } from "@/lib/commentary";

async function HomePageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  const { data: connection, error: connError } = await supabase
    .from("gmail_connections")
    .select("id, email")
    .eq("user_id", user.id)
    .maybeSingle();

  if (connError && connError.code !== "PGRST116") {
    console.error("Error fetching Gmail connection:", connError);
  }

  let rawEmails: { id: string; subject: string; from_address: string; date: string; snippet: string }[] = [];
  let scoredPitches: {
    emailId: string;
    subject: string;
    from_address: string;
    date: string;
    composite_score: number;
    problem_quality_score: number;
    solution_quality_score: number;
    founder_team_quality_score: number;
    metrics_quality_score: number;
    thesis_fit_score: number | null;
    founder_signal_score: number | null;
    traction_signal_score: number | null;
    solution_defensibility_score: number | null;
    market_power_score: number | null;
    description: string;
  }[] = [];

  if (connection) {
    const { data: emails, error: emailsError } = await supabase
      .from("emails")
      .select("id, subject, from_address, date, snippet")
      .eq("gmail_connection_id", connection.id)
      .is("deleted_at", null)
      .order("date", { ascending: false });

    if (!emailsError && emails?.length) {
      rawEmails = (emails as { id: string; subject: string; from_address: string; date: string; snippet: string }[]) ?? [];
    }

    const { data: results } = await supabase
      .from("pitch_deck_results")
      .select("email_id, composite_score, problem_quality_score, solution_quality_score, founder_team_quality_score, metrics_quality_score, thesis_fit_score, founder_signal_score, traction_signal_score, solution_defensibility_score, market_power_score, parsing_json, problem_extraction_json, solution_extraction_json, problem_web_json, solution_web_json, founder_web_json, metrics_web_json, thesis_fit_json, founder_signal_json, traction_signal_json, problem_quality_3c_json, solution_defensibility_json, market_power_json, core_assumption_json, emails!inner(subject, from_address, date)")
      .order("composite_score", { ascending: false });

    if (results?.length) {
      scoredPitches = results.map((r: Record<string, unknown>) => {
        const rawEmails = r.emails;
        const emailsRow = Array.isArray(rawEmails) ? rawEmails[0] : rawEmails;
        const description = aggregateCommentary({
          parsing_json: r.parsing_json as Record<string, unknown> | null,
          problem_extraction_json: r.problem_extraction_json as Record<string, unknown> | null,
          solution_extraction_json: r.solution_extraction_json as Record<string, unknown> | null,
          problem_web_json: r.problem_web_json as Record<string, unknown> | null,
          solution_web_json: r.solution_web_json as Record<string, unknown> | null,
          founder_web_json: r.founder_web_json as Record<string, unknown> | null,
          metrics_web_json: r.metrics_web_json as Record<string, unknown> | null,
          thesis_fit_json: r.thesis_fit_json as Record<string, unknown> | null,
          founder_signal_json: r.founder_signal_json as Record<string, unknown> | null,
          traction_signal_json: r.traction_signal_json as Record<string, unknown> | null,
          problem_quality_3c_json: r.problem_quality_3c_json as Record<string, unknown> | null,
          solution_defensibility_json: r.solution_defensibility_json as Record<string, unknown> | null,
          market_power_json: r.market_power_json as Record<string, unknown> | null,
          core_assumption_json: r.core_assumption_json as Record<string, unknown> | null,
        });
        const e = (emailsRow as Record<string, unknown>) ?? {};
        return {
          emailId: r.email_id as string,
          subject: (e.subject as string) ?? "",
          from_address: (e.from_address as string) ?? "",
          date: (e.date as string) ?? "",
          composite_score: Number(r.composite_score) ?? 0,
          problem_quality_score: Number(r.problem_quality_score) ?? 0,
          solution_quality_score: Number(r.solution_quality_score) ?? 0,
          founder_team_quality_score: Number(r.founder_team_quality_score) ?? 0,
          metrics_quality_score: Number(r.metrics_quality_score) ?? 0,
          thesis_fit_score: r.thesis_fit_score != null ? Number(r.thesis_fit_score) : null,
          founder_signal_score: r.founder_signal_score != null ? Number(r.founder_signal_score) : null,
          traction_signal_score: r.traction_signal_score != null ? Number(r.traction_signal_score) : null,
          solution_defensibility_score: r.solution_defensibility_score != null ? Number(r.solution_defensibility_score) : null,
          market_power_score: r.market_power_score != null ? Number(r.market_power_score) : null,
          description,
        };
      });
    }
  }

  const scoredEmailIds = new Set(scoredPitches.map((p) => p.emailId));
  const otherEmails = rawEmails.filter((e) => !scoredEmailIds.has(e.id));
  const emailList = [...otherEmails].sort(
    (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  );

  return (
    <main className="min-h-screen bg-white flex flex-col">
      <div className="border-b border-gray-200 p-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">Welcome home</h1>
        <SignOutButton />
      </div>

      <div className="flex-1 p-6 max-w-3xl mx-auto w-full">
        {!connection ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-gray-600">Connect your Gmail to get started</p>
            <ConnectGmailButton />
          </div>
        ) : (
          <div className="space-y-4">
            <EmailListRefresh />
            <TriggerScoringOnLoad />
            <div className="flex items-center justify-between">
              <p className="text-gray-600">
                Gmail connected: <strong>{connection.email}</strong>
              </p>
              <div className="flex items-center gap-2">
                <SyncButton />
                <ScorePitchDecksButton />
                <DisconnectGmailButton />
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Fund thesis</h2>
              <FundThesisForm />
            </div>

            {scoredPitches.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold">Ranked pitch decks</h2>
                <div className="grid gap-4 sm:grid-cols-1">
                  {scoredPitches.map((pitch) => (
                    <Card key={pitch.emailId} className="overflow-hidden">
                      <Link
                        href={`/home/pitch/${pitch.emailId}`}
                        className="block hover:bg-gray-50/80 transition-colors rounded-t-lg"
                      >
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between gap-2">
                            <CardTitle className="text-base font-medium truncate pr-2">
                              {pitch.subject || "(No subject)"}
                            </CardTitle>
                            <Badge variant="secondary" className="shrink-0">
                              {pitch.composite_score.toFixed(1)}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            From: {pitch.from_address}
                            {pitch.date && (
                              <> · {new Date(pitch.date).toLocaleString()}</>
                            )}
                          </p>
                        </CardHeader>
                        <CardContent className="pt-0">
                          {pitch.description ? (
                            <>
                              <div className="text-sm text-gray-600 whitespace-pre-wrap space-y-2">
                                {getAnalysisPreview(pitch.description, PREVIEW_CHARS)
                                  .split("\n\n")
                                  .map((para, i) => (
                                    <p key={i}>{para}</p>
                                  ))}
                                {pitch.description.length > PREVIEW_CHARS && (
                                  <p className="text-gray-400 italic">…</p>
                                )}
                              </div>
                              <p className="mt-2 text-sm font-medium text-blue-600">
                                View full analysis →
                              </p>
                            </>
                          ) : (
                            <p className="text-sm text-gray-500 italic">No commentary yet.</p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                            {pitch.thesis_fit_score != null && <span>Thesis: {pitch.thesis_fit_score.toFixed(1)}</span>}
                            <span>Problem: {pitch.problem_quality_score.toFixed(1)}</span>
                            <span>Solution: {(pitch.solution_defensibility_score ?? pitch.solution_quality_score).toFixed(1)}</span>
                            <span>Team: {(pitch.founder_signal_score ?? pitch.founder_team_quality_score).toFixed(1)}</span>
                            <span>Traction: {(pitch.traction_signal_score ?? pitch.metrics_quality_score).toFixed(1)}</span>
                            {pitch.market_power_score != null && <span>Market: {pitch.market_power_score.toFixed(1)}</span>}
                          </div>
                        </CardContent>
                      </Link>
                      <CardFooter className="pt-0 flex justify-end border-t border-gray-100">
                        <DeleteEmailButton emailId={pitch.emailId} />
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <h2 className="text-lg font-semibold">
                {scoredPitches.length > 0 ? "Other emails" : "Emails"}
              </h2>
              {emailList.length === 0 && scoredPitches.length === 0 ? (
                <p className="text-gray-500 text-sm">
                  No emails yet. Click Sync now to fetch, or wait for new mail.
                </p>
              ) : emailList.length === 0 ? (
                <p className="text-gray-500 text-sm">No other emails.</p>
              ) : (
                <ul className="space-y-2 divide-y divide-gray-100">
                  {emailList.map((email) => (
                    <li key={email.id} className="py-3 flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{email.subject || "(No subject)"}</div>
                        <div className="text-sm text-gray-500">
                          From: {email.from_address}
                          {email.date && (
                            <> · {new Date(email.date).toLocaleString()}</>
                          )}
                        </div>
                        {email.snippet && (
                          <div className="text-sm text-gray-600 mt-1 line-clamp-2">
                            {email.snippet}
                          </div>
                        )}
                      </div>
                      <DeleteEmailButton emailId={email.id} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
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
