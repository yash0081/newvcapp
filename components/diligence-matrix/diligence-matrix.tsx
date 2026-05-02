"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Database, Loader2, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";

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

function cellTone(cell?: Cell): string {
  if (!cell) return "bg-white text-zinc-400";
  if (cell.status === "filled" && cell.source_kind === "research") return "bg-blue-50 text-blue-950";
  if (cell.status === "filled") return "bg-emerald-50 text-emerald-950";
  if (cell.status === "needs_research") return "bg-amber-50 text-amber-950";
  if (cell.status === "error") return "bg-rose-50 text-rose-950";
  return "bg-white text-zinc-400";
}

function statusLabel(cell?: Cell): string {
  if (!cell) return "Empty";
  if (cell.status === "filled") return cell.source_kind === "research" ? "Researched" : "Internal";
  if (cell.status === "needs_research") return "Needs research";
  if (cell.status === "error") return "Error";
  return cell.status;
}

export function DiligenceMatrix() {
  const [data, setData] = useState<MatrixData>({ deals: [], columns: [], cells: [] });
  const [selectedDeals, setSelectedDeals] = useState<Set<string>>(new Set());
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [activeCell, setActiveCell] = useState<Cell | null>(null);
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
      setMessage(`Filled ${res.cells.length} cell${res.cells.length === 1 ? "" : "s"}${res.errors.length ? `; ${res.errors.length} failed` : ""}.`);
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

  const visibleColumns = data.columns.filter((c) => selectedColumns.has(c.id));
  const visibleDeals = data.deals.filter((d) => selectedDeals.has(d.id));

  return (
    <div className="flex min-h-0 flex-1 bg-white">
      <aside className="hidden w-80 shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50 p-4 lg:block">
        <div className="space-y-5">
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950">Add column</h2>
              <p className="text-xs text-zinc-500">Each column is a metric or diligence question to fill across companies.</p>
            </div>
            <input className="crm-input bg-white" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. EBITDA margin" />
            <select className="crm-input bg-white" value={newType} onChange={(e) => setNewType(e.target.value as Column["data_type"])}>
              <option value="text">Text</option>
              <option value="percent">Percent</option>
              <option value="number">Number</option>
              <option value="currency">Currency</option>
              <option value="boolean">Boolean</option>
              <option value="json">JSON</option>
            </select>
            <textarea className="crm-input min-h-24 bg-white" value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} placeholder="How should this be answered? What counts as evidence?" />
            <button className="crm-button w-full" type="button" disabled={busy?.startsWith("column") || !newLabel.trim()} onClick={() => addColumn()}>
              <Plus className="h-4 w-4" />
              Add column
            </button>
            <div className="flex flex-wrap gap-2">
              {starterColumns.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  disabled={Boolean(busy) || data.columns.some((x) => x.label.toLowerCase() === c.label.toLowerCase())}
                  onClick={() => addColumn(c)}
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-950">Companies</h2>
              <button type="button" className="text-xs text-zinc-500 hover:text-zinc-950" onClick={() => setSelectedDeals(new Set(data.deals.map((d) => d.id)))}>
                All
              </button>
            </div>
            <div className="max-h-64 space-y-1 overflow-auto">
              {data.deals.map((deal) => (
                <label key={deal.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-white">
                  <input type="checkbox" checked={selectedDeals.has(deal.id)} onChange={() => toggleDeal(deal.id)} />
                  <span className="truncate">{deal.name}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-950">Columns</h2>
              <button type="button" className="text-xs text-zinc-500 hover:text-zinc-950" onClick={() => setSelectedColumns(new Set(data.columns.map((c) => c.id)))}>
                All
              </button>
            </div>
            <div className="max-h-64 space-y-1 overflow-auto">
              {data.columns.map((column) => (
                <label key={column.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-zinc-700 hover:bg-white">
                  <input type="checkbox" checked={selectedColumns.has(column.id)} onChange={() => toggleColumn(column.id)} />
                  <span className="truncate">{column.label}</span>
                </label>
              ))}
            </div>
          </section>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-zinc-200 px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h1 className="text-base font-semibold text-zinc-950">Diligence matrix</h1>
              <p className="text-xs text-zinc-500">Custom columns across companies, filled from workspace data first and web research when needed.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="crm-button-secondary" type="button" disabled={Boolean(busy)} onClick={() => fill(false)}>
                {busy === "internal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                Fill from DB
              </button>
              <button className="crm-button" type="button" disabled={Boolean(busy)} onClick={() => fill(true)}>
                {busy === "research" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Fill + research missing
              </button>
            </div>
          </div>
          {message ? <p className="mt-2 text-sm text-emerald-700">{message}</p> : null}
          {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr>
                <th className="sticky left-0 z-20 w-52 border-b border-r border-zinc-200 bg-white px-3 py-2 text-left text-xs font-semibold text-zinc-500">
                  Company
                </th>
                {visibleColumns.map((column) => (
                  <th key={column.id} className="min-w-56 border-b border-r border-zinc-200 bg-white px-3 py-2 text-left align-bottom">
                    <div className="text-xs font-semibold text-zinc-950">{column.label}</div>
                    <div className="mt-1 text-[11px] font-normal text-zinc-500">{column.data_type}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleDeals.map((deal) => (
                <tr key={deal.id}>
                  <td className="sticky left-0 z-10 border-b border-r border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900">
                    {deal.name}
                  </td>
                  {visibleColumns.map((column) => {
                    const cell = cellsByKey.get(`${deal.id}:${column.id}`);
                    return (
                      <td key={column.id} className="border-b border-r border-zinc-200 p-0 align-top">
                        <button
                          type="button"
                          onClick={() => setActiveCell(cell ?? null)}
                          className={cn("h-28 w-full overflow-hidden px-3 py-2 text-left", cellTone(cell))}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium uppercase tracking-wide opacity-70">{statusLabel(cell)}</span>
                            {cell?.status === "filled" ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                          </div>
                          <div className="mt-2 line-clamp-4 text-xs leading-relaxed">
                            {cell?.value_text || cell?.error_message || "Not filled yet"}
                          </div>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!visibleDeals.length || !visibleColumns.length ? (
                <tr>
                  <td className="px-4 py-8 text-sm text-zinc-500" colSpan={Math.max(1, visibleColumns.length + 1)}>
                    Select companies and add at least one column to start.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </main>

      {activeCell ? (
        <aside className="hidden w-96 shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-4 xl:block">
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">{statusLabel(activeCell)}</p>
              <h2 className="mt-1 text-sm font-semibold text-zinc-950">{activeCell.value_text || "No value"}</h2>
              {activeCell.confidence !== null ? <p className="mt-1 text-xs text-zinc-500">Confidence {Math.round(activeCell.confidence * 100)}%</p> : null}
            </div>
            {activeCell.rationale ? <p className="text-sm leading-relaxed text-zinc-700">{activeCell.rationale}</p> : null}
            {activeCell.research_notes ? (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Research notes</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{activeCell.research_notes}</p>
              </section>
            ) : null}
            {activeCell.citations.length ? (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Sources</h3>
                <div className="mt-2 space-y-2">
                  {activeCell.citations.map((c, i) => (
                    <div key={`${c.label}-${i}`} className="rounded-md border border-zinc-200 p-2 text-xs">
                      {c.href ? (
                        <a className="font-medium text-zinc-900 hover:underline" href={c.href} target="_blank" rel="noreferrer">
                          {c.label}
                        </a>
                      ) : (
                        <p className="font-medium text-zinc-900">{c.label}</p>
                      )}
                      {c.snippet ? <p className="mt-1 text-zinc-500">{c.snippet}</p> : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
