import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { InvestmentCriteriaUpload } from "@/components/investment-criteria-upload";
import { FundThesisForm } from "@/components/fund-thesis-form";
import { FileCheck2, Target } from "lucide-react";

export default async function ResearchPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  return (
    <div className="space-y-5">
      <div className="crm-panel overflow-hidden">
        <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
            <Target className="h-4 w-4 text-zinc-700" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-950">Thesis &amp; criteria</h1>
            <p className="text-sm text-zinc-500">
              Manage fund-level criteria. Company documents live in{" "}
              <Link href="/home/deals" className="font-medium text-zinc-800 hover:underline">
                Companies
              </Link>
              .
            </p>
          </div>
        </div>
      </div>

      <div className="crm-panel p-5">
        <div className="mb-4 flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-zinc-500" />
          <div>
            <h2 className="text-sm font-semibold text-zinc-950">Investment criteria</h2>
            <p className="text-xs text-zinc-500">Documents inform rubric context in later agents.</p>
          </div>
        </div>
        <InvestmentCriteriaUpload />
      </div>

      <div className="crm-panel p-5">
        <div className="mb-4 flex items-center gap-2">
          <Target className="h-4 w-4 text-zinc-500" />
          <div>
            <h2 className="text-sm font-semibold text-zinc-950">Fund thesis</h2>
            <p className="text-xs text-zinc-500">Used for thesis-fit scoring in the pipeline.</p>
          </div>
        </div>
        <FundThesisForm />
      </div>
    </div>
  );
}
