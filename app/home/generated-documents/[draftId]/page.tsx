import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Download, ExternalLink, FileText } from "lucide-react";

export default async function GeneratedDocumentPage(props: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await props.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .select("id, deal_id, type_id, title, prompt, content, status, missing_info, research_steps, metadata, created_at, updated_at")
    .eq("id", draftId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (res.error || !res.data) notFound();

  const draft = res.data as {
    id: string;
    deal_id: string | null;
    title: string;
    prompt: string;
    content: string;
    status: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };
  const format = typeof draft.metadata?.output_format === "string" ? draft.metadata.output_format : "markdown";
  const previewHref = `/api/document-generation/drafts/${draft.id}/preview`;

  return (
    <div className="space-y-5">
      <div className="crm-panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-200 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
              <FileText className="h-4 w-4 text-zinc-700" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight text-zinc-950">{draft.title}</h1>
              <p className="mt-1 text-sm text-zinc-500">
                {format.toUpperCase()} / {draft.status} / {new Date(draft.updated_at || draft.created_at).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="crm-button" href={`/api/document-generation/drafts/${draft.id}/download`}>
              <Download className="h-4 w-4" />
              Download
            </a>
            {draft.deal_id ? (
              <Link className="crm-button-secondary" href={`/home/deal-intel/${draft.deal_id}`}>
                Company
              </Link>
            ) : null}
            <Link className="crm-button-secondary" href="/home/document-generator">
              Generator
            </Link>
          </div>
        </div>
      </div>

      <section className="crm-panel p-4">
        <p className="crm-kicker">Prompt</p>
        <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{draft.prompt}</p>
      </section>

      <section className="crm-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5">
          <p className="crm-kicker">
            {format.toUpperCase()} preview
          </p>
          <a className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-950" href={previewHref} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />
            Open preview
          </a>
        </div>
        <iframe
          className="h-[760px] w-full bg-white"
          src={previewHref}
          title={`${draft.title} preview`}
        />
      </section>
    </div>
  );
}
