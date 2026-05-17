import type { MatrixColumn } from "@/lib/diligence-matrix/matrix";

export type DefaultColumnSpec = {
  label: string;
  dataType: MatrixColumn["data_type"];
  prompt: string;
  researchEnabled?: boolean;
};

/** First-time matrix columns — comparable VC diligence fields, company-scoped. */
export const DEFAULT_MATRIX_COLUMNS: DefaultColumnSpec[] = [
  {
    label: "Stage",
    dataType: "text",
    prompt:
      "Company stage (e.g. Pre-seed, Seed, Series A). Use only this company's saved records and documents.",
  },
  {
    label: "Last funding",
    dataType: "text",
    prompt:
      "Most recent funding round: amount, date, and lead investors if known. This company only — do not use other portfolio companies.",
  },
  {
    label: "Revenue / ARR",
    dataType: "text",
    prompt:
      "Latest revenue or ARR with period (e.g. $12M ARR, FY2024). If unknown, say not found.",
  },
  {
    label: "Headcount",
    dataType: "number",
    prompt: "Current team or employee headcount for this company only.",
  },
  {
    label: "Problem",
    dataType: "text",
    prompt: "One concise sentence on the customer problem this company solves.",
  },
  {
    label: "Business model",
    dataType: "text",
    prompt: "How this company makes money: pricing, GTM, and primary customer type.",
  },
];

export const MATRIX_COLUMN_PRESETS: Record<string, DefaultColumnSpec[]> = {
  financial: [
    {
      label: "YoY revenue growth",
      dataType: "percent",
      prompt: "Year-over-year revenue growth for this company. Prefer latest reported period.",
    },
    {
      label: "Gross margin",
      dataType: "percent",
      prompt: "Gross margin for this company if disclosed in saved materials.",
    },
  ],
  team: [
    {
      label: "Founder background",
      dataType: "text",
      prompt: "Brief founder background: relevant education and prior roles for this company only.",
    },
    {
      label: "Team size",
      dataType: "number",
      prompt: "Current team size for this company.",
    },
  ],
};

export const DEFAULT_COLUMN_LABELS = new Set(
  DEFAULT_MATRIX_COLUMNS.map((c) => c.label.toLowerCase()),
);

export function defaultColumnLimit(focusMode = false): number {
  return focusMode ? 4 : 6;
}

export function pickDefaultColumnIds(
  columns: Array<{ id: string; label: string }>,
  limit = defaultColumnLimit(),
): string[] {
  const preferred: string[] = [];
  for (const spec of DEFAULT_MATRIX_COLUMNS) {
    const match = columns.find((column) => column.label.toLowerCase() === spec.label.toLowerCase());
    if (match) preferred.push(match.id);
  }
  const rest = columns.map((column) => column.id).filter((id) => !preferred.includes(id));
  return [...preferred, ...rest].slice(0, limit);
}

/** Per-matrix column selection — avoids loading every global column on each view. */
export function resolveMatrixColumnIds(
  columnIds: string[],
  columns: Array<{ id: string; label: string }>,
  options?: { focusMode?: boolean; maxColumns?: number },
): string[] {
  const limit = defaultColumnLimit(options?.focusMode);
  const maxColumns = options?.maxColumns ?? 12;
  const valid = columnIds.filter((id) => columns.some((column) => column.id === id));
  if (!valid.length) return pickDefaultColumnIds(columns, limit);
  // Legacy views that saved nearly every column in the workspace
  if (columns.length > limit + 1 && valid.length >= columns.length - 1) {
    return pickDefaultColumnIds(columns, limit);
  }
  return valid.slice(0, maxColumns);
}
