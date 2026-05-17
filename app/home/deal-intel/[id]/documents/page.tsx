import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyDocuments } from "@/components/crm/company-documents";
import { createClient } from "@/lib/supabase/server";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
  source_kind?: string | null;
  mime_type?: string | null;
  status: string;
  created_at: string;
};

export default async function CompanyDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: deal } = await supabase.schema("deal_intel").from("deal").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!deal) notFound();

  const { data: docs } = await supabase
    .schema("deal_intel")
    .from("document")
    .select("id, original_filename, folder_path, source_kind, mime_type, status, created_at")
    .eq("deal_id", id)
    .order("created_at", { ascending: false });

  return (
    <div className="w-full h-full flex flex-col bg-white p-6 rounded-none border border-zinc-200 shadow-sm">
      <div className="mb-4 pb-4 border-b border-zinc-150 flex items-center justify-between shrink-0">
        <div>
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400">Deal Room</span>
          <h1 className="text-sm font-extrabold uppercase tracking-wider text-zinc-950 mt-0.5">Company Database</h1>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <CompanyDocuments dealId={id} initialDocs={(docs ?? []) as DocRow[]} />
      </div>
    </div>
  );
}

