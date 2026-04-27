"use client";

import { useState, useTransition } from "react";

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

      {docs.length === 0 ? (
        <p className="text-sm text-zinc-500">No documents yet.</p>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="rounded-xl border border-zinc-200 bg-white px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{d.original_filename || d.id}</div>
                <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-zinc-200 px-2 py-0.5">
                    {d.status}
                  </span>
                  <span>{new Date(d.created_at).toLocaleString()}</span>
                </div>
              </div>
              <button onClick={() => openPdf(d.id)} className="text-xs rounded-lg border border-zinc-200 px-2 py-1 hover:bg-zinc-50">
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
          ))}
        </div>
      )}
    </div>
  );
}

