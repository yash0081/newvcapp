import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { InvestmentCriteriaUpload } from "@/components/investment-criteria-upload";
import { FundThesisForm } from "@/components/fund-thesis-form";

export default async function ResearchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Thesis &amp; criteria</h1>
        <p className="text-sm text-zinc-600 mt-1 max-w-xl leading-relaxed">
          Manage your fund thesis and investment criteria. Upload decks and documents from{" "}
          <Link href="/home/deals" className="font-medium text-zinc-800 underline underline-offset-2">
            Companies
          </Link>
          .
        </p>
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
