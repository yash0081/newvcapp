"use client";

import { useMemo, useState, useTransition } from "react";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
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
  const [folderPath, setFolderPath] = useState<string>("decks/");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const byFolder = useMemo(() => {
    const m = new Map<string, DocRow[]>();
    for (const d of docs) {
      const fp = (d.folder_path || "").trim() || "(root)";
      if (!m.has(fp)) m.set(fp, []);
      m.get(fp)!.push(d);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [docs]);

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
      fd.append("folderPath", folderPath);
      const res = await fetch(`/api/crm/companies/${dealId}/documents/upload`, { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { documentId?: string; error?: string };
      if (!res.ok || !data.documentId) throw new Error(data.error || "Upload failed");
      await refreshDocs();
      setFile(null);
      // Auto-run ingestion after upload (per CRM UX requirement).
      await runAll(data.documentId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runAll(documentId: string) {
    setErr(null);
    setBusy(`ingest:${documentId}`);
    try {
      await postJson(`/api/crm/documents/${documentId}/parse`);
      await postJson(`/api/crm/documents/${documentId}/chunk`);
      await postJson(`/api/crm/documents/${documentId}/ingest-deal-intel`);
      await postJson(`/api/crm/documents/${documentId}/extract-claims`);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row gap-2 md:items-end">
        <div className="flex-1 min-w-0">
          <label className="block text-xs text-zinc-600 mb-1">Folder</label>
          <input
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            className="crm-input"
            placeholder="decks/"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="block text-xs text-zinc-600 mb-1">PDF</label>
          <div className="flex items-center gap-2">
            <label className="crm-button-secondary cursor-pointer">
              <span className="truncate max-w-[220px]">
                {file ? file.name : "Choose PDF…"}
              </span>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </label>
            {file && (
              <button
                type="button"
                onClick={() => setFile(null)}
                className="text-xs text-zinc-500 hover:text-zinc-800"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <button
          disabled={busy != null || isPending}
          onClick={upload}
          className="crm-button"
        >
          {busy === "upload" ? "Uploading…" : "Upload"}
        </button>
      </div>

      {err && <div className="text-sm text-red-600">{err}</div>}

      {byFolder.length === 0 ? (
        <p className="text-sm text-zinc-500">No documents yet.</p>
      ) : (
        <div className="space-y-4">
          {byFolder.map(([folder, rows]) => (
            <div key={folder} className="space-y-2">
              <div className="text-xs font-semibold text-zinc-700">{folder}</div>
              <div className="space-y-2">
                {rows.map((d) => (
                  <div key={d.id} className="rounded-xl border border-zinc-200 bg-white px-3 py-2 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{d.original_filename || d.id}</div>
                      <div className="text-xs text-zinc-500">
                        {d.status} • {new Date(d.created_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      onClick={() => openPdf(d.id)}
                      className="text-xs rounded-lg border border-zinc-200 px-2 py-1 hover:bg-zinc-50"
                    >
                      Open
                    </button>
                    <button
                      disabled={busy != null || isPending}
                      onClick={() => deleteDoc(d.id)}
                      className="text-xs rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      {busy === `delete:${d.id}` ? "Deleting…" : "Delete"}
                    </button>
                    <div className="text-xs text-zinc-500">
                      {busy === `ingest:${d.id}` ? "Ingesting…" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

