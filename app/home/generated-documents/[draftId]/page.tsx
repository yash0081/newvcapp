import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{draft.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {format.toUpperCase()} - {draft.status} - {new Date(draft.updated_at || draft.created_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <a className="crm-button" href={`/api/document-generation/drafts/${draft.id}/download`}>
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

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Prompt</p>
        <p className="mt-1 text-sm text-zinc-700 whitespace-pre-wrap">{draft.prompt}</p>
      </section>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            {format.toUpperCase()} preview
          </p>
          <a className="text-xs font-medium text-zinc-600 hover:text-zinc-950" href={previewHref} target="_blank" rel="noreferrer">
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
