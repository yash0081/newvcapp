"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MATRIX_COLUMNS,
  MATRIX_COLUMN_PRESETS,
  defaultColumnLimit,
  pickDefaultColumnIds,
  resolveMatrixColumnIds,
} from "@/lib/diligence-matrix/defaults";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  Columns3,
  ExternalLink,
  FileText,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MatrixSetupPanel } from "@/components/diligence-matrix/matrix-setup-panel";

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
type CellPair = { dealId: string; columnId: string };
type MatrixView = {
  id: string;
  name: string;
  dealIds: string[];
  columnIds: string[];
  updatedAt: number;
};

type SetupTab = "columns" | "companies" | "docs";

function promptFromLabel(label: string): string {
  return `Find ${label.trim()} for this company only. Prefer saved internal documents; use public web sources when internal data is missing.`;
}

function mergeCells(prev: Cell[], incoming: Cell[]): Cell[] {
  const byKey = new Map(prev.map((c) => [`${c.deal_id}:${c.column_id}`, c]));
  for (const cell of incoming) byKey.set(`${cell.deal_id}:${cell.column_id}`, cell);
  return [...byKey.values()];
}

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
  if (cell.source_kind === "internal") return "Database";
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

const MATRIX_VIEW_STORAGE_KEY = "vcapp.matrix.views.v1";

export function DiligenceMatrix({ focusMode = false, initialDealIds = [] }: { focusMode?: boolean; initialDealIds?: string[] }) {
  const [viewMode, setViewMode] = useState<"list" | "spreadsheet">("list");
  const [data, setData] = useState<MatrixData>({ deals: [], columns: [], cells: [] });
  const [selectedDeals, setSelectedDeals] = useState<Set<string>>(new Set());
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [activeSelection, setActiveSelection] = useState<ActiveSelection>(null);
  const [matrixViews, setMatrixViews] = useState<MatrixView[]>([]);
  const [viewName, setViewName] = useState("");
  const [matrixName, setMatrixName] = useState("");
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [setupTab, setSetupTab] = useState<SetupTab>("columns");
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const [matrixFiles, setMatrixFiles] = useState<File[]>([]);
  const [companyQuery, setCompanyQuery] = useState("");
  const [columnQuery, setColumnQuery] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<Column["data_type"]>("text");
  const [matrixQuestion, setMatrixQuestion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  const activeView = useMemo(
    () => matrixViews.find((view) => view.id === activeViewId) ?? null,
    [activeViewId, matrixViews],
  );

  useEffect(() => {
    setMatrixName(activeView?.name ?? "Untitled matrix");
  }, [activeView?.id, activeView?.name]);

  function persistMatrixViewsLocal(next: MatrixView[]) {
    window.localStorage.setItem(MATRIX_VIEW_STORAGE_KEY, JSON.stringify(next));
  }

  async function loadMatrixViews(): Promise<MatrixView[]> {
    try {
      const res = await jsonFetch<{
        views: Array<{ id: string; name: string; dealIds: string[]; columnIds: string[]; updatedAt: string }>;
      }>("/api/diligence-matrix/views");
      return res.views.map((view) => ({
        id: view.id,
        name: view.name,
        dealIds: view.dealIds,
        columnIds: view.columnIds,
        updatedAt: new Date(view.updatedAt).getTime(),
      }));
    } catch {
      const raw = window.localStorage.getItem(MATRIX_VIEW_STORAGE_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as MatrixView[];
        return Array.isArray(parsed) ? parsed.filter((view) => view?.id) : [];
      } catch {
        return [];
      }
    }
  }

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

  const visibleDeals = useMemo(() => filteredDeals.filter((deal) => selectedDeals.has(deal.id)), [filteredDeals, selectedDeals]);
  const visibleColumns = useMemo(() => filteredColumns.filter((column) => selectedColumns.has(column.id)), [filteredColumns, selectedColumns]);
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
    setSelectedDeals((prev) => {
      if (prev.size) return prev;
      const available = new Set(next.deals.map((deal) => deal.id));
      const scoped = initialDealIds.filter((dealId) => available.has(dealId));
      return new Set((scoped.length ? scoped : next.deals.slice(0, 8).map((d) => d.id)));
    });
    setSelectedColumns((prev) => {
      if (prev.size) return prev;
      return new Set(pickDefaultColumnIds(next.columns, defaultColumnLimit(focusMode)));
    });
  }

  useEffect(() => {
    void (async () => {
      try {
        await load();
        const views = await loadMatrixViews();
        setMatrixViews(views);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setViewsLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!viewsLoaded || viewMode !== "spreadsheet" || activeViewId) return;
    void ensureActiveMatrixView().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [viewsLoaded, viewMode, activeViewId, selectedDeals, selectedColumns]);

  const cellNeedsFill = useCallback((cell?: Cell | null): boolean => {
    if (!cell) return true;
    if (cell.status === "empty" || cell.status === "needs_research" || cell.status === "error") return true;
    if (!(cell.value_text || "").trim() && cell.status !== "researching") return true;
    return false;
  }, []);

  const pairsNeedingFill = useCallback(
    (options?: { dealIds?: string[]; columnIds?: string[] }): CellPair[] => {
      if (!visibleDeals.length || !visibleColumns.length) return [];
      const dealFilter = options?.dealIds ? new Set(options.dealIds) : null;
      const columnFilter = options?.columnIds ? new Set(options.columnIds) : null;
      const pairs: CellPair[] = [];
      for (const deal of visibleDeals) {
        if (dealFilter && !dealFilter.has(deal.id)) continue;
        for (const column of visibleColumns) {
          if (columnFilter && !columnFilter.has(column.id)) continue;
          const cell = cellsByKey.get(`${deal.id}:${column.id}`);
          if (cellNeedsFill(cell)) pairs.push({ dealId: deal.id, columnId: column.id });
        }
      }
      return pairs;
    },
    [cellNeedsFill, cellsByKey, visibleColumns, visibleDeals],
  );

  const fillPairsInBatches = useCallback(async (pairs: CellPair[], allowResearch: boolean): Promise<Cell[]> => {
    const batchSize = allowResearch ? 12 : 100;
    const collected: Cell[] = [];
    for (let i = 0; i < pairs.length; i += batchSize) {
      const chunk = pairs.slice(i, i + batchSize);
      const res = await jsonFetch<{ cells: Cell[]; errors: Array<{ error: string }> }>("/api/diligence-matrix/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: chunk, allowResearch }),
      });
      collected.push(...res.cells);
      setData((prev) => ({ ...prev, cells: mergeCells(prev.cells, res.cells) }));
    }
    return collected;
  }, []);

  const fillPairs = useCallback(
    async (pairs: CellPair[]) => {
      if (!pairs.length) return { internalCount: 0, webCount: 0, stillNeeds: 0 };

      const cellForPair = (list: Cell[], pair: CellPair) =>
        list.find((c) => c.deal_id === pair.dealId && c.column_id === pair.columnId);

      setMessage(`Checking workspace data for ${pairs.length} cell${pairs.length === 1 ? "" : "s"}…`);
      const internalCells = await fillPairsInBatches(pairs, false);

      const needsWeb = pairs.filter((pair) => cellNeedsFill(cellForPair(internalCells, pair)));

      let webCells: Cell[] = [];
      if (needsWeb.length) {
        setMessage(`Searching the web for ${needsWeb.length} remaining cell${needsWeb.length === 1 ? "" : "s"}…`);
        webCells = await fillPairsInBatches(needsWeb, true);
      }

      const allFilled = mergeCells(internalCells, webCells);
      const stillNeeds = pairs.filter((pair) => cellNeedsFill(cellForPair(allFilled, pair))).length;
      return { internalCount: internalCells.length, webCount: webCells.length, stillNeeds };
    },
    [cellNeedsFill, fillPairsInBatches],
  );

  const fillVisible = useCallback(async () => {
    if (filling) return;
    const pairs = pairsNeedingFill();
    if (!pairs.length) {
      setMessage("All visible cells are already filled.");
      return;
    }
    setFilling(true);
    setError(null);
    try {
      const { internalCount, webCount, stillNeeds } = await fillPairs(pairs);
      setMessage(
        stillNeeds > 0
          ? `Filled ${internalCount + webCount} cells (${webCount} via web). ${stillNeeds} still need attention — click Fill again.`
          : webCount > 0
            ? `Filled ${internalCount + webCount} cells (${webCount} via web search).`
            : `Filled ${internalCount} cell${internalCount === 1 ? "" : "s"} from workspace data.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFilling(false);
    }
  }, [fillPairs, filling, pairsNeedingFill]);

  async function addColumnDirect(col: { label: string; dataType: Column["data_type"]; prompt: string }): Promise<Column | null> {
    try {
      const res = await jsonFetch<{ column: Column }>("/api/diligence-matrix/columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: col.label,
          dataType: col.dataType,
          prompt: col.prompt,
          researchEnabled: true,
        }),
      });
      setData((prev) => ({ ...prev, columns: [...prev.columns, res.column] }));
      setSelectedColumns((prev) => new Set([...prev, res.column.id]));
      return res.column;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function applyPreset(name: "financial" | "team") {
    setBusy("preset");
    setError(null);
    setMessage(null);
    try {
      const targets = MATRIX_COLUMN_PRESETS[name] ?? [];
      const added: string[] = [];
      for (const col of targets) {
        if (!data.columns.some((x) => x.label.toLowerCase() === col.label.toLowerCase())) {
          const c = await addColumnDirect(col);
          if (c) added.push(c.label);
        }
      }
      if (added.length > 0) {
        setMessage(`Applied ${name === "financial" ? "Financial" : "Team"} preset: added ${added.join(", ")}.`);
      } else {
        setMessage("All columns in this preset are already added.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addColumn(input?: { label: string; dataType?: Column["data_type"]; prompt?: string }) {
    const label = (input?.label ?? newLabel).trim();
    if (!label) return;
    const dataType = input?.dataType ?? newType;
    const prompt = input?.prompt ?? promptFromLabel(label);
    setBusy(`column:${label}`);
    setError(null);
    setMessage(null);
    try {
      const col = await addColumnDirect({ label, dataType, prompt });
      if (col) {
        setNewLabel("");
        setMessage(`Added ${col.label}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function quickAddColumn() {
    await addColumn();
  }

  async function deleteColumn(columnId: string) {
    const column = columnById.get(columnId);
    if (!column) return;
    setBusy(`delete-column:${columnId}`);
    setError(null);
    setMessage(null);
    try {
      await jsonFetch<{ ok: boolean }>(`/api/diligence-matrix/columns/${columnId}`, { method: "DELETE" });
      setData((prev) => ({
        ...prev,
        columns: prev.columns.filter((item) => item.id !== columnId),
        cells: prev.cells.filter((cell) => cell.column_id !== columnId),
      }));
      setSelectedColumns((prev) => {
        const next = new Set(prev);
        next.delete(columnId);
        return next;
      });
      if (activeSelection?.columnId === columnId) setActiveSelection(null);
      setMessage(`Deleted ${column.label}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function defaultDealIdsForMatrix(): string[] {
    if (selectedDeals.size) return [...selectedDeals];
    return data.deals.slice(0, 8).map((deal) => deal.id);
  }

  function defaultColumnIdsForMatrix(): string[] {
    return pickDefaultColumnIds(data.columns, defaultColumnLimit(focusMode));
  }

  async function ensureActiveMatrixView(): Promise<string | null> {
    if (activeViewId) return activeViewId;
    const name = viewName.trim() || `Matrix ${matrixViews.length + 1}`;
    const dealIds = defaultDealIdsForMatrix();
    const columnIds = defaultColumnIdsForMatrix();
    setSelectedDeals(new Set(dealIds));
    setSelectedColumns(new Set(columnIds));
    const res = await jsonFetch<{ view: { id: string; name: string; dealIds: string[]; columnIds: string[]; updatedAt: string } }>(
      "/api/diligence-matrix/views",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dealIds, columnIds }),
      },
    );
    const view: MatrixView = {
      id: res.view.id,
      name: res.view.name,
      dealIds: res.view.dealIds,
      columnIds: res.view.columnIds,
      updatedAt: new Date(res.view.updatedAt).getTime(),
    };
    setMatrixViews((prev) => [view, ...prev.filter((item) => item.id !== view.id)].slice(0, 48));
    setActiveViewId(view.id);
    persistMatrixViewsLocal([view, ...matrixViews].slice(0, 48));
    return view.id;
  }

  async function saveCurrentMatrixView() {
    const name = viewName.trim() || activeView?.name || `Matrix ${matrixViews.length + 1}`;
    setBusy("save-view");
    setError(null);
    try {
      if (activeViewId) {
        const res = await jsonFetch<{ view: { id: string; name: string; dealIds: string[]; columnIds: string[]; updatedAt: string } }>(
          `/api/diligence-matrix/views/${activeViewId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, dealIds: [...selectedDeals], columnIds: [...selectedColumns] }),
          },
        );
        const view: MatrixView = {
          id: res.view.id,
          name: res.view.name,
          dealIds: res.view.dealIds,
          columnIds: res.view.columnIds,
          updatedAt: new Date(res.view.updatedAt).getTime(),
        };
        setMatrixViews((prev) => [view, ...prev.filter((item) => item.id !== view.id)]);
        setViewName("");
        setMessage(`Saved ${view.name}.`);
        return;
      }
      const res = await jsonFetch<{ view: { id: string; name: string; dealIds: string[]; columnIds: string[]; updatedAt: string } }>(
        "/api/diligence-matrix/views",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, dealIds: [...selectedDeals], columnIds: [...selectedColumns] }),
        },
      );
      const view: MatrixView = {
        id: res.view.id,
        name: res.view.name,
        dealIds: res.view.dealIds,
        columnIds: res.view.columnIds,
        updatedAt: new Date(res.view.updatedAt).getTime(),
      };
      setMatrixViews((prev) => [view, ...prev]);
      setActiveViewId(view.id);
      setViewName("");
      setMessage(`Saved ${view.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function applyMatrixView(view: MatrixView) {
    const dealIds = view.dealIds.filter((id) => data.deals.some((deal) => deal.id === id));
    const columnIds = resolveMatrixColumnIds(view.columnIds, data.columns, { focusMode });
    setActiveViewId(view.id);
    setSelectedDeals(
      new Set(dealIds.length ? dealIds : data.deals.slice(0, 8).map((deal) => deal.id)),
    );
    setSelectedColumns(new Set(columnIds));
    setViewMode("spreadsheet");
    setMatrixName(view.name);
    setMessage(`Opened ${view.name}.`);
  }

  async function renameActiveMatrix(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setMatrixName(activeView?.name ?? "Untitled matrix");
      return;
    }
    let viewId = activeViewId;
    if (!viewId) {
      viewId = await ensureActiveMatrixView();
      if (!viewId) return;
    }
    if (trimmed === activeView?.name) return;
    try {
      const res = await jsonFetch<{ view: { id: string; name: string; dealIds: string[]; columnIds: string[]; updatedAt: string } }>(
        `/api/diligence-matrix/views/${viewId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      const view: MatrixView = {
        id: res.view.id,
        name: res.view.name,
        dealIds: res.view.dealIds,
        columnIds: res.view.columnIds,
        updatedAt: new Date(res.view.updatedAt).getTime(),
      };
      setActiveViewId(view.id);
      setMatrixViews((prev) => prev.map((item) => (item.id === view.id ? view : item)));
      setMatrixName(view.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMatrixName(activeView?.name ?? "Untitled matrix");
    }
  }

  function requestDeleteMatrixView(viewId: string) {
    const view = matrixViews.find((item) => item.id === viewId);
    if (!view) return;
    setDeleteConfirm({ id: view.id, name: view.name });
  }

  function cancelDeleteMatrixView() {
    setDeleteConfirm(null);
  }

  async function confirmDeleteMatrixView() {
    if (!deleteConfirm || busy === "delete-matrix") return;
    const { id: viewId, name } = deleteConfirm;
    setBusy("delete-matrix");
    setError(null);
    try {
      try {
        await jsonFetch(`/api/diligence-matrix/views/${viewId}`, { method: "DELETE" });
      } catch {
        /* local-only legacy id */
      }
      const next = matrixViews.filter((item) => item.id !== viewId);
      setMatrixViews(next);
      persistMatrixViewsLocal(next);
      setDeleteConfirm(null);
      if (activeViewId === viewId) {
        setActiveViewId(null);
        if (next[0]) {
          applyMatrixView(next[0]);
        } else {
          setViewMode("list");
          setMatrixName("");
        }
      }
      setMessage(`Deleted ${name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openNewMatrix() {
    const dealIds = defaultDealIdsForMatrix();
    const columnIds = defaultColumnIdsForMatrix();
    setSelectedDeals(new Set(dealIds));
    setSelectedColumns(new Set(columnIds));
    setViewMode("spreadsheet");
    setActiveViewId(null);
    setViewName("");
    setMatrixName("");
    await ensureActiveMatrixView();
  }

  useEffect(() => {
    if (!activeViewId || viewMode !== "spreadsheet") return;
    const timer = window.setTimeout(() => {
      void jsonFetch(`/api/diligence-matrix/views/${activeViewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealIds: [...selectedDeals], columnIds: [...selectedColumns] }),
      }).catch(() => null);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [activeViewId, selectedColumns, selectedDeals, viewMode]);

  async function uploadMatrixDocuments() {
    const dealIds = [...selectedDeals];
    if (!dealIds.length || !matrixFiles.length) {
      setError("Select at least one company and choose one or more PDFs.");
      return;
    }
    setBusy("matrix-doc-upload");
    setError(null);
    setMessage(null);
    try {
      let uploaded = 0;
      for (const dealId of dealIds) {
        for (const file of matrixFiles) {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("folderPath", "Matrix evidence");
          const upload = await fetch(`/api/crm/companies/${dealId}/documents/upload`, { method: "POST", body: fd });
          const uploadJson = (await upload.json().catch(() => null)) as { documentId?: string; error?: string } | null;
          if (!upload.ok || !uploadJson?.documentId) throw new Error(uploadJson?.error || `Failed to upload ${file.name}`);
          await jsonFetch(`/api/crm/documents/${uploadJson.documentId}/parse`, { method: "POST" });
          await jsonFetch(`/api/crm/documents/${uploadJson.documentId}/chunk`, { method: "POST" });
          await jsonFetch(`/api/crm/documents/${uploadJson.documentId}/ingest-deal-intel`, { method: "POST" });
          uploaded += 1;
        }
      }
      setMatrixFiles([]);
      setMessage(`Uploaded and indexed ${uploaded} document${uploaded === 1 ? "" : "s"} for matrix extraction.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function askMatrixQuestion() {
    const question = matrixQuestion.trim();
    if (!question) return;
    setBusy("ask-matrix");
    setError(null);
    setMessage("Adding columns from your question…");
    try {
      const res = await jsonFetch<{ columns: Array<{ label: string; dataType: Column["data_type"]; prompt: string }> }>("/api/diligence-matrix/decompose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (res.columns && res.columns.length > 0) {
        const added: string[] = [];
        const addedColumnIds: string[] = [];
        for (const col of res.columns) {
          const addedCol = await addColumnDirect(col);
          if (addedCol) {
            added.push(addedCol.label);
            addedColumnIds.push(addedCol.id);
          }
        }
        setMatrixQuestion("");
        if (addedColumnIds.length && visibleDeals.length) {
          setMessage(
            res.columns.length > 1
              ? `Added ${added.join(", ")}. Filling visible cells…`
              : `Added "${added[0]}". Filling visible cells…`,
          );
          setFilling(true);
          try {
            const pairs = visibleDeals.flatMap((deal) =>
              addedColumnIds.map((columnId) => ({ dealId: deal.id, columnId })),
            );
            await fillPairs(pairs);
          } finally {
            setFilling(false);
          }
        }
      }
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
      {viewMode === "list" ? (
        <div className="p-6 w-full max-w-5xl mx-auto space-y-8 h-[calc(100svh-4rem)] overflow-y-auto font-sans">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-450">Advanced Tabular Intelligence</span>
              <h1 className="text-xl font-extrabold tracking-tight text-zinc-950 uppercase mt-0.5">Matrix</h1>
            </div>
            <button type="button" onClick={() => void openNewMatrix()} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-zinc-950 rounded-xl shadow-md shadow-zinc-950/10 hover:bg-zinc-900 transition-all select-none">
              New matrix
            </button>
          </div>

          <div>
            <h2 className="text-xs font-extrabold text-zinc-400 uppercase tracking-widest mb-4">Saved matrices</h2>
            <div className="bg-white border border-zinc-200 rounded-2xl shadow-sm overflow-hidden">
               {matrixViews.length > 0 ? (
                 <div className="divide-y divide-zinc-150">
                    {matrixViews.map((view) => (
                       <div key={view.id} className="flex items-center gap-1 px-2 py-1 hover:bg-zinc-50 transition-colors">
                          <button
                            type="button"
                            onClick={() => applyMatrixView(view)}
                            className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-2 py-2 text-left"
                          >
                            <div className="min-w-0">
                              <h3 className="font-bold text-zinc-950 text-sm truncate">{view.name}</h3>
                              <p className="text-xs text-zinc-500 mt-1 font-medium">{view.dealIds.length} companies · {view.columnIds.length} columns</p>
                            </div>
                            <span className="shrink-0 text-[10px] font-bold text-zinc-500 bg-zinc-100 px-3 py-1 rounded-full uppercase tracking-wider">
                              {new Date(view.updatedAt).toLocaleDateString()}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => requestDeleteMatrixView(view.id)}
                            className="shrink-0 rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-600"
                            aria-label={`Delete ${view.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                       </div>
                    ))}
                 </div>
               ) : (
                  <div className="p-12 text-center text-zinc-400 text-xs font-semibold uppercase tracking-wider">No saved matrices yet. Create one to compare companies across columns.</div>
               )}
            </div>
          </div>
        </div>
      ) : (
        <>
      <header className="shrink-0 border-b border-zinc-200 bg-white font-sans">
        <div className="flex flex-col gap-4 px-6 py-4 xl:flex-row xl:items-center xl:justify-between border-b border-zinc-150">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 shadow-inner">
                <BarChart3 className="h-4.5 w-4.5 text-zinc-800" />
              </div>
              <div className="min-w-0">
                <label htmlFor="matrix-name-input" className="text-[10px] font-medium text-zinc-500">
                  Matrix name
                </label>
                <div className="mt-1 flex max-w-xs items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 transition-colors focus-within:border-zinc-400 focus-within:bg-white">
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
                  <input
                    id="matrix-name-input"
                    type="text"
                    value={matrixName}
                    onChange={(e) => setMatrixName(e.target.value)}
                    onBlur={() => void renameActiveMatrix(matrixName)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setMatrixName(activeView?.name ?? "Untitled matrix");
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="Untitled matrix"
                    className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-zinc-950 outline-none placeholder:text-zinc-400"
                    aria-label="Matrix name"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2.5 md:w-[380px]">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 px-3 py-1.5 text-center">
              <p className="text-[9px] font-extrabold text-zinc-450 uppercase tracking-widest">Filled</p>
              <p className="mt-0.5 text-xs font-extrabold text-zinc-950">{summary.filled}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 px-3 py-1.5 text-center">
              <p className="text-[9px] font-extrabold text-zinc-450 uppercase tracking-widest">Research</p>
              <p className="mt-0.5 text-xs font-extrabold text-zinc-950">{summary.needsResearch}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 px-3 py-1.5 text-center">
              <p className="text-[9px] font-extrabold text-zinc-450 uppercase tracking-widest">Empty</p>
              <p className="mt-0.5 text-xs font-extrabold text-zinc-950">{summary.empty}</p>
            </div>
          </div>
        </div>

        {/* Legora Floating Prompt Bar at the top of the spreadsheet page */}
        <div className="bg-zinc-50/50 px-6 py-4 border-b border-zinc-200">
          <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-[0_4px_24px_rgba(0,0,0,0.06)] flex items-center justify-between gap-3 focus-within:border-zinc-350 focus-within:shadow-[0_4px_28px_rgba(0,0,0,0.08)] transition-all">
            <div className="flex-1 flex items-center gap-3 pl-2">
              <Search className="h-4.5 w-4.5 text-zinc-400" />
              <input
                type="text"
                value={matrixQuestion}
                onChange={(e) => setMatrixQuestion(e.target.value)}
                placeholder="Ask a question — adds a column and fills from workspace + web"
                className="w-full text-xs outline-none placeholder:text-zinc-400 font-sans font-medium text-zinc-900 bg-transparent"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matrixQuestion.trim()) {
                    void askMatrixQuestion();
                  }
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-extrabold text-zinc-550 bg-zinc-50 border border-zinc-200 px-3 py-1.5 rounded-xl flex items-center gap-1.5 select-none uppercase tracking-wider">
                📎 {visibleDeals.length} companies
              </span>
              <button
                type="button"
                disabled={!matrixQuestion.trim() || Boolean(busy)}
                onClick={askMatrixQuestion}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-950 text-white hover:bg-zinc-900 active:scale-95 transition-all shadow-md shadow-zinc-950/15 disabled:opacity-40"
              >
                {busy === "ask-matrix" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {!focusMode && !historyCollapsed ? (
        <aside className="flex max-h-[32svh] shrink-0 flex-col border-b border-zinc-200 bg-white lg:max-h-none lg:w-[264px] lg:border-b-0 lg:border-r">
          <div className="border-b border-zinc-200 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-950">Saved matrices</h2>
              <button type="button" className="text-xs font-medium text-zinc-600 hover:text-zinc-950" onClick={() => void saveCurrentMatrixView()}>
                Save as
              </button>
            </div>
            <input
              className="mt-2 h-8 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-xs outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder="Name for Save as copy"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            <button type="button" onClick={() => void openNewMatrix()} className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50">
              <Plus className="h-3.5 w-3.5" />
              New matrix
            </button>
            {matrixViews.map((view) => (
              <div
                key={view.id}
                className={cn(
                  "group flex items-center gap-1 rounded-xl border p-1",
                  activeViewId === view.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white hover:bg-zinc-50",
                )}
              >
                <button type="button" onClick={() => applyMatrixView(view)} className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left">
                  <span className="block truncate text-sm font-semibold">{view.name}</span>
                  <span className={cn("block truncate text-xs", activeViewId === view.id ? "text-white/65" : "text-zinc-500")}>
                    {view.dealIds.length} companies · {view.columnIds.length} columns
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => requestDeleteMatrixView(view.id)}
                  className={cn("rounded-lg p-1.5", activeViewId === view.id ? "text-white/55 hover:text-white" : "text-zinc-400 hover:text-rose-600")}
                  aria-label={`Delete ${view.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {!matrixViews.length ? <p className="px-2 py-3 text-xs leading-relaxed text-zinc-500">Matrices you save appear here and sync across devices.</p> : null}
          </div>
        </aside>
        ) : null}
        {!setupCollapsed ? (
          <MatrixSetupPanel
            setupTab={setupTab}
            onSetupTab={setSetupTab}
            onClose={() => setSetupCollapsed(true)}
            newLabel={newLabel}
            onNewLabel={setNewLabel}
            onQuickAddColumn={quickAddColumn}
            busy={busy}
            columns={data.columns}
            selectedColumnIds={selectedColumns}
            onToggleColumn={toggleColumn}
            onDeleteColumn={deleteColumn}
            onApplyPreset={applyPreset}
            onAddSuggestedColumn={(col) => addColumn({ label: col.label, dataType: col.dataType as Column["data_type"], prompt: col.prompt })}
            columnQuery={columnQuery}
            onColumnQuery={setColumnQuery}
            filteredColumns={filteredColumns}
            onSelectAllColumns={selectAllFilteredColumns}
            onClearColumns={() => setSelectedColumns(new Set())}
            deals={data.deals}
            selectedDealIds={selectedDeals}
            onToggleDeal={toggleDeal}
            companyQuery={companyQuery}
            onCompanyQuery={setCompanyQuery}
            filteredDeals={filteredDeals}
            onSelectAllDeals={selectAllFilteredDeals}
            onClearDeals={() => setSelectedDeals(new Set())}
            matrixFiles={matrixFiles}
            onMatrixFiles={setMatrixFiles}
            onUploadDocuments={uploadMatrixDocuments}
            uploadBusy={busy === "matrix-doc-upload"}
          />
        ) : null}


        <main className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-zinc-200 bg-white px-4 py-3">
            <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className="mr-2 inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-900 transition-colors"
                >
                  <span className="mb-[1px]">←</span> Back
                </button>
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
                  type="button"
                  onClick={() => setSetupCollapsed((value) => !value)}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Setup
                </button>
                <button type="button" onClick={fillVisible} disabled={filling} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-zinc-900 text-white px-3 text-sm font-medium hover:bg-zinc-800 disabled:opacity-50">
                  {filling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  Fill (DB + web)
                </button>
                {!focusMode ? (
                  <button
                    type="button"
                    onClick={() => setHistoryCollapsed((value) => !value)}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
                  >
                    <BarChart3 className="h-4 w-4" />
                    Matrices
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setDetailsCollapsed((value) => !value)}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  {detailsCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
                  Details
                </button>
              </div>
            </div>
            {message ? <p className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
            {error ? <p className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-zinc-50 p-4 font-sans">
            <div className="min-h-full min-w-max rounded-2xl border border-zinc-200 bg-white overflow-hidden shadow-sm">
              <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgba(228,228,231,0.8)]">
                  <tr>
                    <th className="sticky left-0 z-20 w-48 min-w-48 max-w-48 border-b border-r border-zinc-200 bg-white px-3 py-2 text-left text-[10px] font-extrabold text-zinc-450 uppercase tracking-widest">
                      Company
                    </th>
                    {visibleColumns.map((column) => (
                      <th key={column.id} className="w-60 min-w-60 max-w-60 border-b border-r border-zinc-200 bg-white px-3 py-2 text-left align-middle">
                        <div className="flex items-center justify-between gap-2.5 min-w-0">
                          <div className="truncate text-[11px] font-bold text-zinc-950 flex items-center gap-1.5 uppercase tracking-wider">
                            <span className="opacity-80">🏷️</span>
                            <span>{column.label}</span>
                          </div>
                          {column.research_enabled ? <Search className="h-3 w-3 shrink-0 text-zinc-400" /> : null}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleDeals.map((deal, rowIndex) => (
                    <tr key={deal.id} className={rowIndex % 2 ? "bg-zinc-50/20" : "bg-white"}>
                      <td className="sticky left-0 z-[5] border-b border-r border-zinc-200 bg-inherit px-3 py-1.5 align-middle">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[9px] font-bold text-white shadow-sm shadow-zinc-900/25">
                            {deal.name.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="truncate text-xs font-bold text-zinc-950">{deal.name}</div>
                        </div>
                      </td>
                      {visibleColumns.map((column) => {
                        const cell = cellsByKey.get(`${deal.id}:${column.id}`) ?? null;
                        const active = activeSelection?.dealId === deal.id && activeSelection.columnId === column.id;
                        const valStr = (cell?.value_text || "").trim().toLowerCase();
                        const isTrue = valStr === "true" || valStr === "yes";
                        const isFalse = valStr === "false" || valStr === "no";

                        return (
                          <td key={column.id} className="w-60 min-w-60 max-w-60 border-b border-r border-zinc-200 p-0 align-middle">
                            <button
                              type="button"
                              onClick={() => setActiveSelection({ dealId: deal.id, columnId: column.id })}
                              onDoubleClick={() => {
                                  setActiveSelection({ dealId: deal.id, columnId: column.id });
                                  setDetailsCollapsed(false);
                              }}
                              className={cn(
                                "h-10 w-full overflow-hidden bg-white px-3 py-1 text-left transition-colors hover:bg-zinc-50/50 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-zinc-900/20",
                                active && "bg-zinc-50/60 ring-1 ring-inset ring-zinc-900/20",
                              )}
                            >
                              <div className="flex items-center justify-between gap-2 h-full w-full">
                                <div className="min-w-0 flex-1 flex items-center gap-2">
                                  {isTrue ? (
                                    <span className="inline-flex shrink-0 items-center bg-zinc-900 text-white border border-zinc-950 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider">
                                      True
                                    </span>
                                  ) : isFalse ? (
                                    <span className="inline-flex shrink-0 items-center bg-zinc-100 text-zinc-800 border border-zinc-200 px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider">
                                      False
                                    </span>
                                  ) : (
                                    <span className={cn("block truncate text-xs font-medium leading-none", cell ? "text-zinc-900" : "text-zinc-450")}>
                                      {cell?.value_text || cell?.error_message || "—"}
                                    </span>
                                  )}
                                </div>
                                <span className={cn("inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-widest", statusTone(cell))}>
                                  {statusLabel(cell)}
                                </span>
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

          {activeSelection && !detailsCollapsed ? (
            <div className="border-t border-zinc-200 bg-white p-4 xl:hidden">
              <CellDetails cell={activeCell} deal={activeDeal} column={activeColumn} />
            </div>
          ) : null}
        </main>

        {!detailsCollapsed ? (
        <aside className="hidden w-[390px] shrink-0 flex-col border-l border-zinc-200 bg-white xl:flex">
          <div className="border-b border-zinc-200 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-950">Cell details</h2>
                <p className="truncate text-xs text-zinc-500">{activeDeal && activeColumn ? `${activeDeal.name} / ${activeColumn.label}` : "Select a cell"}</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailsCollapsed(true)}
                className="rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:bg-zinc-50"
                aria-label="Hide cell details"
              >
                <PanelRightClose className="h-4 w-4" />
              </button>
            </div>
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
        ) : null}
        </div>
      </>
      )}

      {deleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-zinc-950/30 backdrop-blur-[1px]"
            onClick={cancelDeleteMatrixView}
            aria-label="Cancel delete"
          />
          <div
            role="dialog"
            aria-labelledby="delete-matrix-title"
            className="relative w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl"
          >
            <h3 id="delete-matrix-title" className="text-sm font-semibold text-zinc-950">
              Delete matrix?
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-600">
              <span className="font-medium text-zinc-900">{deleteConfirm.name}</span> will be permanently removed. This
              cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelDeleteMatrixView}
                disabled={busy === "delete-matrix"}
                className="inline-flex h-9 items-center rounded-xl border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteMatrixView()}
                disabled={busy === "delete-matrix"}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {busy === "delete-matrix" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
