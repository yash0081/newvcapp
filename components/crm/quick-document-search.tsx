"use client";

import { useEffect, useState } from "react";
import { FileText, Folder, GripVertical, Search, X, PanelLeftClose, ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/utils";

type DocRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
};

export function QuickDocumentSearch({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/crm/companies/${dealId}/documents`);
        const data = (await res.json().catch(() => ({}))) as { documents?: DocRow[] };
        if (Array.isArray(data.documents)) setDocs(data.documents);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [dealId]);

  const filteredDocs = docs.filter((doc) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (doc.original_filename || doc.id).toLowerCase().includes(q) || (doc.folder_path || "").toLowerCase().includes(q);
  });

  const folders = Array.from(new Set(filteredDocs.map((d) => d.folder_path || "Company documents"))).sort();

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-200/80 bg-gradient-to-b from-white to-zinc-50/40 select-none">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-zinc-200/80 px-4 py-3 bg-white">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-zinc-700" />
          <h2 className="text-sm font-bold tracking-tight text-zinc-950 font-sans">Documents Sidebar</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Collapse Panel"
          className="group flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200/60 bg-zinc-50 text-zinc-555 hover:bg-zinc-100 hover:text-zinc-950 transition-all duration-200 active:scale-95 shadow-sm"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Search Input Box */}
      <div className="border-b border-zinc-200/80 p-3 bg-white/50">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
          <input
            className="h-9 w-full rounded-xl border border-zinc-200 bg-white pl-9 pr-3 text-xs outline-none placeholder:text-zinc-400/80 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/5 transition-all"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs..."
          />
        </div>
      </div>

      {/* Draggable Docs Area */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-zinc-400">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-800" />
            <span className="text-[11px] font-medium">Loading documents...</span>
          </div>
        ) : !filteredDocs.length ? (
          <div className="text-center py-12 text-zinc-400">
            <span className="text-[11px] font-medium">No documents found.</span>
          </div>
        ) : (
          folders.map((folder) => (
            <div key={folder} className="space-y-1.5">
              <div className="flex items-center gap-2 px-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                <Folder className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                <span className="truncate">{folder}</span>
              </div>
              <div className="space-y-1">
                {filteredDocs
                  .filter((d) => (d.folder_path || "Company documents") === folder)
                  .map((doc) => (
                    <div
                      key={doc.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "application/json",
                          JSON.stringify({ id: doc.id, name: doc.original_filename, type: "deal_document" })
                        );
                      }}
                      className="group flex cursor-grab items-center gap-2 rounded-xl border border-zinc-200/50 bg-white px-2.5 py-2 text-xs transition-all duration-200 hover:border-zinc-300 hover:shadow-sm active:cursor-grabbing hover:bg-zinc-50"
                    >
                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-zinc-300 group-hover:text-zinc-400 transition-colors" />
                      <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      <span className="truncate font-medium text-zinc-700 group-hover:text-zinc-950 flex-1">
                        {doc.original_filename || doc.id}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Drag & Drop Visual Hint footer */}
      <div className="shrink-0 border-t border-zinc-200/80 bg-zinc-50/80 p-3 text-center">
        <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-zinc-500">
          <ArrowDownToLine className="h-3 w-3 text-zinc-400 animate-bounce" />
          <span>Drag rows directly into chat or reviews</span>
        </div>
      </div>
    </div>
  );
}
