import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { FullDocumentViewer } from "@/components/crm/full-document-viewer";

export default async function DocumentViewPage(props: {
  params: Promise<{ documentId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { documentId } = await props.params;
  const { q } = await props.searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const docRes = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id, deal_id, source_kind, original_filename, mime_type, status, created_at")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (docRes.error || !docRes.data) notFound();

  const pagesRes = await admin
    .schema("deal_intel")
    .from("document_page")
    .select("page_number, text")
    .eq("document_id", documentId)
    .order("page_number", { ascending: true })
    .limit(50);
  if (pagesRes.error) notFound();

  const pages = (pagesRes.data ?? []) as Array<{ page_number: number; text: string }>;
  if (!pages.length) notFound();

  const title = docRes.data.original_filename || documentId;
  const sourceLabel = `${docRes.data.source_kind || "document"} · ${docRes.data.mime_type || "unknown"} · ${docRes.data.status}`;

  return (
    <div className="max-w-4xl space-y-4">
      <FullDocumentViewer title={title} sourceLabel={sourceLabel} pages={pages} query={q} />
    </div>
  );
}

