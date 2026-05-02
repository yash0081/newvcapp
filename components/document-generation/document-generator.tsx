"use client";

import { useEffect, useMemo, useState } from "react";

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
  const [newTypeFormat, setNewTypeFormat] = useState<DocType["output_format"]>("markdown");
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
      setNewTypeFormat("markdown");
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
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <aside className="space-y-4">
        <section className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Step 1</p>
            <h2 className="text-sm font-semibold text-zinc-900">Choose a reusable document type</h2>
            <p className="text-xs text-zinc-500">A type is the saved recipe: output format, structure, tone, examples, and learned preferences.</p>
          </div>
          <select className="crm-input" value={selectedTypeId} onChange={(e) => setSelectedTypeId(e.target.value)}>
            <option value="">Choose a type</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.output_format.toUpperCase()})
              </option>
            ))}
          </select>
          {selectedType ? (
            <div className="rounded-md bg-zinc-50 p-3 text-xs text-zinc-600 space-y-2">
              <p className="font-medium text-zinc-800">{selectedType.name} - {selectedType.output_format.toUpperCase()}</p>
              <p>{selectedType.description || "No description yet."}</p>
              {selectedType.learned_preferences ? <p className="whitespace-pre-wrap">{selectedType.learned_preferences}</p> : null}
            </div>
          ) : null}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Create a new type</h2>
            <p className="text-xs text-zinc-500">Use this when you want to make the same kind of document again later.</p>
          </div>
          <input className="crm-input" value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} placeholder="Type name, e.g. IC memo" />
          <select className="crm-input" value={newTypeFormat} onChange={(e) => setNewTypeFormat(e.target.value as DocType["output_format"])}>
            <option value="markdown">Markdown</option>
            <option value="docx">Word document</option>
            <option value="pdf">PDF</option>
            <option value="text">Plain text</option>
          </select>
          <textarea className="crm-input min-h-20" value={newTypeDescription} onChange={(e) => setNewTypeDescription(e.target.value)} placeholder="When should this type be used?" />
          <textarea className="crm-input min-h-24" value={newTypeInstructions} onChange={(e) => setNewTypeInstructions(e.target.value)} placeholder="Reusable rules: sections, tone, length, formatting, must-have content" />
          <button className="crm-button w-full" type="button" disabled={busy === "type" || !newTypeName.trim()} onClick={createType}>
            {busy === "type" ? "Saving..." : "Save document type"}
          </button>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Step 2</p>
            <h2 className="text-sm font-semibold text-zinc-900">Add references to this type</h2>
            <p className="text-xs text-zinc-500">These are reusable examples or instructions for the selected type, not one-off context for a single generated document.</p>
          </div>
          <select className="crm-input" value={refKind} onChange={(e) => setRefKind(e.target.value)}>
            <option value="description">Description</option>
            <option value="template">Template</option>
            <option value="sample">Sample</option>
            <option value="notes">Notes</option>
          </select>
          <textarea className="crm-input min-h-24" value={refText} onChange={(e) => setRefText(e.target.value)} placeholder="Paste reusable type guidance, a template, or an example" />
          <input className="text-xs" type="file" accept=".pdf,.txt,.md,.csv,.json,.html,application/pdf,text/plain,text/markdown,text/csv,application/json,text/html" onChange={(e) => setRefFile(e.target.files?.[0] ?? null)} />
          <button className="crm-button-secondary w-full" type="button" disabled={busy === "reference" || !selectedTypeId || (!refText.trim() && !refFile)} onClick={addReference}>
            Add reference
          </button>
          <div className="space-y-2 max-h-48 overflow-auto">
            {references.map((r) => (
              <div key={r.id} className="rounded-md border border-zinc-200 p-2 text-xs">
                <p className="font-medium text-zinc-700">{r.kind}{r.filename ? ` - ${r.filename}` : ""}</p>
                <p className="text-zinc-500 whitespace-pre-wrap max-h-10 overflow-hidden">{r.content}</p>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <main className="space-y-4">
        <section className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Step 3</p>
            <h1 className="text-lg font-semibold text-zinc-900">Generate one document</h1>
            <p className="text-xs text-zinc-500">
              This prompt is for the specific document you need now. The selected type supplies the reusable format and reference examples.
            </p>
          </div>
          {selectedType ? (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
              Using type: <span className="font-medium text-zinc-900">{selectedType.name}</span> - Output:{" "}
              <span className="font-medium text-zinc-900">{selectedType.output_format.toUpperCase()}</span>
            </div>
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Choose or create a document type first.
            </div>
          )}
          <select className="crm-input" value={selectedDealId} onChange={(e) => setSelectedDealId(e.target.value)}>
            <option value="">No company selected</option>
            {deals.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <textarea className="crm-input min-h-28" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Specific request for this document, e.g. Draft the memo for Acme focused on enterprise traction and founder-market fit." />
          <div className="flex flex-wrap gap-2">
            <button className="crm-button-secondary" type="button" disabled={!selectedTypeId || !prompt.trim() || busy === "preflight"} onClick={runPreflight}>
              Check info and suggest research
            </button>
            <button className="crm-button" type="button" disabled={!selectedTypeId || !prompt.trim() || busy === "generate"} onClick={() => generate(false)}>
              {busy === "generate" ? "Generating..." : "Generate"}
            </button>
          </div>
          {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
          {error ? <p className="text-sm text-rose-700">{error}</p> : null}
        </section>

        {preflight && !preflight.enoughInfo ? (
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-amber-950">Research recommended</h2>
            <p className="text-sm text-amber-900">{preflight.rationale}</p>
            {preflight.missingInfo.length ? (
              <div className="grid gap-2 md:grid-cols-2">
                {preflight.missingInfo.map((m, i) => (
                  <div key={`${m.field}_${i}`} className="rounded-md border border-amber-200 bg-white/70 p-2 text-xs">
                    <p className="font-medium text-zinc-800">{m.field} ({m.importance})</p>
                    <p className="text-zinc-500">{m.reason}</p>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="grid gap-2 md:grid-cols-2">
              {preflight.researchSteps.map((s, i) => (
                <div key={`${s.task}_${i}`} className="rounded-md border border-amber-200 bg-white/70 p-2 text-xs">
                  <p className="font-medium text-zinc-800">{s.task}</p>
                  <p className="text-zinc-500">{s.sourceHint} - {s.reason}</p>
                </div>
              ))}
            </div>
            <button className="crm-button-secondary" type="button" onClick={() => generate(true)}>
              Generate anyway
            </button>
          </section>
        ) : null}

        {draft ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-900">{draft.title}</h2>
              {selectedType ? <p className="text-xs text-zinc-500">Preview for {selectedType.output_format.toUpperCase()} output.</p> : null}
            </div>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed max-h-[640px] overflow-auto">
              {draft.content}
            </div>
            <div className="grid gap-2">
              <textarea className="crm-input min-h-20" value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Ask for changes. Reusable style/structure feedback may be saved to this document type." />
              <button className="crm-button-secondary w-fit" type="button" disabled={!revision.trim() || busy === "revision"} onClick={revise}>
                {busy === "revision" ? "Revising..." : "Revise draft"}
              </button>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
