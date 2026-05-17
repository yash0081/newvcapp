"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  Calendar,
  CheckCircle2,
  FileUp,
  GripVertical,
  LayoutGrid,
  Loader2,
  Plus,
  Rows3,
  Search,
  UploadCloud,
} from "lucide-react";
import { NewCompanyForm } from "@/components/crm/new-company-form";
import { stageAccentClass, stageDotClass } from "@/lib/crm/stages";
import { cn } from "@/lib/utils";

export type PipelineCompany = {
  id: string;
  name: string;
  website: string;
  stage: string;
  createdAt: string;
  activityCount?: number;
};

export type PipelineStage = {
  key: string;
  label: string;
  position?: number;
  is_default?: boolean;
};

function dateLabel(value: string): string {
  if (!value) return "No date";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as Record<string, unknown>;
}

export function CompaniesPipeline({ initialCompanies, stages }: { initialCompanies: PipelineCompany[]; stages: PipelineStage[] }) {
  const [companies, setCompanies] = useState<PipelineCompany[]>(initialCompanies);
  const [query, setQuery] = useState("");
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busyIntake, setBusyIntake] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageList = useMemo(() => (stages.length ? stages : [{ key: "screened", label: "Screened" }]), [stages]);
  const stageByKey = useMemo(() => new Map(stageList.map((stage) => [stage.key, stage])), [stageList]);
  const activeCount = companies.filter((c) => c.stage !== "passed" && c.stage !== "invested").length;

  const filteredCompanies = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((company) =>
      `${company.name} ${company.website} ${stageByKey.get(company.stage)?.label ?? company.stage}`.toLowerCase().includes(q),
    );
  }, [companies, query, stageByKey]);

  const labelForStage = (stage: string) => stageByKey.get(stage)?.label ?? stage;

  async function moveCompany(dealId: string, nextStage: string) {
    const company = companies.find((c) => c.id === dealId);
    if (!company || company.stage === nextStage) return;
    const previous = companies;
    setCompanies((prev) => prev.map((c) => (c.id === dealId ? { ...c, stage: nextStage } : c)));
    setError(null);
    setMessage(`${company.name} moved to ${labelForStage(nextStage)}.`);
    try {
      await postJson("/api/crm/companies/stage", { deal_id: dealId, crm_stage: nextStage });
    } catch (e) {
      setCompanies(previous);
      setError(e instanceof Error ? e.message : String(e));
      setMessage(null);
    }
  }

  async function smartUpload() {
    if (!file || busyIntake) return;
    setBusyIntake(true);
    setError(null);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/crm/documents/auto-upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        documentId?: string;
        dealId?: string;
        companyName?: string;
        createdDeal?: boolean;
        needsParse?: boolean;
        error?: string;
      };
      if (!res.ok || !data.documentId) throw new Error(data.error || "Upload failed");

      const companyName = data.companyName || "the matched company";
      setMessage(`${data.createdDeal ? "Created" : "Routed"} ${companyName}. Processing the document now...`);
      setFile(null);

      if (data.needsParse) await postJson(`/api/crm/documents/${data.documentId}/parse`);
      await postJson(`/api/crm/documents/${data.documentId}/chunk`);
      await postJson(`/api/crm/documents/${data.documentId}/ingest-deal-intel`);
      setMessage(`Document added to ${companyName}. Refreshing the pipeline...`);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyIntake(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100svh-8.5rem)] flex-col overflow-hidden rounded-[22px] border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-200 bg-white px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50">
                <Building2 className="h-4 w-4 text-zinc-700" />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-zinc-950">Companies</h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                  <span>{companies.length} tracked</span>
                  <span className="h-1 w-1 rounded-full bg-zinc-300" />
                  <span>{activeCount} active</span>
                  <span className="h-1 w-1 rounded-full bg-zinc-300" />
                  <span>Drag cards to update stage</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2 xl:max-w-4xl">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  className="crm-input h-10 border-zinc-300 bg-zinc-50 pl-9 shadow-none focus:bg-white"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search companies, stage, or website"
                />
              </div>
              <div className="flex shrink-0 gap-2">
                <label className="crm-button-secondary h-10 cursor-pointer border-zinc-300 shadow-none">
                  <FileUp className="h-4 w-4" />
                  <span className="max-w-[180px] truncate">{file ? file.name : "Upload PDF"}</span>
                  <input
                    className="hidden"
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
                <button className="crm-button h-10 px-3" type="button" disabled={!file || busyIntake} onClick={smartUpload}>
                  {busyIntake ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  {busyIntake ? "Routing" : "Route"}
                </button>
              </div>
            </div>
            {message ? (
              <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{message}</p>
            ) : null}
            {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p> : null}
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-zinc-200 bg-zinc-50/70 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2 border-b border-zinc-200/70 pb-2">
            <Plus className="h-3.5 w-3.5 text-zinc-500" />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Add company</h2>
          </div>
          <NewCompanyForm stages={stageList} />
        </div>
      </div>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-950">Pipeline</h2>
            <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-zinc-500 ring-1 ring-zinc-200">
              {filteredCompanies.length} shown
            </span>
          </div>
          <p className="hidden text-xs text-zinc-500 sm:block">
            Drag between columns to update CRM stage
          </p>
        </div>

        <div className="grid flex-1 items-stretch gap-px overflow-auto bg-zinc-200 md:auto-cols-[minmax(240px,1fr)] md:grid-flow-col">
          {stageList.map((stage) => {
            const stageCompanies = filteredCompanies.filter((company) => company.stage === stage.key);
            const isOver = dragOverStage === stage.key;
            return (
              <div
                key={stage.key}
                className={cn(
                  "flex min-h-[260px] flex-col p-2.5 transition-colors",
                  stageAccentClass(stage.key),
                  isOver && "ring-2 ring-inset ring-zinc-900/15",
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverStage(stage.key);
                }}
                onDragLeave={() => setDragOverStage(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const dealId = e.dataTransfer.getData("text/plain");
                  setDragOverStage(null);
                  void moveCompany(dealId, stage.key);
                }}
              >
                <div className="mb-2 flex items-start justify-between gap-3 px-1">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2.5 w-2.5 rounded-full", stageDotClass(stage.key))} />
                      <h3 className="text-sm font-semibold text-zinc-950">{stage.label}</h3>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">{stage.is_default ? "Default stage" : "Custom stage"}</p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
                    {stageCompanies.length}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {stageCompanies.map((company) => (
                    <article
                      key={company.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", company.id);
                      }}
                      className="group rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-sm transition hover:border-zinc-300 hover:shadow-md"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-700">
                            {company.name.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <Link
                              className="block truncate text-sm font-semibold text-zinc-950 hover:underline"
                              href={`/home/deal-intel/${company.id}`}
                            >
                              {company.name}
                            </Link>
                            <p className="truncate text-xs text-zinc-500">{company.website || "No website recorded"}</p>
                          </div>
                        </div>
                        <GripVertical className="mt-1 h-4 w-4 shrink-0 text-zinc-300 group-hover:text-zinc-500" />
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500">
                        <span className="inline-flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {dateLabel(company.createdAt)}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 font-medium text-zinc-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          CRM
                        </span>
                      </div>
                    </article>
                  ))}
                  {!stageCompanies.length ? (
                    <div className="flex min-h-16 items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-white/70 p-3 text-center text-xs text-zinc-500">
                      Drop companies here
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          </div>
      </section>
    </div>
  );
}
