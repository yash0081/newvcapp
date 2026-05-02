import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { ExternalLink, Search } from "lucide-react";

type Source = { url: string; title?: string; snippet?: string };

export default async function ResearchDocumentPage(props: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await props.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const docRes = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id, original_filename, doc_type, status")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (docRes.error || !docRes.data) notFound();

  const pageRes = await admin
    .schema("deal_intel")
    .from("document_page")
    .select("text, metadata")
    .eq("document_id", documentId)
    .eq("page_number", 1)
    .maybeSingle();
  if (pageRes.error || !pageRes.data) notFound();

  const meta = (pageRes.data.metadata && typeof pageRes.data.metadata === "object" ? pageRes.data.metadata : {}) as Record<string, unknown>;
  const sources = (Array.isArray(meta.sources) ? meta.sources : []) as Source[];

  return (
    <div className="space-y-5">
      <div className="crm-panel p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
            <Search className="h-4 w-4 text-zinc-700" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-zinc-500">Web research / {docRes.data.status}</p>
            <h1 className="break-words text-lg font-semibold text-zinc-950">{docRes.data.original_filename || documentId}</h1>
          </div>
        </div>
      </div>

      <div className="crm-panel p-5">
        <p className="crm-kicker mb-3">Output</p>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">{pageRes.data.text}</div>
      </div>

      <div className="crm-panel p-5">
        <p className="crm-kicker mb-3">Citations</p>
        {sources.length ? (
          <div className="space-y-2">
            {sources.map((s, i) => (
              <div key={`${s.url}_${i}`} className="rounded-xl border border-zinc-200 bg-white p-3">
                <a href={s.url} target="_blank" rel="noreferrer" className="flex items-start gap-2 break-all text-sm font-medium text-blue-700 hover:underline">
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {s.title || s.url}
                </a>
                {s.snippet ? <p className="text-xs text-zinc-600 mt-1">{s.snippet}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">No citations captured for this step.</p>
        )}
      </div>
    </div>
  );
}
