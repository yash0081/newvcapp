"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileText, Loader2, Plus, Search, UploadCloud } from "lucide-react";
import { SelectBox } from "@/components/ui/select-box";
import { documentOutputFormatLabel } from "@/lib/document-generation/output-format-label";

type DealOption = { id: string; name: string };

type DocType = {
  id: string;
  name: string;
  output_format: "markdown" | "docx" | "pdf" | "text";
  description: string;
  instructions: string;
  learned_preferences: string;
  updated_at: string;
};

type Reference = {
  id: string;
  kind: string;
  filename: string | null;
  content: string;
  created_at: string;
};

type MissingInfo = { field: string; reason: string; importance: "high" | "medium" | "low" };
type ResearchStep = { task: string; sourceHint: string; reason: string };
type Preflight = {
  enoughInfo: boolean;
  rationale: string;
  missingInfo: MissingInfo[];
  researchSteps: ResearchStep[];
};

type Draft = {
  id: string;
  title: string;
  prompt: string;
  content: string;
  status: string;
  missing_info: MissingInfo[];
  research_steps: ResearchStep[];
  created_at: string;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

export function DocumentGenerator({ deals, initialDealId }: { deals: DealOption[]; initialDealId?: string }) {
  const [types, setTypes] = useState<DocType[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState("");
  const [selectedDealId, setSelectedDealId] = useState(initialDealId || deals[0]?.id || "");
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeFormat, setNewTypeFormat] = useState<DocType["output_format"]>("text");
  const [newTypeDescription, setNewTypeDescription] = useState("");
  const [newTypeInstructions, setNewTypeInstructions] = useState("");
  const [refKind, setRefKind] = useState("description");
  const [refText, setRefText] = useState("");
  const [refFile, setRefFile] = useState<File | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [prompt, setPrompt] = useState("");
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedType = useMemo(() => types.find((t) => t.id === selectedTypeId) ?? null, [types, selectedTypeId]);

  async function loadTypes() {
    const data = await jsonFetch<{ types: DocType[] }>("/api/document-generation/types");
    setTypes(data.types ?? []);
    setSelectedTypeId((prev) => prev || data.types?.[0]?.id || "");
  }

  async function loadReferences(typeId: string) {
    if (!typeId) {
      setReferences([]);
      return;
    }
    const data = await jsonFetch<{ references: Reference[] }>(`/api/document-generation/types/${typeId}/references`);
    setReferences(data.references ?? []);
  }

  useEffect(() => {
    void loadTypes().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    void loadReferences(selectedTypeId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selectedTypeId]);

  async function createType() {
    setBusy("type");
    setError(null);
    setMessage(null);
    try {
      const data = await jsonFetch<{ type: DocType }>("/api/document-generation/types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTypeName,
          outputFormat: newTypeFormat,
          description: newTypeDescription,
          instructions: newTypeInstructions,
        }),
      });
      setTypes((prev) => [data.type, ...prev]);
      setSelectedTypeId(data.type.id);
      setNewTypeName("");
      setNewTypeFormat("text");
      setNewTypeDescription("");
      setNewTypeInstructions("");
      setMessage("Document type saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addReference() {
    if (!selectedTypeId) return;
    setBusy("reference");
    setError(null);
    setMessage(null);
    try {
      let init: RequestInit;
      if (refFile) {
        const fd = new FormData();
        fd.set("kind", refKind);
        fd.set("file", refFile);
        init = { method: "POST", body: fd };
      } else {
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: refKind, content: refText }),
        };
      }
      await jsonFetch(`/api/document-generation/types/${selectedTypeId}/references`, init);
      setRefText("");
      setRefFile(null);
      await loadReferences(selectedTypeId);
      setMessage("Reference saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runPreflight() {
    if (!selectedTypeId || !prompt.trim()) return;
    setBusy("preflight");
    setError(null);
    setMessage(null);
    try {
      const data = await jsonFetch<{ preflight: Preflight }>("/api/document-generation/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeId: selectedTypeId, dealId: selectedDealId || null, prompt }),
      });
      setPreflight(data.preflight);
      setMessage(data.preflight.enoughInfo ? "Looks ready to generate." : "This may need a little more research first.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function generate(skipResearch = false) {
    if (!selectedTypeId || !prompt.trim()) return;
    setBusy("generate");
    setError(null);
    setMessage(null);
    try {
      const data = await jsonFetch<{ draft?: Draft; preflight?: Preflight; needsResearch?: boolean }>("/api/document-generation/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typeId: selectedTypeId, dealId: selectedDealId || null, prompt, skipResearch }),
      });
      if (data.needsResearch && data.preflight) {
        setPreflight(data.preflight);
        setMessage("Research is recommended before generating.");
        return;
      }
      setDraft(data.draft ?? null);
      setPreflight(data.preflight ?? null);
      setMessage("Draft generated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function revise() {
    if (!draft || !revision.trim()) return;
    setBusy("revision");
    setError(null);
    setMessage(null);
    try {
      const data = await jsonFetch<{ result: { title: string; content: string; savedPreference: string | null } }>(
        `/api/document-generation/drafts/${draft.id}/revise`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: revision }),
        }
      );
      setDraft({ ...draft, title: data.result.title, content: data.result.content });
      setRevision("");
      if (data.result.savedPreference) await loadTypes();
      setMessage(data.result.savedPreference ? "Draft revised and reusable guidance saved." : "Draft revised.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="crm-panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
              <FileText className="h-4 w-4 text-zinc-700" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-zinc-950">Documents</h1>
              <p className="text-sm text-zinc-500">Reusable document types, references, and generation workflow.</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:w-[420px]">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Types</p>
              <p className="text-sm font-semibold text-zinc-950">{types.length}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Guidance</p>
              <p className="text-sm font-semibold text-zinc-950">{references.length}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Output</p>
              <p className="text-sm font-semibold text-zinc-950">{documentOutputFormatLabel(selectedType?.output_format)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          <section className="crm-panel p-4">
            <p className="crm-kicker">Document type</p>
            <h2 className="mt-1 text-sm font-semibold text-zinc-950">Saved recipe</h2>
            <SelectBox wrapperClassName="mt-3" value={selectedTypeId} onChange={(e) => setSelectedTypeId(e.target.value)}>
              <option value="">Choose a type</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({documentOutputFormatLabel(t.output_format)})
                </option>
              ))}
            </SelectBox>
            {selectedType ? (
              <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
                <p className="font-semibold text-zinc-900">{selectedType.name}</p>
                <p className="mt-1">{selectedType.description || "No description yet."}</p>
                {selectedType.learned_preferences ? <p className="mt-2 whitespace-pre-wrap border-t border-zinc-200 pt-2">{selectedType.learned_preferences}</p> : null}
              </div>
            ) : null}
          </section>

          <section className="crm-panel p-4">
            <p className="crm-kicker">Create type</p>
            <div className="mt-3 space-y-2">
              <input className="crm-input" value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} placeholder="Type name, e.g. IC memo" />
              <SelectBox value={newTypeFormat} onChange={(e) => setNewTypeFormat(e.target.value as DocType["output_format"])}>
                <option value="docx">Word document</option>
                <option value="pdf">PDF</option>
                <option value="text">Plain text</option>
              </SelectBox>
              <textarea className="crm-input min-h-20" value={newTypeDescription} onChange={(e) => setNewTypeDescription(e.target.value)} placeholder="When should this type be used?" />
              <textarea className="crm-input min-h-24" value={newTypeInstructions} onChange={(e) => setNewTypeInstructions(e.target.value)} placeholder="Reusable rules: sections, tone, length, formatting" />
              <button className="crm-button w-full" type="button" disabled={busy === "type" || !newTypeName.trim()} onClick={createType}>
                {busy === "type" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Save type
              </button>
            </div>
          </section>

          <section className="crm-panel p-4">
            <p className="crm-kicker">Type guidance</p>
            <p className="mt-1 text-xs text-zinc-500">Saved templates, samples, or writing rules that shape this document type.</p>
            <div className="mt-3 space-y-2">
              <SelectBox value={refKind} onChange={(e) => setRefKind(e.target.value)}>
                <option value="description">Description</option>
                <option value="template">Template</option>
                <option value="sample">Sample</option>
                <option value="notes">Notes</option>
              </SelectBox>
              <textarea className="crm-input min-h-24" value={refText} onChange={(e) => setRefText(e.target.value)} placeholder="Paste reusable type guidance, a template, or an example" />
              <label className="crm-button-secondary w-full cursor-pointer">
                <UploadCloud className="h-4 w-4" />
                <span className="truncate">{refFile ? refFile.name : "Upload reference"}</span>
                <input className="hidden" type="file" accept=".pdf,.txt,.md,.csv,.json,.html,application/pdf,text/plain,text/markdown,text/csv,application/json,text/html" onChange={(e) => setRefFile(e.target.files?.[0] ?? null)} />
              </label>
              <button className="crm-button-secondary w-full" type="button" disabled={busy === "reference" || !selectedTypeId || (!refText.trim() && !refFile)} onClick={addReference}>
                Add reference
              </button>
            </div>
            <div className="mt-3 max-h-48 space-y-2 overflow-auto">
              {references.map((r) => (
                <div key={r.id} className="rounded-xl border border-zinc-200 bg-white p-2 text-xs">
                  <p className="font-medium text-zinc-800">{r.kind}{r.filename ? ` / ${r.filename}` : ""}</p>
                  <p className="mt-1 max-h-10 overflow-hidden whitespace-pre-wrap text-zinc-500">{r.content}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <main className="space-y-4">
          <section className="crm-panel p-5">
            <div className="flex flex-col gap-3 border-b border-zinc-100 pb-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="crm-kicker">Generate</p>
                <h2 className="mt-1 text-base font-semibold text-zinc-950">One document</h2>
                <p className="mt-1 text-sm text-zinc-500">The type controls format and structure; the prompt is for this specific deliverable.</p>
              </div>
              {selectedType ? (
                <span className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-700">
                  {selectedType.name} / {documentOutputFormatLabel(selectedType.output_format)}
                </span>
              ) : null}
            </div>
            <div className="mt-4 space-y-3">
              <SelectBox value={selectedDealId} onChange={(e) => setSelectedDealId(e.target.value)}>
                <option value="">No company selected</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </SelectBox>
              <textarea className="crm-input min-h-32" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Specific request, e.g. Draft the memo for Acme focused on enterprise traction and founder-market fit." />
              <div className="flex flex-wrap gap-2">
                <button className="crm-button-secondary" type="button" disabled={!selectedTypeId || !prompt.trim() || busy === "preflight"} onClick={runPreflight}>
                  {busy === "preflight" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Check info
                </button>
                <button className="crm-button" type="button" disabled={!selectedTypeId || !prompt.trim() || busy === "generate"} onClick={() => generate(false)}>
                  {busy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  Generate
                </button>
              </div>
              {message ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
              {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
            </div>
          </section>

          {preflight && !preflight.enoughInfo ? (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-amber-800" />
                <h2 className="text-sm font-semibold text-amber-950">Research recommended</h2>
              </div>
              <p className="mt-2 text-sm text-amber-900">{preflight.rationale}</p>
              {preflight.missingInfo.length ? (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {preflight.missingInfo.map((m, i) => (
                    <div key={`${m.field}_${i}`} className="rounded-xl border border-amber-200 bg-white/80 p-2 text-xs">
                      <p className="font-medium text-zinc-800">{m.field} ({m.importance})</p>
                      <p className="mt-1 text-zinc-500">{m.reason}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {preflight.researchSteps.map((s, i) => (
                  <div key={`${s.task}_${i}`} className="rounded-xl border border-amber-200 bg-white/80 p-2 text-xs">
                    <p className="font-medium text-zinc-800">{s.task}</p>
                    <p className="mt-1 text-zinc-500">{s.sourceHint} / {s.reason}</p>
                  </div>
                ))}
              </div>
              <button className="crm-button-secondary mt-3" type="button" onClick={() => generate(true)}>
                Generate anyway
              </button>
            </section>
          ) : null}

          {draft ? (
            <section className="crm-panel p-5">
              <div className="flex flex-col gap-3 border-b border-zinc-100 pb-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    <h2 className="text-base font-semibold text-zinc-950">{draft.title}</h2>
                  </div>
                  {selectedType ? <p className="mt-1 text-xs text-zinc-500">Preview for {documentOutputFormatLabel(selectedType.output_format)} output.</p> : null}
                </div>
                <a className="crm-button-secondary" href={`/home/generated-documents/${draft.id}`} target="_blank" rel="noreferrer">
                  Open document
                </a>
              </div>
              <div className="mt-4 max-h-[640px] overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm leading-relaxed text-zinc-900 whitespace-pre-wrap">
                {draft.content}
              </div>
              <div className="mt-3 grid gap-2">
                <textarea className="crm-input min-h-20" value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Ask for changes. Reusable feedback can be saved to this document type." />
                <button className="crm-button-secondary w-fit" type="button" disabled={!revision.trim() || busy === "revision"} onClick={revise}>
                  {busy === "revision" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Revise draft
                </button>
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
