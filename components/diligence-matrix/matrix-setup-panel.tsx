"use client";

import { Building2, Check, Columns3, FileText, Loader2, Plus, Search, Trash2, UploadCloud } from "lucide-react";
import { DEFAULT_MATRIX_COLUMNS } from "@/lib/diligence-matrix/defaults";
import { cn } from "@/lib/utils";

type Column = {
  id: string;
  label: string;
  data_type: string;
};

type Deal = { id: string; name: string };

type SetupTab = "columns" | "companies" | "docs";

export function MatrixSetupPanel(props: {
  setupTab: SetupTab;
  onSetupTab: (tab: SetupTab) => void;
  onClose: () => void;
  newLabel: string;
  onNewLabel: (value: string) => void;
  onQuickAddColumn: () => void;
  busy: string | null;
  columns: Column[];
  selectedColumnIds: Set<string>;
  onToggleColumn: (id: string) => void;
  onDeleteColumn: (id: string) => void;
  onApplyPreset: (name: "financial" | "team") => void;
  onAddSuggestedColumn: (col: { label: string; dataType: string; prompt: string }) => void;
  columnQuery: string;
  onColumnQuery: (value: string) => void;
  filteredColumns: Column[];
  onSelectAllColumns: () => void;
  onClearColumns: () => void;
  deals: Deal[];
  selectedDealIds: Set<string>;
  onToggleDeal: (id: string) => void;
  companyQuery: string;
  onCompanyQuery: (value: string) => void;
  filteredDeals: Deal[];
  onSelectAllDeals: () => void;
  onClearDeals: () => void;
  matrixFiles: File[];
  onMatrixFiles: (files: File[]) => void;
  onUploadDocuments: () => void;
  uploadBusy: boolean;
}) {
  const tabs: { id: SetupTab; label: string }[] = [
    { id: "columns", label: "Columns" },
    { id: "companies", label: "Companies" },
    { id: "docs", label: "Docs" },
  ];

  return (
    <aside className="flex max-h-[44svh] shrink-0 flex-col border-b border-zinc-200 bg-white lg:max-h-none lg:w-[300px] lg:border-b-0 lg:border-r">
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-950">Matrix setup</h2>
          <button type="button" onClick={props.onClose} className="text-xs font-medium text-zinc-500 hover:text-zinc-900">
            Close
          </button>
        </div>
        <div className="mt-2 flex gap-1 rounded-xl bg-zinc-100 p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => props.onSetupTab(tab.id)}
              className={cn(
                "flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors",
                props.setupTab === tab.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {props.setupTab === "columns" ? (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                className="h-9 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400"
                value={props.newLabel}
                onChange={(e) => props.onNewLabel(e.target.value)}
                placeholder="Column name, press Enter"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && props.newLabel.trim()) props.onQuickAddColumn();
                }}
              />
              <button
                type="button"
                disabled={props.busy?.startsWith("column") || !props.newLabel.trim()}
                onClick={props.onQuickAddColumn}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {props.busy?.startsWith("column") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Type a metric name to add a column. Fill uses your workspace plus web search when needed.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_MATRIX_COLUMNS.slice(0, 4).map((c) => (
                <button
                  key={c.label}
                  type="button"
                  disabled={Boolean(props.busy) || props.columns.some((x) => x.label.toLowerCase() === c.label.toLowerCase())}
                  onClick={() => props.onAddSuggestedColumn({ label: c.label, dataType: c.dataType, prompt: c.prompt })}
                  className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-white disabled:opacity-40"
                >
                  + {c.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={Boolean(props.busy)} onClick={() => props.onApplyPreset("financial")} className="flex-1 rounded-lg border border-zinc-200 py-1.5 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
                + Financial pack
              </button>
              <button type="button" disabled={Boolean(props.busy)} onClick={() => props.onApplyPreset("team")} className="flex-1 rounded-lg border border-zinc-200 py-1.5 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
                + Team pack
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
              <input
                className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-8 pr-2 text-xs outline-none focus:bg-white"
                value={props.columnQuery}
                onChange={(e) => props.onColumnQuery(e.target.value)}
                placeholder="Filter columns"
              />
            </div>
            <div className="flex justify-between text-[11px] font-medium text-zinc-500">
              <button type="button" onClick={props.onSelectAllColumns} className="hover:text-zinc-900">
                Select all
              </button>
              <button type="button" onClick={props.onClearColumns} className="hover:text-zinc-900">
                Clear
              </button>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {props.filteredColumns.map((column) => {
                const selected = props.selectedColumnIds.has(column.id);
                return (
                  <div
                    key={column.id}
                    className={cn(
                      "flex items-center gap-1 rounded-lg px-2 py-1 text-xs",
                      selected ? "bg-zinc-900 text-white" : "hover:bg-zinc-100 text-zinc-700",
                    )}
                  >
                    <button type="button" onClick={() => props.onToggleColumn(column.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <Columns3 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span className="truncate font-medium">{column.label}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onDeleteColumn(column.id)}
                      className={cn("rounded p-1", selected ? "text-white/60 hover:text-white" : "text-zinc-400 hover:text-rose-600")}
                      aria-label={`Delete ${column.label}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {props.setupTab === "companies" ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
              <input
                className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-8 pr-2 text-xs outline-none focus:bg-white"
                value={props.companyQuery}
                onChange={(e) => props.onCompanyQuery(e.target.value)}
                placeholder="Find company"
              />
            </div>
            <div className="flex justify-between text-[11px] font-medium text-zinc-500">
              <button type="button" onClick={props.onSelectAllDeals} className="hover:text-zinc-900">
                Select all
              </button>
              <button type="button" onClick={props.onClearDeals} className="hover:text-zinc-900">
                Clear
              </button>
            </div>
            <div className="max-h-[min(52vh,420px)] space-y-1 overflow-y-auto">
              {props.filteredDeals.map((deal) => {
                const selected = props.selectedDealIds.has(deal.id);
                return (
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => props.onToggleDeal(deal.id)}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs",
                      selected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100",
                    )}
                  >
                    <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", selected ? "border-white/40" : "border-zinc-300 bg-white")}>
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{deal.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {props.setupTab === "docs" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-zinc-600">
              <FileText className="h-4 w-4" />
              <span>Upload PDFs to selected companies for richer fills.</span>
            </div>
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-sm font-medium text-zinc-700 hover:bg-white">
              <UploadCloud className="h-4 w-4" />
              <span>{props.matrixFiles.length ? `${props.matrixFiles.length} PDF(s)` : "Choose PDFs"}</span>
              <input type="file" accept="application/pdf" multiple className="hidden" onChange={(e) => props.onMatrixFiles(Array.from(e.target.files ?? []))} />
            </label>
            <button
              type="button"
              disabled={props.uploadBusy || !props.matrixFiles.length || !props.selectedDealIds.size}
              onClick={props.onUploadDocuments}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {props.uploadBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
              Upload & index
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
