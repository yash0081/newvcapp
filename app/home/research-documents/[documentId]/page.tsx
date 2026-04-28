import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";

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
    <div className="max-w-3xl space-y-4">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-1">
        <p className="text-xs text-zinc-500">Web research · {docRes.data.status}</p>
        <h1 className="text-lg font-semibold text-zinc-900 break-words">{docRes.data.original_filename || documentId}</h1>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <p className="text-sm font-medium text-zinc-900 mb-2">Output</p>
        <div className="text-sm text-zinc-800 whitespace-pre-wrap leading-relaxed">{pageRes.data.text}</div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <p className="text-sm font-medium text-zinc-900 mb-2">Citations</p>
        {sources.length ? (
          <div className="space-y-2">
            {sources.map((s, i) => (
              <div key={`${s.url}_${i}`} className="rounded-xl border border-zinc-200 p-2">
                <a href={s.url} target="_blank" rel="noreferrer" className="block text-sm text-blue-700 underline break-all">
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

