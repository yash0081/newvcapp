export type MatrixColumnSpec = {
  label: string;
  prompt?: string;
  dataType?: "text" | "number" | "percent" | "currency" | "boolean";
};

export type MatrixRoutePlanFields = {
  action: "none" | "read" | "create";
  viewId: string | null;
  dealIds: string[];
  name: string | null;
  columnTheme: string | null;
  explicitColumns: MatrixColumnSpec[];
  clarify: Array<"companies" | "columns" | "which_matrix">;
  useMatrixIfRelevant: boolean;
};

/** User wants a new tabular matrix (not read an existing saved view). */
export function messageRequestsMatrixCreate(message: string): boolean {
  const msg = message.trim();
  if (!msg) return false;
  return (
    /\b(make|create|build|set up|setup|start|add)\b[\s\S]{0,160}\b(matrix|matrices|tabular(?:\s+review)?|comparison\s+table|spreadsheet)\b/i.test(
      msg,
    ) ||
    /\b(matrix|matrices|tabular(?:\s+review)?)\b[\s\S]{0,120}\b(with|for|of|between|comparing|including|being)\b/i.test(
      msg,
    )
  );
}

function normalizeMatchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function scoreNameMatch(candidate: string, hint: string): number {
  const name = normalizeMatchText(candidate);
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

/** Company names/phrases from "matrix for X and Y" style requests. */
export function extractMatrixCreateCompanyHints(message: string): string[] {
  const trimmed = message.trim();
  const segmentPatterns = [
    /\b(?:matrix|matrices|tabular(?:\s+review)?)\b[^.?!]*?\b(?:being|for|with|of|between|comparing)\s+(.+)/i,
    /\b(?:make|create|build)\b[^.?!]*?\b(?:matrix|matrices)\b[^.?!]*?\b(?:being|for|with|of|between|comparing)\s+(.+)/i,
    /\bcompare\s+(.+)/i,
  ];
  let segment = "";
  for (const pattern of segmentPatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      segment = match[1].trim();
      break;
    }
  }
  if (!segment) return [];

  segment = segment
    .split(
      /\s+with\s+(?=(?:the\s+)?(?:columns?|fields?|metrics?|TAM|SAM|SOM|ARR|MRR|[A-Z]{2,}\b|maybe|a\s+few))/i,
    )[0]!
    .trim();

  return segment
    .split(/\s+(?:and|&|,|versus|vs\.?)\s+/i)
    .map((part) => part.replace(/^(?:being\s+)/i, "").trim())
    .filter((part) => part.length >= 2 && !/^(?:matrix|matrices|columns?|metrics?)$/i.test(part));
}

export function matchDealsFromHints(
  deals: Array<{ id: string; name: string }>,
  hints: string[],
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const hint of hints) {
    const scored = deals
      .map((deal) => ({ deal, score: scoreNameMatch(deal.name, hint) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) continue;
    if (best.score >= 55 && (scored.length === 1 || best.score > scored[1]!.score + 8)) {
      if (!out.some((deal) => deal.id === best.deal.id)) out.push(best.deal);
    }
  }
  return out;
}

const COLUMN_ACRONYM_RE = /\b(TAM|SAM|SOM|ARR|MRR|GMV|EBITDA|CAC|LTV|NRR|ACV)\b/gi;

export function extractMatrixColumnHints(message: string): {
  explicitColumns: MatrixColumnSpec[];
  columnTheme: string | null;
} {
  const explicitColumns: MatrixColumnSpec[] = [];
  const seen = new Set<string>();

  for (const raw of message.match(COLUMN_ACRONYM_RE) ?? []) {
    const label = raw.toUpperCase();
    if (seen.has(label)) continue;
    seen.add(label);
    explicitColumns.push({
      label,
      dataType: /^(TAM|SAM|SOM|GMV|ARR|MRR)$/i.test(label) ? "currency" : "text",
    });
  }

  for (const quoted of message.match(/"([^"]{2,48})"/g) ?? []) {
    const label = quoted.replace(/"/g, "").trim();
    if (!label || seen.has(normalizeMatchText(label))) continue;
    seen.add(normalizeMatchText(label));
    explicitColumns.push({ label, dataType: "text" });
  }

  let columnTheme: string | null = null;
  if (/\b(?:\d\s*[-–]\s*\d|one|two|a few|some|other|additional|extra)\s+columns?\b/i.test(message)) {
    const themeMatch = message.match(
      /\b(?:columns?|metrics?|themes?)\s+(?:that\s+)?(?:fit|match|work for|for)\s+(.+?)(?:[.?!]|$)/i,
    );
    columnTheme =
      themeMatch?.[1]?.trim().slice(0, 500) ||
      "Additional diligence columns that fit the comparison theme described in the user request";
  } else if (!explicitColumns.length && /\b(columns?|metrics?|fields?)\b/i.test(message)) {
    const withCols = message.match(/\bwith\s+(.+?)(?:[.?!]|$)/i);
    columnTheme = withCols?.[1]?.trim().slice(0, 500) || null;
  }

  return { explicitColumns, columnTheme };
}

export function enrichMatrixCreateFromMessage<T extends MatrixRoutePlanFields>(
  plan: T,
  message: string,
  allDeals: Array<{ id: string; name: string }>,
  allowedDealIds: Set<string>,
  matchDealsFromMessage: (deals: Array<{ id: string; name: string }>, text: string) => Array<{ id: string; name: string }>,
): T {
  if (!messageRequestsMatrixCreate(message) || plan.action === "read") return plan;

  const companyHints = extractMatrixCreateCompanyHints(message);
  const matchedDeals = [
    ...matchDealsFromMessage(allDeals, message),
    ...matchDealsFromHints(allDeals, companyHints),
  ];
  const dealIds = [...plan.dealIds];
  for (const deal of matchedDeals) {
    if (allowedDealIds.has(deal.id) && !dealIds.includes(deal.id)) dealIds.push(deal.id);
  }

  const parsedColumns = extractMatrixColumnHints(message);
  const explicitColumns = plan.explicitColumns.length ? plan.explicitColumns : parsedColumns.explicitColumns;
  const columnTheme = plan.columnTheme?.trim() || parsedColumns.columnTheme;

  const next = { ...plan, dealIds, explicitColumns, columnTheme, useMatrixIfRelevant: false, viewId: null };
  const namedCompanies = companyHints.length >= 2 ? companyHints : [];
  const missingPipelineCompanies =
    namedCompanies.length >= 2 && dealIds.length < Math.min(2, namedCompanies.length);

  if (dealIds.length < 2) {
    next.action = "none";
    next.clarify = [...new Set([...plan.clarify, "companies" as const])];
  } else if (!explicitColumns.length && !columnTheme?.trim()) {
    next.action = "none";
    next.clarify = [...new Set([...plan.clarify, "columns" as const])];
  } else {
    next.action = "create";
    next.clarify = plan.clarify.filter((field) => field !== "which_matrix");
    if (!next.name?.trim()) {
      const names = dealIds
        .map((id) => allDeals.find((deal) => deal.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      if (names.length >= 2) next.name = `Matrix: ${names.slice(0, 3).join(" vs ")}`;
    }
  }

  if (missingPipelineCompanies && dealIds.length < 2) {
    next.action = "none";
    if (!next.clarify.includes("companies")) next.clarify.push("companies");
  }

  return next;
}

export function buildMatrixToolBrief(args: {
  action: "none" | "read" | "create";
  viewName: string | null;
  viewId: string | null;
}): string | null {
  if (args.action === "read" && args.viewId) {
    const label = args.viewName ? `"${args.viewName}"` : "a saved matrix";
    return [
      `MATRIX TOOL (authoritative): The user is asking about the saved tabular-review matrix ${label} (workspace Matrix tool).`,
      "This is NOT a company name, product called matrix, business concept, or reason to research the focused company.",
      "Do NOT run or suggest research, quick lookup, or company diligence to explain what matrix means.",
      "Answer only from the matrix snapshot card, open-matrix link, and saved matrix data below.",
    ].join(" ");
  }
  if (args.action === "create") {
    return [
      "MATRIX TOOL (authoritative): The user wants to CREATE a new tabular comparison matrix in the workspace.",
      "Column names in the request (e.g. TAM, SAM) are matrix column headers — NOT a request to run research workflows first.",
      "Do NOT enable or suggest multi-step research, quick lookup, or company deep dives to populate the matrix.",
      "The matrix is created immediately with an open link; the user fills cells from the matrix view when ready.",
    ].join(" ");
  }
  return null;
}
