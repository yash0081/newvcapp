import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { InvestmentCriteriaUpload } from "@/components/investment-criteria-upload";
import { FundThesisForm } from "@/components/fund-thesis-form";
import { DataSourceIngest } from "@/components/data-source-ingest";

export default async function ResearchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Decks &amp; thesis</h1>
        <p className="text-sm text-zinc-600 mt-1 max-w-xl leading-relaxed">
          Add investment-criteria docs and edit your fund thesis. For PDF decks, use the{" "}
          <Link href="/home/chat" className="font-medium text-zinc-800 underline underline-offset-2">
            Assistant
          </Link>
          : <strong className="font-medium text-zinc-800">attach a PDF</strong> and run{" "}
          <strong className="font-medium text-zinc-800">Deep research</strong> for the full scored pipeline.
          Open-ended Q&amp;A stays in the Assistant.
        </p>
      </div>

      <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Test: Phase 1 data-source ingest</h2>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Placeholder LLM extract → <strong className="text-zinc-700">deal_intel</strong> (<code>deal</code>,{" "}
          <code>deal_revision</code>, flattened <code>deal_fact_node</code> rows). Same API:{" "}
          <code className="text-[11px] rounded bg-zinc-100 px-1 py-0.5">POST /api/ingestion/phase1-placeholder</code>.
          Supports <strong className="text-zinc-700">PDF upload</strong> or{" "}
          <strong className="text-zinc-700">raw text paste</strong>. Text must be ≥50 characters. Opens a viewer for
          the new deal.
        </p>
        <DataSourceIngest />
      </div>

      <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Investment criteria</h2>
        <p className="text-xs text-zinc-500">Documents inform rubric context in later agents.</p>
        <InvestmentCriteriaUpload />
      </div>

      <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Fund thesis</h2>
        <p className="text-xs text-zinc-500">Used for thesis-fit scoring in the pipeline.</p>
        <FundThesisForm />
      </div>
    </div>
  );
}
