"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  Columns3,
  Database,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectBox } from "@/components/ui/select-box";

type Deal = { id: string; name: string };

type Column = {
  id: string;
  label: string;
  description: string;
  data_type: "text" | "number" | "percent" | "currency" | "boolean" | "json";
  prompt: string;
  research_enabled: boolean;
  position: number;
};

type Citation = { label: string; snippet?: string; href?: string };

type Cell = {
  id: string;
  deal_id: string;
  column_id: string;
  status: "empty" | "filled" | "needs_research" | "researching" | "error";
  value_text: string | null;
  confidence: number | null;
  source_kind: "none" | "internal" | "research" | "manual";
  rationale: string | null;
  citations: Citation[];
  research_notes: string | null;
  error_message: string | null;
  updated_at: string;
};

type MatrixData = {
  deals: Deal[];
  columns: Column[];
  cells: Cell[];
};

type ActiveSelection = { dealId: string; columnId: string } | null;

const starterColumns = [
  { label: "EBITDA margin", dataType: "percent", prompt: "Find the company's EBITDA margin. Prefer latest reported period." },
  { label: "Revenue growth", dataType: "percent", prompt: "Find year-over-year revenue growth. Prefer latest annual or quarterly period." },
  { label: "Beat/miss goals", dataType: "text", prompt: "Determine whether the company beat, met, or missed stated goals, and name the goal if available." },
] as const;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

function statusLabel(cell?: Cell | null): string {
  if (!cell) return "Empty";
  if (cell.status === "filled") return cell.source_kind === "research" ? "Researched" : "Internal";
  if (cell.status === "needs_research") return "Needs research";
  if (cell.status === "error") return "Error";
  return cell.status;
}

function statusTone(cell?: Cell | null): string {
  if (!cell) return "border-zinc-200 bg-zinc-50 text-zinc-500";
  if (cell.status === "filled" && cell.source_kind === "research") return "border-blue-200 bg-blue-50 text-blue-700";
  if (cell.status === "filled") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (cell.status === "needs_research") return "border-amber-200 bg-amber-50 text-amber-800";
  if (cell.status === "error") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-zinc-200 bg-zinc-50 text-zinc-500";
}

function cellAccent(cell?: Cell | null): string {
  if (!cell) return "border-l-zinc-200";
  if (cell.status === "filled" && cell.source_kind === "research") return "border-l-blue-500";
  if (cell.status === "filled") return "border-l-emerald-500";
  if (cell.status === "needs_research") return "border-l-amber-500";
  if (cell.status === "error") return "border-l-rose-500";
  return "border-l-zinc-200";
}

function confidenceLabel(cell?: Cell | null): string {
  if (!cell || cell.confidence === null) return "";
  return `${Math.round(cell.confidence * 100)}%`;
}

function sourceLabel(cell?: Cell | null): string {
  if (!cell) return "Not run";
  if (cell.source_kind === "research") return "Web";
  if (cell.source_kind === "internal") return "DB";
  if (cell.source_kind === "manual") return "Manual";
  return "None";
}

function formatDate(s?: string | null): string {
  if (!s) return "";
  return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function filterByQuery(value: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || value.toLowerCase().includes(q);
}

export function DiligenceMatrix() {
  const [data, setData] = useState<MatrixData>({ deals: [], columns: [], cells: [] });
  const [selectedDeals, setSelectedDeals] = useState<Set<string>>(new Set());
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [activeSelection, setActiveSelection] = useState<ActiveSelection>(null);
  const [companyQuery, setCompanyQuery] = useState("");
  const [columnQuery, setColumnQuery] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<Column["data_type"]>("text");
  const [newPrompt, setNewPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const cellsByKey = useMemo(() => {
    const map = new Map<string, Cell>();
    for (const cell of data.cells) map.set(`${cell.deal_id}:${cell.column_id}`, cell);
    return map;
  }, [data.cells]);

  const dealById = useMemo(() => new Map(data.deals.map((deal) => [deal.id, deal])), [data.deals]);
  const columnById = useMemo(() => new Map(data.columns.map((column) => [column.id, column])), [data.columns]);

  const filteredDeals = useMemo(
    () => data.deals.filter((deal) => filterByQuery(deal.name, companyQuery)),
    [companyQuery, data.deals],
  );
  const filteredColumns = useMemo(
    () =>
      data.columns.filter((column) =>
        filterByQuery(`${column.label} ${column.description} ${column.prompt} ${column.data_type}`, columnQuery),
      ),
    [columnQuery, data.columns],
  );

  const visibleDeals = filteredDeals.filter((deal) => selectedDeals.has(deal.id));
  const visibleColumns = filteredColumns.filter((column) => selectedColumns.has(column.id));
  const activeCell = activeSelection ? cellsByKey.get(`${activeSelection.dealId}:${activeSelection.columnId}`) ?? null : null;
  const activeDeal = activeSelection ? dealById.get(activeSelection.dealId) ?? null : null;
  const activeColumn = activeSelection ? columnById.get(activeSelection.columnId) ?? null : null;

  const summary = useMemo(() => {
    let filled = 0;
    let needsResearch = 0;
    let errors = 0;
    for (const deal of visibleDeals) {
      for (const column of visibleColumns) {
        const cell = cellsByKey.get(`${deal.id}:${column.id}`);
        if (cell?.status === "filled") filled += 1;
        else if (cell?.status === "needs_research") needsResearch += 1;
        else if (cell?.status === "error") errors += 1;
      }
    }
    const total = visibleDeals.length * visibleColumns.length;
    return { total, filled, needsResearch, errors, empty: Math.max(0, total - filled - needsResearch - errors) };
  }, [cellsByKey, visibleColumns, visibleDeals]);

  async function load() {
    setError(null);
    const next = await jsonFetch<MatrixData>("/api/diligence-matrix");
    setData(next);
    setSelectedDeals((prev) => (prev.size ? prev : new Set(next.deals.slice(0, 8).map((d) => d.id))));
    setSelectedColumns((prev) => (prev.size ? prev : new Set(next.columns.map((c) => c.id))));
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function addColumn(input?: { label: string; dataType: Column["data_type"]; prompt: string }) {
    const label = input?.label ?? newLabel;
    const dataType = input?.dataType ?? newType;
    const prompt = input?.prompt ?? newPrompt;
    if (!label.trim()) return;
    setBusy(`column:${label}`);
    setError(null);
    setMessage(null);
    try {
      const res = await jsonFetch<{ column: Column }>("/api/diligence-matrix/columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, dataType, prompt, researchEnabled: true }),
      });
      setData((prev) => ({ ...prev, columns: [...prev.columns, res.column] }));
      setSelectedColumns((prev) => new Set([...prev, res.column.id]));
      setNewLabel("");
      setNewPrompt("");
      setMessage(`Added ${res.column.label}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function fill(allowResearch: boolean) {
    const dealIds = [...selectedDeals];
    const columnIds = [...selectedColumns];
    if (!dealIds.length || !columnIds.length) {
      setError("Select at least one company and one column.");
      return;
    }
    setBusy(allowResearch ? "research" : "internal");
    setError(null);
    setMessage(null);
    try {
      const res = await jsonFetch<{ cells: Cell[]; errors: Array<{ error: string }> }>("/api/diligence-matrix/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealIds, columnIds, allowResearch }),
      });
      setData((prev) => {
        const byKey = new Map(prev.cells.map((c) => [`${c.deal_id}:${c.column_id}`, c]));
        for (const cell of res.cells) byKey.set(`${cell.deal_id}:${cell.column_id}`, cell);
        return { ...prev, cells: [...byKey.values()] };
      });
      setMessage(`Filled ${res.cells.length} cell${res.cells.length === 1 ? "" : "s"}${res.errors.length ? `; ${res.errors.length} need attention` : ""}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function toggleDeal(id: string) {
    setSelectedDeals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleColumn(id: string) {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFilteredDeals() {
    setSelectedDeals(new Set(filteredDeals.map((deal) => deal.id)));
  }

  function selectAllFilteredColumns() {
    setSelectedColumns(new Set(filteredColumns.map((column) => column.id)));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-100 text-zinc-950">
      <header className="shrink-0 border-b border-zinc-200 bg-white">
        <div className="flex flex-col gap-4 px-4 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
                <BarChart3 className="h-4 w-4 text-zinc-700" />
              </div>
              <div>
                <h1 className="text-base font-semibold tracking-tight text-zinc-950">Diligence matrix</h1>
                <p className="text-xs text-zinc-500">Compare custom metrics across the active pipeline.</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 md:w-[420px]">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
              <p className="text-[11px] font-medium text-emerald-700">Filled</p>
              <p className="mt-0.5 text-sm font-semibold text-emerald-950">{summary.filled}</p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[11px] font-medium text-amber-800">Research</p>
              <p className="mt-0.5 text-sm font-semibold text-amber-950">{summary.needsResearch}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Empty</p>
              <p className="mt-0.5 text-sm font-semibold text-zinc-950">{summary.empty}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[44svh] shrink-0 flex-col border-b border-zinc-200 bg-white lg:max-h-none lg:w-[344px] lg:border-b-0 lg:border-r">
          <div className="border-b border-zinc-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-zinc-500" />
              <h2 className="text-sm font-semibold text-zinc-950">Matrix setup</h2>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="border-b border-zinc-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">New metric</h3>
                <Columns3 className="h-4 w-4 text-zinc-400" />
              </div>
              <div className="space-y-2">
                <input
                  className="h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Metric name"
                />
                <div className="grid grid-cols-[120px_1fr] gap-2">
                  <SelectBox
                    className="h-9 py-1.5"
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as Column["data_type"])}
                  >
                    <option value="text">Text</option>
                    <option value="percent">Percent</option>
                    <option value="number">Number</option>
                    <option value="currency">Currency</option>
                    <option value="boolean">Boolean</option>
                    <option value="json">JSON</option>
                  </SelectBox>
                  <button
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    disabled={busy?.startsWith("column") || !newLabel.trim()}
                    onClick={() => addColumn()}
                  >
                    {busy?.startsWith("column") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    Add
                  </button>
                </div>
                <textarea
                  className="min-h-20 w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="Evidence standard or extraction rule"
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {starterColumns.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    disabled={Boolean(busy) || data.columns.some((x) => x.label.toLowerCase() === c.label.toLowerCase())}
                    onClick={() => addColumn(c)}
                    className="rounded-xl border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="border-b border-zinc-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Companies</h3>
                <div className="flex gap-2 text-xs">
                  <button type="button" className="font-medium text-zinc-600 hover:text-zinc-950" onClick={selectAllFilteredDeals}>
                    All
                  </button>
                  <button type="button" className="font-medium text-zinc-400 hover:text-zinc-700" onClick={() => setSelectedDeals(new Set())}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
                <input
                  className="h-9 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-8 pr-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:ring-2 focus:ring-zinc-900/10"
                  value={companyQuery}
                  onChange={(e) => setCompanyQuery(e.target.value)}
                  placeholder="Find company"
                />
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                {filteredDeals.map((deal) => {
                  const selected = selectedDeals.has(deal.id);
                  return (
                    <button
                      key={deal.id}
                      type="button"
                      onClick={() => toggleDeal(deal.id)}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-xl px-2 text-left text-xs transition-colors",
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
            </section>

            <section className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Columns</h3>
                <div className="flex gap-2 text-xs">
                  <button type="button" className="font-medium text-zinc-600 hover:text-zinc-950" onClick={selectAllFilteredColumns}>
                    All
                  </button>
                  <button type="button" className="font-medium text-zinc-400 hover:text-zinc-700" onClick={() => setSelectedColumns(new Set())}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
                <input
                  className="h-9 w-full rounded-xl border border-zinc-200 bg-zinc-50 pl-8 pr-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:ring-2 focus:ring-zinc-900/10"
                  value={columnQuery}
                  onChange={(e) => setColumnQuery(e.target.value)}
                  placeholder="Find column"
                />
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {filteredColumns.map((column) => {
                  const selected = selectedColumns.has(column.id);
                  return (
                    <button
                      key={column.id}
                      type="button"
                      onClick={() => toggleColumn(column.id)}
                      className={cn(
                        "flex min-h-9 w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-xs transition-colors",
                        selected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100",
                      )}
                    >
                      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", selected ? "border-white/40" : "border-zinc-300 bg-white")}>
                        {selected ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{column.label}</span>
                        <span className={cn("block truncate text-[11px]", selected ? "text-white/60" : "text-zinc-400")}>{column.data_type}</span>
                      </span>
                    </button>
                  );
                })}
                {!filteredColumns.length ? <p className="px-2 py-3 text-xs text-zinc-500">No columns yet.</p> : null}
              </div>
            </section>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-zinc-200 bg-white px-4 py-3">
            <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-700">
                  <Building2 className="h-3.5 w-3.5" />
                  {selectedDeals.size} companies
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-700">
                  <Columns3 className="h-3.5 w-3.5" />
                  {selectedColumns.size} columns
                </span>
                <span className={cn("inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-medium", summary.errors ? "border-rose-200 bg-rose-50 text-rose-700" : "border-zinc-200 bg-zinc-50 text-zinc-500")}>
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {summary.errors} errors
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => fill(false)}
                >
                  {busy === "internal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                  Fill from DB
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => fill(true)}
                >
                  {busy === "research" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Fill + research
                </button>
              </div>
            </div>
            {message ? <p className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
            {error ? <p className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-zinc-50 p-3">
            <div className="min-h-full overflow-hidden rounded-2xl border border-zinc-200 bg-white">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgba(228,228,231,1)]">
                  <tr>
                    <th className="sticky left-0 z-20 w-60 border-r border-zinc-200 bg-white px-3 py-2.5 text-left text-xs font-semibold text-zinc-500">
                      Company
                    </th>
                    {visibleColumns.map((column) => (
                      <th key={column.id} className="min-w-64 border-r border-zinc-200 bg-white px-3 py-2.5 text-left align-bottom">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-zinc-950">{column.label}</div>
                            <div className="mt-1 inline-flex rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                              {column.data_type}
                            </div>
                          </div>
                          {column.research_enabled ? <Search className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" /> : null}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleDeals.map((deal, rowIndex) => (
                    <tr key={deal.id} className={rowIndex % 2 ? "bg-zinc-50/45" : "bg-white"}>
                      <td className="sticky left-0 z-[5] border-r border-t border-zinc-200 bg-inherit px-3 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white text-[11px] font-semibold text-zinc-700">
                            {deal.name.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-zinc-950">{deal.name}</div>
                            <div className="mt-0.5 text-[11px] text-zinc-400">{visibleColumns.length} tracked fields</div>
                          </div>
                        </div>
                      </td>
                      {visibleColumns.map((column) => {
                        const cell = cellsByKey.get(`${deal.id}:${column.id}`) ?? null;
                        const active = activeSelection?.dealId === deal.id && activeSelection.columnId === column.id;
                        return (
                          <td key={column.id} className="border-r border-t border-zinc-200 p-0 align-top">
                            <button
                              type="button"
                              onClick={() => setActiveSelection({ dealId: deal.id, columnId: column.id })}
                              className={cn(
                                "h-32 w-full border-l-2 bg-white px-3 py-2.5 text-left transition-colors hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-zinc-900/15",
                                cellAccent(cell),
                                active && "bg-zinc-50 ring-2 ring-inset ring-zinc-900/15",
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className={cn("inline-flex max-w-[150px] items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", statusTone(cell))}>
                                  {statusLabel(cell)}
                                </span>
                                <span className="shrink-0 text-[11px] font-medium text-zinc-400">{sourceLabel(cell)}</span>
                              </div>
                              <p className={cn("mt-2 line-clamp-3 min-h-[48px] text-xs leading-relaxed", cell ? "text-zinc-900" : "text-zinc-400")}>
                                {cell?.value_text || cell?.error_message || "Not filled"}
                              </p>
                              <div className="mt-2 flex items-center justify-between gap-2">
                                <div className="h-1.5 min-w-0 flex-1 rounded-full bg-zinc-100">
                                  <div
                                    className={cn(
                                      "h-full rounded-full",
                                      cell?.source_kind === "research" ? "bg-blue-500" : cell?.status === "filled" ? "bg-emerald-500" : "bg-zinc-300",
                                    )}
                                    style={{ width: cell?.confidence !== null && cell?.confidence !== undefined ? `${Math.max(8, Math.round(cell.confidence * 100))}%` : "0%" }}
                                  />
                                </div>
                                <span className="w-9 text-right text-[11px] font-medium text-zinc-400">{confidenceLabel(cell)}</span>
                              </div>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {!visibleDeals.length || !visibleColumns.length ? (
                    <tr>
                      <td className="px-6 py-12 text-sm text-zinc-500" colSpan={Math.max(1, visibleColumns.length + 1)}>
                        <div className="mx-auto max-w-sm text-center">
                          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
                            <BarChart3 className="h-5 w-5 text-zinc-500" />
                          </div>
                          <p className="mt-3 font-medium text-zinc-800">No matrix view selected</p>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-500">Choose at least one company and one column from the setup rail.</p>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {activeSelection ? (
            <div className="border-t border-zinc-200 bg-white p-4 xl:hidden">
              <CellDetails cell={activeCell} deal={activeDeal} column={activeColumn} />
            </div>
          ) : null}
        </main>

        <aside className="hidden w-[390px] shrink-0 flex-col border-l border-zinc-200 bg-white xl:flex">
          <div className="border-b border-zinc-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-zinc-950">Cell details</h2>
            <p className="text-xs text-zinc-500">{activeDeal && activeColumn ? `${activeDeal.name} / ${activeColumn.label}` : "Select a cell"}</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {activeSelection ? (
              <CellDetails cell={activeCell} deal={activeDeal} column={activeColumn} />
            ) : (
              <div className="flex h-full items-center justify-center text-center">
                <div>
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50">
                    <CheckCircle2 className="h-5 w-5 text-zinc-500" />
                  </div>
                  <p className="mt-3 text-sm font-medium text-zinc-800">Evidence appears here</p>
                  <p className="mt-1 max-w-64 text-xs leading-relaxed text-zinc-500">Open a cell to inspect rationale, confidence, and supporting sources.</p>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function CellDetails({
  cell,
  deal,
  column,
}: {
  cell: Cell | null;
  deal: Deal | null;
  column: Column | null;
}) {
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-zinc-500">{deal?.name ?? "Company"}</p>
            <h3 className="mt-1 truncate text-base font-semibold text-zinc-950">{column?.label ?? "Column"}</h3>
          </div>
          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", statusTone(cell))}>
            {statusLabel(cell)}
          </span>
        </div>
        <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Value</p>
          <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-relaxed text-zinc-950">
            {cell?.value_text || cell?.error_message || "Not filled yet"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
          <p className="text-[11px] text-zinc-500">Source</p>
          <p className="mt-1 text-sm font-semibold text-zinc-950">{sourceLabel(cell)}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
          <p className="text-[11px] text-zinc-500">Confidence</p>
          <p className="mt-1 text-sm font-semibold text-zinc-950">{confidenceLabel(cell) || "-"}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
          <p className="text-[11px] text-zinc-500">Updated</p>
          <p className="mt-1 truncate text-sm font-semibold text-zinc-950">{formatDate(cell?.updated_at) || "-"}</p>
        </div>
      </div>

      {column?.prompt ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Column rule</h4>
          <p className="mt-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm leading-relaxed text-zinc-700">{column.prompt}</p>
        </section>
      ) : null}

      {cell?.rationale ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Rationale</h4>
          <p className="mt-2 text-sm leading-relaxed text-zinc-700">{cell.rationale}</p>
        </section>
      ) : null}

      {cell?.research_notes ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Research notes</h4>
          <p className="mt-2 whitespace-pre-wrap rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm leading-relaxed text-blue-950">{cell.research_notes}</p>
        </section>
      ) : null}

      {cell?.citations.length ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Sources</h4>
          <div className="mt-2 space-y-2">
            {cell.citations.map((citation, i) => (
              <div key={`${citation.label}-${i}`} className="rounded-xl border border-zinc-200 bg-white p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  {citation.href ? (
                    <a className="font-medium text-zinc-950 hover:underline" href={citation.href} target="_blank" rel="noreferrer">
                      {citation.label}
                    </a>
                  ) : (
                    <p className="font-medium text-zinc-950">{citation.label}</p>
                  )}
                  {citation.href ? <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-400" /> : null}
                </div>
                {citation.snippet ? <p className="mt-2 text-xs leading-relaxed text-zinc-500">{citation.snippet}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!cell ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
          This cell has not been filled yet.
        </div>
      ) : null}
    </div>
  );
}
