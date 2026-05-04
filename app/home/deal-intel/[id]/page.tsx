import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyDocuments } from "@/components/crm/company-documents";
import Link from "next/link";
import { FileText, FolderOpen, Radio, Search, Sparkles } from "lucide-react";
import { stripMarkdownText } from "@/lib/plain-text";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
  source_kind?: string | null;
  mime_type?: string | null;
  status: string;
  created_at: string;
};

type GeneratedDocRow = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type FactNodeRow = {
  path: string;
  value_text: string | null;
  value_jsonb: unknown;
  updated_at: string;
};

type ResearchRunRow = {
  id: string;
  output_notes: string | null;
  sources: unknown;
  created_at: string;
  run_status: string;
};

type SourceRef = {
  label: string;
  href: string;
  kind: "document" | "web";
};

type NoteItem = {
  title: string;
  text: string;
  sources: SourceRef[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function valuePreview(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter(Boolean)
      .join(", ");
  }
  return JSON.stringify(value);
}

function cleanNoteText(value: unknown, maxChars?: number): string {
  const text = stripMarkdownText(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "")
    .replace(/\b[a-z_]+(?:\.[a-z_]+){2,}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!maxChars) return text;
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...` : text;
}

function pickText(record: unknown, keys: string[]): string {
  const row = asRecord(record);
  for (const key of keys) {
    const text = cleanNoteText(valuePreview(row[key]));
    if (text) return text;
  }
  return "";
}

function isResearchArtifact(doc: DocRow): boolean {
  const folder = (doc.folder_path || "").toLowerCase();
  const source = (doc.source_kind || "").toLowerCase();
  const mime = (doc.mime_type || "").toLowerCase();
  return folder === "web/research" || source === "web" || mime === "text/markdown";
}

function documentSources(docs: DocRow[]): SourceRef[] {
  return docs
    .filter((doc) => !isResearchArtifact(doc))
    .slice(0, 4)
    .map((doc) => ({
      label: doc.original_filename || "Uploaded document",
      href: `/api/crm/documents/${doc.id}/open`,
      kind: "document" as const,
    }));
}

function researchSources(runs: ResearchRunRow[]): SourceRef[] {
  const seen = new Set<string>();
  const refs: SourceRef[] = [];
  for (const run of runs) {
    let sources: unknown[] = [];
    if (Array.isArray(run.sources)) {
      sources = run.sources;
    } else if (typeof run.sources === "string") {
      try {
        const parsed = JSON.parse(run.sources) as unknown;
        sources = Array.isArray(parsed) ? parsed : [];
      } catch {
        sources = [];
      }
    }
    for (const source of sources) {
      const item = asRecord(source);
      const url = typeof item.url === "string" ? item.url : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const fallbackLabel = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      refs.push({
        label: cleanNoteText(item.title || fallbackLabel, 80),
        href: url,
        kind: "web",
      });
      if (refs.length >= 8) return refs;
    }
  }
  return refs;
}

function buildCompanyNotes(args: {
  docs: DocRow[];
  researchRuns: ResearchRunRow[];
  problem: unknown;
  solution: unknown;
  traction: unknown;
  people: Array<Record<string, unknown>>;
  facts: FactNodeRow[];
}): NoteItem[] {
  const docRefs = documentSources(args.docs);
  const webRefs = researchSources(args.researchRuns);
  const notes: NoteItem[] = [];
  const add = (title: string, text: string, sources: SourceRef[]) => {
    const clean = cleanNoteText(text);
    if (!clean) return;
    const duplicate = notes.some((note) => note.text.toLowerCase() === clean.toLowerCase());
    if (!duplicate) notes.push({ title, text: clean, sources });
  };

  add("Problem", pickText(args.problem, ["general_problem_description", "general_description", "urgency", "current_cost_for_customers"]), docRefs);
  add("Solution", pickText(args.solution, ["general_description", "novelty_uniqueness", "customer_benefit", "defensibility"]), docRefs);
  add("Traction", pickText(args.traction, ["revenue_data", "money_raised_per_stage", "investor_list", "growth_trends", "notable_partners_customers"]), docRefs);

  const peopleText = args.people
    .slice(0, 4)
    .map((person) => {
      const name = cleanNoteText(person.name, 80);
      const role = cleanNoteText(person.company_role, 80);
      const description = cleanNoteText(person.general_description || person.experience || person.relevant_achievements, 180);
      return [name, role, description].filter(Boolean).join(" - ");
    })
    .filter(Boolean)
    .join(" ");
  add("People", peopleText, docRefs);

  for (const run of args.researchRuns.slice(0, 4)) {
    const paragraphs = stripMarkdownText(run.output_notes || "")
      .split(/\n{2,}/)
      .map((part) => cleanNoteText(part))
      .filter((part) => part.length > 80);
    for (const paragraph of paragraphs.slice(0, 2)) {
      add("Research Notes", paragraph, webRefs);
      if (notes.length >= 9) break;
    }
    if (notes.length >= 9) break;
  }

  return notes.slice(0, 10);
}

function CompanyNotes({ notes }: { notes: NoteItem[] }) {
  if (!notes.length) {
    return (
      <p className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-6 text-center text-sm text-zinc-500">
        No clean notes yet. Upload documents or run research to build this company view.
      </p>
    );
  }

  const grouped = notes.reduce<Array<{ title: string; items: NoteItem[] }>>((acc, note) => {
    const group = acc.find((item) => item.title === note.title);
    if (group) group.items.push(note);
    else acc.push({ title: note.title, items: [note] });
    return acc;
  }, []);

  return (
    <div className="max-h-[680px] space-y-6 overflow-y-auto pr-2">
      {grouped.map((group) => (
        <section key={group.title} className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-950">{group.title}</h3>
          <div className="space-y-2">
            {group.items.map((note, index) => (
              <div key={`${note.title}_${index}`} className="group relative flex gap-2 text-sm leading-relaxed text-zinc-800">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" />
                <p>{note.text}</p>
                {note.sources.length ? (
                  <div className="pointer-events-none absolute left-4 top-[calc(100%-0.25rem)] z-20 hidden w-72 rounded-2xl border border-zinc-200 bg-white p-3 text-xs shadow-xl group-hover:block group-hover:pointer-events-auto">
                    <p className="mb-2 font-semibold text-zinc-950">Sources</p>
                    <div className="space-y-1.5">
                      {note.sources.slice(0, 4).map((source) => (
                        <a
                          key={source.href}
                          href={source.href}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between gap-2 rounded-xl border border-zinc-100 px-2 py-1.5 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
                        >
                          <span className="truncate">{source.label}</span>
                          <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                            {source.kind}
                          </span>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function DealIntelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/");
  }

  const { data: dealViaRls, error: dealErr } = await supabase
    .schema("deal_intel")
    .from("deal")
    .select("id, created_at, metadata")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  let deal = dealViaRls;
  if (!deal) {
    const admin = createAdminClient();
    const fallback = await admin
      .schema("deal_intel")
      .from("deal")
      .select("id, created_at, metadata")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (fallback.error) {
      console.error("deal detail fallback load:", fallback.error);
    }
    deal = fallback.data ?? null;
  }
  if (dealErr || !deal) notFound();

  const meta = (deal.metadata && typeof deal.metadata === "object" ? (deal.metadata as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";
  const stage = typeof meta.crm_stage === "string" ? meta.crm_stage : null;

  // Lightweight, non-HttpOnly hint cookie so the Chrome extension knows which
  // deal to default to. Only contains id + display name (no secrets).
  try {
    const cookieStore = await cookies();
    cookieStore.set("vcapp_active_deal", JSON.stringify({ id, name: companyName }), {
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
      httpOnly: false,
    });
  } catch {
    // setting cookies in some render contexts can be a no-op; ignore
  }

  const [{ data: docs }, { data: generatedDocs }, problemRes, solutionRes, tractionRes, peopleRes, factRes] = await Promise.all([
    supabase
      .schema("deal_intel")
      .from("document")
      .select("id, original_filename, folder_path, source_kind, mime_type, status, created_at")
      .eq("deal_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .schema("deal_intel")
      .from("generated_document_draft")
      .select("id, title, status, created_at, metadata")
      .eq("deal_id", id)
      .eq("user_id", user.id)
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.schema("deal_intel").from("company_problem").select("*").eq("deal_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.schema("deal_intel").from("company_solution").select("*").eq("deal_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.schema("deal_intel").from("company_traction").select("*").eq("deal_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase
      .schema("deal_intel")
      .from("company_person")
      .select("name, company_role, general_description, education, experience, relevant_achievements")
      .eq("deal_id", id)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .schema("deal_intel")
      .from("deal_fact_node")
      .select("path, value_text, value_jsonb, updated_at")
      .eq("deal_id", id)
      .order("updated_at", { ascending: false })
      .limit(12),
  ]);
  const people = (peopleRes.data ?? []) as Array<Record<string, unknown>>;
  const facts = (factRes.data ?? []) as FactNodeRow[];
  const docRows = ((docs ?? []) as DocRow[]);

  const { data: researchWorkflows } = await supabase
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id")
    .eq("deal_id", id)
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(12);

  const workflowIds = ((researchWorkflows ?? []) as Array<{ id: string }>).map((workflow) => workflow.id);
  let researchRuns: ResearchRunRow[] = [];
  if (workflowIds.length) {
    const { data: runRows } = await supabase
      .schema("deal_intel")
      .from("deal_research_step_run")
      .select("id, output_notes, sources, created_at, run_status")
      .in("workflow_id", workflowIds)
      .eq("run_status", "done")
      .order("created_at", { ascending: false })
      .limit(16);
    researchRuns = (runRows ?? []) as ResearchRunRow[];
  }

  const companyNotes = buildCompanyNotes({
    docs: docRows,
    researchRuns,
    problem: problemRes.data,
    solution: solutionRes.data,
    traction: tractionRes.data,
    people,
    facts,
  });

  return (
    <div className="space-y-5">
      <div className="crm-panel overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-zinc-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-semibold text-zinc-800">
              {companyName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-950">{companyName}</h1>
              <p className="mt-1 text-sm text-zinc-500">
                Stage <span className="font-medium text-zinc-800">{stage ?? "screened"}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link className="crm-button-secondary" href={`/home/deal-intel/${id}/research`}>
              <Search className="h-4 w-4" />
              Research planner
            </Link>
            <Link className="crm-button" href={`/home/deal-intel/${id}/meet`}>
              <Radio className="h-4 w-4" />
              Live meeting
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-0 divide-x divide-zinc-200 md:grid-cols-4">
          <div className="px-5 py-3">
            <p className="text-[11px] font-medium text-zinc-500">Documents</p>
            <p className="mt-0.5 text-sm font-semibold text-zinc-950">{docRows.filter((doc) => !isResearchArtifact(doc)).length}</p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[11px] font-medium text-zinc-500">Generated docs</p>
            <p className="mt-0.5 text-sm font-semibold text-zinc-950">{((generatedDocs ?? []) as GeneratedDocRow[]).length}</p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[11px] font-medium text-zinc-500">Created</p>
            <p className="mt-0.5 text-sm font-semibold text-zinc-950">{deal.created_at ? new Date(deal.created_at).toLocaleDateString() : "-"}</p>
          </div>
          <div className="px-5 py-3">
            <p className="text-[11px] font-medium text-zinc-500">Workspace</p>
            <p className="mt-0.5 text-sm font-semibold text-zinc-950">Active</p>
          </div>
        </div>
      </div>

      <section className="crm-panel">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
              <Sparkles className="h-4 w-4 text-zinc-700" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-950">Company intelligence</h2>
              <p className="text-sm text-zinc-500">Clean notes from uploaded documents, web research, and extracted facts.</p>
            </div>
          </div>
          <Link className="crm-button-secondary" href={`/home/deal-intel/${id}/research`}>
            Update research
          </Link>
        </div>
        <div className="p-4">
          <CompanyNotes notes={companyNotes} />
        </div>
      </section>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-zinc-500" />
            <CardTitle className="text-sm">Evidence library</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <CompanyDocuments dealId={id} initialDocs={docRows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-zinc-500" />
              <CardTitle className="text-sm">Generated docs</CardTitle>
            </div>
            <Link className="crm-button-secondary" href={`/home/document-generator?dealId=${id}`}>
              Create doc
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {((generatedDocs ?? []) as GeneratedDocRow[]).length ? (
            <div className="space-y-2">
              {((generatedDocs ?? []) as GeneratedDocRow[]).map((d) => {
                const format = typeof d.metadata?.output_format === "string" ? d.metadata.output_format : "markdown";
                return (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-2 hover:bg-zinc-50"
                  >
                    <div className="min-w-0">
                      <Link href={`/home/generated-documents/${d.id}`} className="truncate text-sm font-medium text-zinc-900 hover:underline">
                        {d.title}
                      </Link>
                      <p className="text-xs text-zinc-500">
                        {format.toUpperCase()} - {d.status} - {new Date(d.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Link href={`/home/generated-documents/${d.id}`} className="text-xs text-zinc-500 hover:text-zinc-900">
                        Open
                      </Link>
                      <a href={`/api/document-generation/drafts/${d.id}/download`} className="text-xs font-medium text-zinc-700 hover:text-zinc-950">
                        Download
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
              No generated docs for this company yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
