"use client";

import { useState, useTransition } from "react";

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
    const isResearchStepOutput = doc?.mime_type === "text/markdown";
    window.open(isResearchStepOutput ? `/home/research-documents/${documentId}` : `/home/documents/${documentId}`, "_blank", "noopener,noreferrer");
  }

  function displayStatus(s: string): string {
    if (s === "ready") return "ready";
    if (s === "claims_extracted") return "ready";
    if (s === "error") return "error";
    return "processing";
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

  const folders = Array.from(
    new Set(
      (docs ?? [])
        .map((d) => d.folder_path || "")
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  // Normalize legacy folder paths that may have been created earlier (e.g. "web/research").
  const normalizedFolders = folders.map((f) => (f === "web/research" ? "Web research" : f));

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

  const visibleDocs = docs.filter((d) => {
    const fp = d.folder_path === "web/research" ? "Web research" : (d.folder_path || "Company documents");
    return fp === activeFolder;
  });

  function folderButtonClass(name: string) {
    const active = activeFolder === name;
    return [
      "w-full text-left text-sm rounded-lg border px-3 py-2",
      "min-w-0 overflow-hidden",
      active ? "border-zinc-400 ring-2 ring-zinc-300 bg-zinc-50" : "border-zinc-200 hover:bg-zinc-50",
    ].join(" ");
  }

  return (
    <div className="space-y-4 w-full">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900">Upload a PDF</p>
          <p className="text-xs text-zinc-500 mt-1">We’ll parse it fast and improve in the background.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="crm-button-secondary cursor-pointer">
            <span className="truncate max-w-[240px]">{file ? file.name : "Choose PDF…"}</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
          </label>
          {file ? (
            <button type="button" onClick={() => setFile(null)} className="text-xs text-zinc-500 hover:text-zinc-800">
              Clear
            </button>
          ) : null}
          <button disabled={busy != null || isPending} onClick={upload} className="crm-button">
            {busy === "upload" ? "Uploading…" : busy?.startsWith("ingest:") ? "Processing…" : "Upload"}
          </button>
        </div>
      </div>

      {err && <div className="text-sm text-red-600">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr] w-full">
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
          <p className="text-sm font-medium text-zinc-900">Folders</p>
          <button
            type="button"
            className={folderButtonClass("Company documents")}
            onClick={() => setActiveFolder("Company documents")}
          >
            <span className="block truncate">Company documents</span>
          </button>
          <button
            type="button"
            className={folderButtonClass("Web research")}
            onClick={() => setActiveFolder("Web research")}
          >
            <span className="block truncate">Web research</span>
          </button>
          {normalizedFolders.filter((f) => f !== "Company documents" && f !== "Web research").map((f) => (
            <button
              key={f}
              type="button"
              className={folderButtonClass(f)}
              onClick={() => setActiveFolder(f)}
            >
              <span className="block truncate">{f}</span>
            </button>
          ))}

          <div className="pt-2 border-t border-zinc-100 space-y-2">
            <p className="text-xs text-zinc-500">Create subfolder inside current</p>
            <div className="flex gap-2">
              <input className="crm-input flex-1" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="e.g. competitors" />
              <button className="crm-button-secondary" type="button" onClick={addFolder} disabled={!newFolderName.trim()}>
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-2 w-full min-w-0">
          {visibleDocs.length === 0 ? (
            <p className="text-sm text-zinc-500 rounded-2xl border border-dashed border-zinc-200 bg-white p-8 text-center">
              No documents in this folder yet.
            </p>
          ) : (
            visibleDocs.map((d) => (
              <div
                key={d.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 flex items-center gap-3 w-full min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{d.original_filename || d.id}</div>
                  <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full border border-zinc-200 px-2 py-0.5">
                      {displayStatus(d.status)}
                    </span>
                    <span>{new Date(d.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <button onClick={() => openDocument(d.id, d)} className="text-xs rounded-lg border border-zinc-200 px-2 py-1 hover:bg-zinc-50">
                  Open
                </button>
                <button
                  disabled={busy != null || isPending}
                  onClick={() => deleteDoc(d.id)}
                  className="text-xs rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                >
                  {busy === `delete:${d.id}` ? "Deleting…" : "Delete"}
                </button>
              </div>
            ))
          )}
          <div className="rounded-2xl border border-zinc-200 bg-white p-4">
            <p className="text-xs text-zinc-500 mb-2">Drop documents here to move to: <span className="font-medium text-zinc-700">{activeFolder}</span></p>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                if (id) void moveDoc(id, activeFolder);
              }}
              className="rounded-xl border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500"
            >
              Drag a document row and drop.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

