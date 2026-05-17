"use client";

import { useState, useTransition } from "react";
import { FileText, Folder, FolderPlus, GripVertical, UploadCloud } from "lucide-react";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
  source_kind?: string | null;
  mime_type?: string | null;
  status: string;
  created_at: string;
};

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as Record<string, unknown>;
}

export function CompanyDocuments(props: { dealId: string; initialDocs: DocRow[] }) {
  const { dealId } = props;
  const [docs, setDocs] = useState<DocRow[]>(props.initialDocs);
  const [file, setFile] = useState<File | null>(null);
  const [activeFolder, setActiveFolder] = useState<string>("Company documents");
  const [newFolderName, setNewFolderName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function refreshDocs() {
    const res = await fetch(`/api/crm/companies/${dealId}/documents`, { method: "GET" });
    const data = (await res.json().catch(() => ({}))) as { documents?: DocRow[] };
    if (Array.isArray(data.documents)) setDocs(data.documents);
  }

  async function upload() {
    setErr(null);
    if (!file) {
      setErr("Choose a PDF first.");
      return;
    }
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folderPath", activeFolder);
      const res = await fetch(`/api/crm/companies/${dealId}/documents/upload`, { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { documentId?: string; error?: string };
      if (!res.ok || !data.documentId) throw new Error(data.error || "Upload failed");
      await refreshDocs();
      setFile(null);
      // Fast ingest: parse + chunk (limited embeddings) + schema-facts ingest (enqueues enrichment).
      await runFast(data.documentId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runFast(documentId: string) {
    setErr(null);
    setBusy(`ingest:${documentId}`);
    try {
      await postJson(`/api/crm/documents/${documentId}/parse`);
      await postJson(`/api/crm/documents/${documentId}/chunk`);
      await postJson(`/api/crm/documents/${documentId}/ingest-deal-intel`);
      await refreshDocs();
      startTransition(() => {
        // cheap refresh of the page server component (user can also reload)
        window.location.reload();
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openPdf(documentId: string) {
    setErr(null);
    try {
      const res = await fetch(`/api/crm/documents/${documentId}/signed-url`, { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { signedUrl?: string; error?: string };
      if (!res.ok || !data.signedUrl) throw new Error(data.error || "Failed to sign URL");
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function openDocument(documentId: string, doc?: DocRow) {
    const mime = (doc?.mime_type || "").toLowerCase();
    const sourceKind = (doc?.source_kind || "").toLowerCase();
    const isPdf = mime.includes("pdf") || sourceKind === "pitch_deck" || sourceKind === "investment_criteria";
    if (isPdf) {
      void openPdf(documentId);
      return;
    }
    // Research-step outputs render a specialized view with citations; other non-PDFs use the generic full-text viewer.
    const isResearchStepOutput =
      doc?.mime_type === "text/markdown" ||
      (doc?.mime_type === "text/plain" && doc?.source_kind === "web");
    window.open(isResearchStepOutput ? `/home/research-documents/${documentId}` : `/home/documents/${documentId}`, "_blank", "noopener,noreferrer");
  }

  function displayStatus(s: string): string {
    if (s === "ready") return "ready";
    if (s === "claims_extracted") return "ready";
    if (s === "error") return "error";
    return "processing";
  }

  function isResearchArtifact(doc: DocRow): boolean {
    const folder = (doc.folder_path || "").toLowerCase();
    const source = (doc.source_kind || "").toLowerCase();
    const mime = (doc.mime_type || "").toLowerCase();
    return folder === "web/research" || source === "web" || mime === "text/markdown";
  }

  async function deleteDoc(documentId: string) {
    setErr(null);
    const ok = window.confirm("Delete this PDF? This removes it from storage and the database.");
    if (!ok) return;
    setBusy(`delete:${documentId}`);
    try {
      const res = await fetch(`/api/crm/documents/${documentId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Delete failed");
      await refreshDocs();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const libraryDocs = docs.filter((doc) => !isResearchArtifact(doc));

  const folders = Array.from(
    new Set(
      (libraryDocs ?? [])
        .map((d) => d.folder_path || "")
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  function ensureFolderPath(raw: string): string {
    const s = raw.trim().replaceAll(/\/+/g, "/").replaceAll(/^\/|\/$/g, "");
    return s || "Company documents";
  }

  function addFolder() {
    const name = ensureFolderPath(`${activeFolder}/${newFolderName}`);
    setNewFolderName("");
    if (!folders.includes(name)) {
      setActiveFolder(name);
    } else {
      setActiveFolder(name);
    }
  }

  async function moveDoc(documentId: string, folderPath: string) {
    await fetch(`/api/crm/documents/${documentId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath }),
    });
    await refreshDocs();
  }

  const visibleDocs = libraryDocs.filter((d) => {
    const fp = d.folder_path || "Company documents";
    return fp === activeFolder;
  });

  function folderButtonClass(name: string) {
    const active = activeFolder === name;
    return [
      "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm",
      "min-w-0 overflow-hidden transition-colors",
      active ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100",
    ].join(" ");
  }

  return (
    <div className="w-full h-full flex flex-col space-y-4 select-none font-sans overflow-hidden min-h-0">
      {/* Upload Box */}
      <div className="border border-zinc-200 bg-zinc-50/50 p-4 rounded-2xl shrink-0">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <UploadCloud className="h-4 w-4 text-zinc-500" />
              <p className="text-xs font-bold uppercase tracking-wider text-zinc-950">Upload PDF Artifact</p>
            </div>
            <p className="mt-1 text-xs text-zinc-500">Parsed immediately, then enriched in the background.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 border border-zinc-200 bg-white px-4 text-xs font-bold uppercase tracking-wider text-zinc-800 hover:bg-zinc-50 transition-colors rounded-xl shadow-sm">
              <span className="truncate max-w-[240px]">{file ? file.name : "Choose PDF…"}</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </label>
            {file && (
              <button type="button" onClick={() => setFile(null)} className="text-xs font-bold uppercase tracking-wider text-zinc-400 hover:text-zinc-800 px-2">
                Clear
              </button>
            )}
            <button
              disabled={busy != null || isPending}
              onClick={upload}
              className="inline-flex h-9 items-center justify-center gap-2 bg-zinc-950 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-md shadow-zinc-950/10 hover:bg-zinc-900 rounded-xl transition-colors"
            >
              {busy === "upload" ? "Uploading…" : busy?.startsWith("ingest:") ? "Processing…" : "Upload"}
            </button>
          </div>
        </div>
      </div>

      {err && <div className="border border-rose-250 bg-rose-50 px-4 py-3 rounded-xl text-xs text-rose-800 font-semibold">{err}</div>}

      <div className="grid w-full gap-5 lg:grid-cols-[280px_1fr] flex-1 min-h-0">
        {/* Folders Aside */}
        <div className="border border-zinc-200 bg-white p-4 shadow-sm rounded-2xl flex flex-col h-full overflow-y-auto shrink-0">
          <div className="mb-3 flex items-center gap-2 border-b border-zinc-100 pb-2">
            <Folder className="h-4 w-4 text-zinc-500" />
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-950">Folders</p>
          </div>
          <div className="space-y-1.5">
            <button
              type="button"
              className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide border rounded-xl transition-all ${
                activeFolder === "Company documents"
                  ? "bg-zinc-950 border-zinc-950 text-white shadow-sm"
                  : "bg-white border-zinc-200/50 text-zinc-650 hover:bg-zinc-50 hover:text-zinc-950"
              }`}
              onClick={() => setActiveFolder("Company documents")}
            >
              <Folder className="h-4 w-4 shrink-0 opacity-80" />
              <span className="block truncate">Company documents</span>
            </button>
            {folders.filter((f) => f !== "Company documents").map((f) => (
              <button
                key={f}
                type="button"
                className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide border rounded-xl transition-all ${
                  activeFolder === f
                    ? "bg-zinc-950 border-zinc-950 text-white shadow-sm"
                    : "bg-white border-zinc-200/50 text-zinc-650 hover:bg-zinc-50 hover:text-zinc-950"
                }`}
                onClick={() => setActiveFolder(f)}
              >
                <Folder className="h-4 w-4 shrink-0 opacity-80" />
                <span className="block truncate">{f}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-2 border-t border-zinc-150 pt-4">
            <p className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider text-zinc-400">
              <FolderPlus className="h-3.5 w-3.5" />
              Create Subfolder
            </p>
            <div className="flex gap-2">
              <input
                className="w-full border border-zinc-200 bg-white px-3 py-2 rounded-xl text-xs text-zinc-900 outline-none focus:border-zinc-400 transition-all font-medium"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="e.g. competitor-study"
              />
              <button
                className="inline-flex h-9 items-center justify-center border border-zinc-250 bg-white px-3 text-xs font-bold uppercase tracking-wider text-zinc-700 hover:bg-zinc-50 rounded-xl active:scale-95 transition-all shadow-sm"
                type="button"
                onClick={addFolder}
                disabled={!newFolderName.trim()}
              >
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Documents Main List */}
        <div className="min-w-0 flex-1 flex flex-col space-y-3 h-full overflow-y-auto pr-1">
          {visibleDocs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/50 p-12 text-center text-xs text-zinc-500 font-bold uppercase tracking-wider">
              <FileText className="mx-auto mb-3 h-5 w-5 text-zinc-400" />
              No documents in this folder yet.
            </div>
          ) : (
            visibleDocs.map((d) => (
              <div
                key={d.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
                className="flex w-full min-w-0 items-center gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm hover:border-zinc-350 transition-colors"
              >
                <GripVertical className="h-4 w-4 shrink-0 text-zinc-300 cursor-grab active:cursor-grabbing" />
                <FileText className="h-4 w-4 shrink-0 text-zinc-650" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-zinc-950 uppercase tracking-wide">{d.original_filename || d.id}</div>
                  <div className="mt-1 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-450">
                    <span className={`px-1.5 py-0.5 rounded-full border text-[9px] font-extrabold uppercase tracking-widest ${
                      d.status === "ready" || d.status === "claims_extracted"
                        ? "border-zinc-950 bg-zinc-950 text-white"
                        : d.status === "error"
                        ? "border-rose-300 bg-rose-50 text-rose-800"
                        : "border-zinc-200 bg-zinc-50 text-zinc-650 animate-pulse"
                    }`}>
                      {displayStatus(d.status)}
                    </span>
                    <span>{new Date(d.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <button
                  onClick={() => openDocument(d.id, d)}
                  className="inline-flex h-7 items-center justify-center border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-800 hover:bg-zinc-50 rounded-xl active:scale-95 transition-all shadow-sm"
                >
                  Open
                </button>
                <button
                  disabled={busy != null || isPending}
                  onClick={() => deleteDoc(d.id)}
                  className="inline-flex h-7 items-center justify-center border border-rose-200 bg-rose-50 px-3 text-[10px] font-bold uppercase tracking-wider text-rose-700 hover:bg-rose-100 rounded-xl active:scale-95 transition-all disabled:opacity-50"
                >
                  {busy === `delete:${d.id}` ? "Deleting…" : "Delete"}
                </button>
              </div>
            ))
          )}

          {/* Drag & Drop Target */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm space-y-2.5">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-zinc-400">
              Drag & Drop Management Panel
            </p>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                if (id) void moveDoc(id, activeFolder);
              }}
              className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 p-6 text-center text-xs text-zinc-500 font-semibold uppercase tracking-wider"
            >
              Drag a document row above and drop here to move to folder: <span className="font-bold text-zinc-950">{activeFolder}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
