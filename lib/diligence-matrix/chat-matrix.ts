import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithText } from "@/lib/vertex";
import { pickDefaultColumnIds } from "@/lib/diligence-matrix/defaults";
import {
  createMatrixColumn,
  listMatrixCells,
  listMatrixDeals,
  seedDefaultMatrixColumns,
  type MatrixCell,
  type MatrixColumn,
} from "@/lib/diligence-matrix/matrix";
import { createMatrixView, listMatrixViews, type MatrixSavedView } from "@/lib/diligence-matrix/views";
import type { MatrixRoutePlanFields } from "@/lib/diligence-matrix/matrix-chat-intent";

export {
  buildMatrixToolBrief,
  enrichMatrixCreateFromMessage,
  extractMatrixCreateCompanyHints,
  messageRequestsMatrixCreate,
} from "@/lib/diligence-matrix/matrix-chat-intent";
export type { MatrixRoutePlanFields } from "@/lib/diligence-matrix/matrix-chat-intent";

export type MatrixColumnSpec = {
  label: string;
  prompt?: string;
  dataType?: MatrixColumn["data_type"];
};

export type MatrixContextRow = {
  dealId: string;
  dealName: string;
  columnId: string;
  columnLabel: string;
  valueText: string | null;
  status: string;
  sourceKind: string;
};

export type MatrixChatContext = {
  viewId: string | null;
  viewName: string | null;
  rows: MatrixContextRow[];
  filledCount: number;
  emptyCount: number;
  viewsIndex: Array<{ id: string; name: string; dealCount: number; columnCount: number }>;
  companyOrder: Array<{ id: string; name: string }>;
  columnOrder: Array<{ id: string; label: string }>;
};

export type MatrixSnapshotGrid = {
  viewName: string | null;
  companyNames: string[];
  columnLabels: string[];
  values: Array<Array<string | null>>;
  filledCount: number;
  truncated: boolean;
};

const MAX_CONTEXT_ROWS = 40;

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function truncateLabel(label: string, max = 48): string {
  const trimmed = label.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 3).trim()}...` : trimmed;
}

function parseDataType(raw: unknown): MatrixColumn["data_type"] {
  const t = typeof raw === "string" ? raw : "text";
  return t === "text" || t === "number" || t === "percent" || t === "currency" || t === "boolean" ? t : "text";
}

export async function decomposeMatrixColumns(question: string): Promise<MatrixColumnSpec[]> {
  const trimmed = question.trim();
  if (!trimmed) return [];

  const prompt = `You are an AI analyst that decomposes broad VC due diligence or company research questions into highly specific, measurable tabular matrix columns.

A user has asked a question: "${trimmed}"

If the question is narrow, specific, or already highly granular (e.g. "EBITDA margin", "Revenue growth YoY", "Beat/miss goals", "HQ city"), do NOT decompose it. Return the original question as the single item.

If the question is broad or compound (e.g. "Founder background", "Market size and traction", "Financial performance", "Hiring and team"), decompose it into 2 to 4 distinct, concrete, highly specific columns.
Each decomposed column must have:
- label: Short 2-4 word column label (e.g. "Founder Degree" instead of "Tell me their degree")
- dataType: "text" | "number" | "percent" | "currency" | "boolean"
- prompt: A highly specific prompt instructions to find that exact data point.

Return strict JSON only matching the schema:
{
  "decomposed": [
    {
      "label": "Column label",
      "dataType": "text|number|percent|currency|boolean",
      "prompt": "Specific instructions..."
    }
  ]
}`;

  const modelName = process.env.GEMINI_MODEL_FLASH_LITE || "gemini-2.5-flash-lite";
  const raw = await vertexRunWithText(modelName, prompt, false);
  const parsed = parseJsonFromResponseOrNull(raw) as {
    decomposed?: Array<{ label: string; dataType: string; prompt: string }>;
  } | null;

  if (!parsed || !Array.isArray(parsed.decomposed) || parsed.decomposed.length === 0) {
    const originalLabel = truncateLabel(trimmed);
    return [{ label: originalLabel, dataType: "text", prompt: trimmed }];
  }

  return parsed.decomposed.map((c) => {
    const label = truncateLabel((c.label || "").trim() || trimmed);
    return {
      label,
      dataType: parseDataType(c.dataType),
      prompt: ((c.prompt || "").trim() || trimmed).slice(0, 2000),
    };
  });
}

export async function resolveColumnsForMatrix(
  admin: SupabaseClient,
  userId: string,
  spec: {
    columnTheme?: string | null;
    explicitColumns?: MatrixColumnSpec[];
  },
): Promise<string[]> {
  const columns = await seedDefaultMatrixColumns(admin, userId);
  const byLabel = new Map(columns.map((c) => [normalizeLabel(c.label), c]));

  let specs: MatrixColumnSpec[] = [];
  if (spec.explicitColumns?.length) {
    specs = spec.explicitColumns;
  } else if (spec.columnTheme?.trim()) {
    specs = await decomposeMatrixColumns(spec.columnTheme.trim());
  }

  if (!specs.length) {
    return pickDefaultColumnIds(columns, 6);
  }

  const ids: string[] = [];
  for (const item of specs) {
    const label = truncateLabel(item.label);
    if (!label) continue;
    const existing = byLabel.get(normalizeLabel(label));
    if (existing) {
      if (!ids.includes(existing.id)) ids.push(existing.id);
      continue;
    }
    const created = await createMatrixColumn(admin, userId, {
      label,
      description: (item.prompt || label).slice(0, 500),
      dataType: parseDataType(item.dataType),
      prompt: (item.prompt || label).slice(0, 2000),
      researchEnabled: true,
    });
    byLabel.set(normalizeLabel(created.label), created);
    ids.push(created.id);
  }

  return ids.length ? ids : pickDefaultColumnIds(columns, 6);
}

export function buildMatrixHref(args: {
  viewId: string;
  dealIds: string[];
  singleDealId?: string | null;
}): string {
  const q = `view=${encodeURIComponent(args.viewId)}`;
  if (args.dealIds.length === 1 && args.singleDealId) {
    return `/home/deal-intel/${args.singleDealId}/tabular?${q}`;
  }
  if (args.dealIds.length === 1) {
    return `/home/deal-intel/${args.dealIds[0]}/tabular?${q}`;
  }
  return `/home/matrix?${q}`;
}

export function formatMatrixViewsIndex(views: MatrixSavedView[]): string {
  if (!views.length) return "(no saved matrices)";
  return views
    .slice(0, 24)
    .map((v) => `- ${v.name} (id=${v.id}, ${v.dealIds.length} companies, ${v.columnIds.length} columns)`)
    .join("\n");
}

function normalizeMatchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function scoreViewNameMatch(viewName: string, hint: string): number {
  const name = normalizeMatchText(viewName);
  const query = normalizeMatchText(hint);
  if (!name || !query) return 0;
  if (name === query) return 100;
  if (name.includes(query) || query.includes(name)) return 75;
  const queryTokens = query.split(" ").filter(Boolean);
  const nameTokens = new Set(name.split(" ").filter(Boolean));
  if (!queryTokens.length) return 0;
  const shared = queryTokens.filter((token) => nameTokens.has(token)).length;
  if (shared === queryTokens.length) return 55 + shared * 5;
  return 0;
}

export function fuzzyMatchView(views: MatrixSavedView[], hint: string): MatrixSavedView | null {
  const scored = views
    .map((view) => ({ view, score: scoreViewNameMatch(view.name, hint) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0]!;
  if (best.score >= 75) return best.view;
  if (best.score >= 55 && (scored.length === 1 || best.score > scored[1]!.score + 8)) return best.view;
  return null;
}

/** Pulls the subject from "tell me about X" / "what is X" style requests. */
export function extractArtifactSubjectHint(message: string): string | null {
  const trimmed = message.trim();
  const patterns = [
    /\b(?:tell me about|what(?:'s| is| are)|who is|show me|open|view|see|describe|summarize|explain|look at)\s+(.+?)\s*$/i,
    /\babout\s+(.+?)\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const subject = match?.[1]?.trim().replace(/[?.!]+$/, "");
    if (subject && subject.length >= 2) return subject;
  }
  return null;
}

export function resolveMatrixViewFromMessage(
  message: string,
  views: MatrixSavedView[],
): MatrixSavedView | null {
  if (!views.length) return null;
  const normalizedMessage = normalizeMatchText(message);
  for (const view of views) {
    const name = normalizeMatchText(view.name);
    if (name.length >= 2 && normalizedMessage.includes(name)) return view;
  }
  const subjectHint = extractArtifactSubjectHint(message);
  if (subjectHint) {
    const fromSubject = fuzzyMatchView(views, subjectHint);
    if (fromSubject) return fromSubject;
  }
  return fuzzyMatchView(views, message);
}

export function messageReferencesSavedMatrix(message: string, views: MatrixSavedView[]): boolean {
  return resolveMatrixViewFromMessage(message, views) !== null;
}

export type MatrixSnapshotRow = {
  dealName: string;
  columnLabel: string;
  valueText: string | null;
  status: string;
};

export type MatrixSnapshotPayload = {
  viewName: string | null;
  rows: MatrixSnapshotRow[];
  filledCount: number;
  truncated: boolean;
};

const MATRIX_SNAPSHOT_UI_MAX_ROWS = 12;

export function buildMatrixSnapshotPayload(
  rows: MatrixContextRow[],
  options?: { viewName?: string | null; maxRows?: number },
): MatrixSnapshotPayload {
  const maxRows = options?.maxRows ?? MATRIX_SNAPSHOT_UI_MAX_ROWS;
  const slice = rows.slice(0, maxRows);
  return {
    viewName: options?.viewName ?? null,
    rows: slice.map((row) => ({
      dealName: row.dealName,
      columnLabel: row.columnLabel,
      valueText: row.valueText,
      status: row.status,
    })),
    filledCount: rows.length,
    truncated: rows.length > maxRows,
  };
}

export function buildMatrixSnapshotGrid(
  rows: MatrixContextRow[],
  options: {
    viewName?: string | null;
    companyNames: string[];
    columnLabels: string[];
    maxCompanies?: number;
  },
): MatrixSnapshotGrid {
  const maxCompanies = options.maxCompanies ?? 12;
  const companyNames = options.companyNames.slice(0, maxCompanies);
  const columnLabels = options.columnLabels;
  const valueByKey = new Map<string, string | null>();
  for (const row of rows) {
    valueByKey.set(`${row.dealName}::${row.columnLabel}`, row.valueText?.trim() || null);
  }
  const values = companyNames.map((company) =>
    columnLabels.map((column) => valueByKey.get(`${company}::${column}`) ?? null),
  );
  const filledCount = values.reduce(
    (count, row) => count + row.filter((value) => Boolean(value?.trim())).length,
    0,
  );
  return {
    viewName: options.viewName ?? null,
    companyNames,
    columnLabels,
    values,
    filledCount,
    truncated: options.companyNames.length > maxCompanies,
  };
}

export function enrichMatrixRoutePlan<T extends MatrixRoutePlanFields>(
  plan: T,
  message: string,
  views: MatrixSavedView[],
  allowedDealIds: Set<string>,
): T {
  const resolved = resolveMatrixViewFromMessage(message, views);
  if (!resolved || plan.action === "create") return plan;

  const viewIdValid = plan.viewId ? views.some((view) => view.id === plan.viewId) : false;
  const shouldPromoteRead =
    plan.action === "read" ||
    (plan.action === "none" && !plan.clarify.length && (plan.useMatrixIfRelevant || Boolean(resolved)));

  if (!shouldPromoteRead && viewIdValid) return plan;

  const next = { ...plan };
  if (!viewIdValid || !next.viewId) next.viewId = resolved.id;
  if (next.action === "none" && resolved) next.action = "read";
  if (!next.dealIds.length && resolved.dealIds.length) {
    next.dealIds = resolved.dealIds.filter((id) => allowedDealIds.has(id));
  }
  if (next.action === "read" && next.clarify.includes("which_matrix")) {
    next.clarify = next.clarify.filter((field) => field !== "which_matrix");
  }
  return next;
}

function cellToRow(
  cell: MatrixCell,
  dealName: string,
  columnLabel: string,
): MatrixContextRow {
  return {
    dealId: cell.deal_id,
    dealName,
    columnId: cell.column_id,
    columnLabel,
    valueText: cell.value_text,
    status: cell.status,
    sourceKind: cell.source_kind,
  };
}

export function formatMatrixContextForPrompt(ctx: MatrixChatContext): string {
  if (!ctx.rows.length && !ctx.viewName) {
    return "No saved matrix cell data matched this request.";
  }
  const header = ctx.viewName
    ? `Matrix "${ctx.viewName}"${ctx.viewId ? ` (id=${ctx.viewId})` : ""}: ${ctx.filledCount} filled cells, ${ctx.emptyCount} empty/missing.`
    : `Matrix data: ${ctx.filledCount} filled cells across relevant companies.`;
  if (!ctx.companyOrder.length || !ctx.columnOrder.length) {
    return `${header}\n\n${ctx.rows
      .slice(0, 24)
      .map((row) => `${row.dealName} / ${row.columnLabel}: ${(row.valueText || "").trim() || "—"}`)
      .join("\n")}`;
  }
  const grid = buildMatrixSnapshotGrid(ctx.rows, {
    viewName: ctx.viewName,
    companyNames: ctx.companyOrder.map((company) => company.name),
    columnLabels: ctx.columnOrder.map((column) => column.label),
  });
  const lines = [
    header,
    `Companies (rows): ${grid.companyNames.join(", ") || "(none)"}`,
    `Columns: ${grid.columnLabels.join(", ") || "(none)"}`,
  ];
  for (let rowIndex = 0; rowIndex < grid.companyNames.length; rowIndex += 1) {
    const company = grid.companyNames[rowIndex]!;
    const parts = grid.columnLabels.map((column, columnIndex) => {
      const value = grid.values[rowIndex]?.[columnIndex];
      return `${column}=${value?.trim() || "—"}`;
    });
    lines.push(`${company}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

export async function loadMatrixContextForChat(
  admin: SupabaseClient,
  userId: string,
  opts: {
    viewId?: string | null;
    viewNameHint?: string | null;
    dealIds?: string[];
    message?: string;
    filledOnly?: boolean;
  },
): Promise<MatrixChatContext> {
  const [views, deals, columns] = await Promise.all([
    listMatrixViews(admin, userId),
    listMatrixDeals(admin, userId),
    seedDefaultMatrixColumns(admin, userId),
  ]);

  const viewsIndex = views.map((v) => ({
    id: v.id,
    name: v.name,
    dealCount: v.dealIds.length,
    columnCount: v.columnIds.length,
  }));

  const dealNameById = new Map(deals.map((d) => [d.id, d.name]));
  const columnLabelById = new Map(columns.map((c) => [c.id, c.label]));

  let selectedView: MatrixSavedView | null = null;
  if (opts.viewId) {
    selectedView = views.find((v) => v.id === opts.viewId) ?? null;
  } else if (opts.viewNameHint?.trim()) {
    selectedView = fuzzyMatchView(views, opts.viewNameHint);
  } else if (opts.message?.trim()) {
    selectedView = resolveMatrixViewFromMessage(opts.message, views);
  }

  const dealFilter = new Set<string>();
  if (selectedView?.dealIds.length) {
    for (const id of selectedView.dealIds) dealFilter.add(id);
  } else if (opts.dealIds?.length) {
    for (const id of opts.dealIds) dealFilter.add(id);
  }

  const columnFilter = new Set<string>();
  if (selectedView?.columnIds.length) {
    for (const id of selectedView.columnIds) columnFilter.add(id);
  }

  const cells = await listMatrixCells(
    admin,
    userId,
    dealFilter.size ? { dealIds: [...dealFilter] } : undefined,
  );

  const rows: MatrixContextRow[] = [];
  let filledCount = 0;
  let emptyCount = 0;

  for (const cell of cells) {
    if (dealFilter.size && !dealFilter.has(cell.deal_id)) continue;
    if (columnFilter.size && !columnFilter.has(cell.column_id)) continue;

    const isFilled = cell.status === "filled" && Boolean((cell.value_text || "").trim());
    if (opts.filledOnly !== false && !isFilled) {
      emptyCount += 1;
      continue;
    }
    if (!isFilled) emptyCount += 1;
    else filledCount += 1;

    rows.push(
      cellToRow(
        cell,
        dealNameById.get(cell.deal_id) ?? "Company",
        columnLabelById.get(cell.column_id) ?? "Column",
      ),
    );
    if (rows.length >= MAX_CONTEXT_ROWS) break;
  }

  // Prefer filled cells first when we hit the cap
  if (rows.length >= MAX_CONTEXT_ROWS) {
    filledCount = rows.filter((r) => r.valueText?.trim()).length;
  }

  const companyOrder = (selectedView?.dealIds.length
    ? selectedView.dealIds
    : [...dealFilter]
  )
    .map((id) => ({ id, name: dealNameById.get(id) ?? "Company" }))
    .filter((company) => company.name);

  const columnOrder = (selectedView?.columnIds.length
    ? selectedView.columnIds
    : [...columnFilter]
  )
    .map((id) => ({ id, label: columnLabelById.get(id) ?? "Column" }))
    .filter((column) => column.label);

  return {
    viewId: selectedView?.id ?? null,
    viewName: selectedView?.name ?? null,
    rows,
    filledCount,
    emptyCount,
    viewsIndex,
    companyOrder,
    columnOrder,
  };
}

export async function executeCreateMatrixFromProposal(
  admin: SupabaseClient,
  userId: string,
  args: {
    name: string;
    dealIds: string[];
    dealNames: string[];
    columnTheme?: string | null;
    explicitColumns?: MatrixColumnSpec[];
  },
): Promise<{ view: MatrixSavedView; href: string; columnCount: number }> {
  const dealIds = args.dealIds.filter(Boolean).slice(0, 25);
  if (!dealIds.length) throw new Error("At least one company is required");

  const columnIds = await resolveColumnsForMatrix(admin, userId, {
    columnTheme: args.columnTheme,
    explicitColumns: args.explicitColumns,
  });

  const viewName =
    args.name.trim() ||
    (args.dealNames.length > 1
      ? `Matrix: ${args.dealNames.slice(0, 3).join(" vs ")}`
      : args.dealNames[0]
        ? `Matrix: ${args.dealNames[0]}`
        : "Chat matrix");

  const view = await createMatrixView(admin, userId, {
    name: viewName,
    dealIds,
    columnIds,
  });

  const href = buildMatrixHref({
    viewId: view.id,
    dealIds: view.dealIds,
    singleDealId: dealIds.length === 1 ? dealIds[0] : null,
  });

  return { view, href, columnCount: columnIds.length };
}

export function formatMatrixSnapshotMarkdown(
  rows: MatrixContextRow[],
  options?: { title?: string; maxRows?: number },
): string {
  const max = options?.maxRows ?? 12;
  const slice = rows.slice(0, max);
  if (!slice.length) return options?.title ? `${options.title}\n\n(no filled cells yet)` : "(no filled cells yet)";
  const lines = [
    options?.title ?? "Matrix snapshot",
    "",
    "| Company | Column | Value |",
    "| --- | --- | --- |",
  ];
  for (const row of slice) {
    lines.push(`| ${row.dealName} | ${row.columnLabel} | ${(row.valueText || "—").replace(/\|/g, "/")} |`);
  }
  if (rows.length > max) lines.push(`\n_…and ${rows.length - max} more rows_`);
  return lines.join("\n");
}
