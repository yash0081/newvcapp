import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import {
  INVESTMENT_RULES_SCORE_KEYS,
  PROMPT_INVESTMENT_RULE_KEYWORDS,
  PROMPT_INVESTMENT_RULES_EXTRACT,
  PROMPT_INVESTMENT_RULES_INJECTION_MAP,
  PROMPT_REPAIR_INVESTMENT_RULES_JSON,
} from "@/lib/deal-sourcing-prompts";
import { runWithPdf, runWithTextMulti } from "@/lib/gemini";

export type RuleSection = "problem" | "solution" | "founder";
export type ConditionSection = "problem" | "solution" | "founder" | "market";

export type InvestmentRuleRow = {
  rule: string;
  condition: string;
  rule_section: RuleSection;
  condition_section: ConditionSection;
  polarity: "positive" | "negative";
  target_score_key: string;
  specific_score_change: number;
  keywords: string[];
  notes?: string | null;
};

export type AggregatedRulesBySection = {
  problem: InvestmentRuleRow[];
  solution: InvestmentRuleRow[];
  founder: InvestmentRuleRow[];
};

const ALL_SCORE_KEYS = new Set<string>([
  ...INVESTMENT_RULES_SCORE_KEYS.problem,
  ...INVESTMENT_RULES_SCORE_KEYS.solution,
  ...INVESTMENT_RULES_SCORE_KEYS.founder,
]);

function normalizeKey(rule: InvestmentRuleRow): string {
  return [rule.rule, rule.condition, rule.target_score_key].join("|").toLowerCase().replace(/\s+/g, " ");
}

function validateRuleSectionKey(rule: InvestmentRuleRow): boolean {
  if (!ALL_SCORE_KEYS.has(rule.target_score_key)) return false;
  const sec = rule.rule_section;
  if (sec === "problem")
    return (INVESTMENT_RULES_SCORE_KEYS.problem as readonly string[]).includes(rule.target_score_key);
  if (sec === "solution")
    return (INVESTMENT_RULES_SCORE_KEYS.solution as readonly string[]).includes(rule.target_score_key);
  if (sec === "founder")
    return (INVESTMENT_RULES_SCORE_KEYS.founder as readonly string[]).includes(rule.target_score_key);
  return false;
}

function parseRulesPayload(raw: unknown): InvestmentRuleRow[] {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const arr = o && Array.isArray(o.rules) ? o.rules : [];
  const out: InvestmentRuleRow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const rule = typeof r.rule === "string" ? r.rule.trim() : "";
    const condition = typeof r.condition === "string" ? r.condition.trim() : "";
    const rule_section = r.rule_section as RuleSection;
    const condition_section = r.condition_section as ConditionSection;
    const polarity = r.polarity as "positive" | "negative";
    const target_score_key = typeof r.target_score_key === "string" ? r.target_score_key.trim() : "";
    const sc = typeof r.specific_score_change === "number" ? r.specific_score_change : 0;
    const notes = r.notes == null ? null : String(r.notes);
    if (!rule || !target_score_key) continue;
    if (rule_section !== "problem" && rule_section !== "solution" && rule_section !== "founder") continue;
    if (!["problem", "solution", "founder", "market"].includes(condition_section)) continue;
    if (polarity !== "positive" && polarity !== "negative") continue;
    const row: InvestmentRuleRow = {
      rule,
      condition: condition || "",
      rule_section,
      condition_section,
      polarity,
      target_score_key,
      specific_score_change: Math.max(-3, Math.min(3, Math.round(sc))),
      keywords: [],
      notes,
    };
    if (!validateRuleSectionKey(row)) continue;
    out.push(row);
  }
  return out;
}

async function extractRulesJsonFromPdf(buffer: Buffer): Promise<InvestmentRuleRow[]> {
  let raw: unknown;
  try {
    raw = await runWithPdf(PROMPT_INVESTMENT_RULES_EXTRACT, buffer, "flash_lite", false);
  } catch {
    raw = null;
  }
  try {
    return parseRulesPayload(raw);
  } catch {
    /* fall through */
  }
  const text =
    typeof raw === "object" && raw !== null
      ? JSON.stringify(raw)
      : typeof raw === "string"
        ? raw
        : "";
  try {
    const repaired = await runWithTextMulti(
      PROMPT_REPAIR_INVESTMENT_RULES_JSON,
      [{ label: "raw_text", value: text || "{}" }],
      "flash_lite",
      false
    );
    return parseRulesPayload(repaired);
  } catch {
    return [];
  }
}

async function extractKeywordsForRule(rule: InvestmentRuleRow): Promise<string[]> {
  const ruleText = `${rule.rule} ${rule.condition}`.trim();
  if (!ruleText) return [];
  try {
    const raw = await runWithTextMulti(
      PROMPT_INVESTMENT_RULE_KEYWORDS,
      [{ label: "rule_text", value: ruleText }],
      "flash_lite",
      false
    );
    const o = raw as Record<string, unknown>;
    const k = o.keywords;
    if (!Array.isArray(k)) return [];
    const phrases = k
      .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
      .filter(Boolean)
      .slice(0, 5);
    return phrases;
  } catch {
    return [];
  }
}

/** Offline DSU merge of rules by embedding similarity (dedupe). */
export async function dedupeRulesByEmbedding(
  rules: InvestmentRuleRow[],
  threshold = 0.86
): Promise<InvestmentRuleRow[]> {
  if (rules.length <= 1) return rules;
  const embedded: { row: InvestmentRuleRow; emb: number[] }[] = [];
  for (const row of rules) {
    const t = `${row.rule} ${row.condition}`.slice(0, 2000);
    try {
      const emb = await embedText(t);
      embedded.push({ row: { ...row }, emb });
    } catch {
      embedded.push({ row: { ...row }, emb: [] });
    }
  }
  const n = embedded.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  function cos(a: number[], b: number[]): number {
    if (a.length !== b.length || !a.length) return 0;
    let dot = 0,
      an = 0,
      bn = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      an += a[i] * a[i];
      bn += b[i] * b[i];
    }
    if (an <= 0 || bn <= 0) return 0;
    return dot / (Math.sqrt(an) * Math.sqrt(bn));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (embedded[i].emb.length && embedded[j].emb.length && cos(embedded[i].emb, embedded[j].emb) >= threshold) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, InvestmentRuleRow[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(embedded[i].row);
    groups.set(r, g);
  }
  const merged: InvestmentRuleRow[] = [];
  for (const g of groups.values()) {
    const base = g[0];
    const kw = new Set<string>(base.keywords);
    for (const x of g.slice(1)) for (const k of x.keywords) kw.add(k);
    merged.push({ ...base, keywords: Array.from(kw).slice(0, 8) });
  }
  return merged;
}

function bucketBySection(rules: InvestmentRuleRow[]): AggregatedRulesBySection {
  const problem: InvestmentRuleRow[] = [];
  const solution: InvestmentRuleRow[] = [];
  const founder: InvestmentRuleRow[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const k = normalizeKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.rule_section === "problem") problem.push(r);
    else if (r.rule_section === "solution") solution.push(r);
    else founder.push(r);
  }
  return { problem, solution, founder };
}

export async function loadAggregatedRulesForUser(
  admin: SupabaseClient,
  userId: string
): Promise<AggregatedRulesBySection | null> {
  const { data, error } = await admin
    .from("user_investment_rules_context")
    .select("aggregated_by_section")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data?.aggregated_by_section) return null;
  const a = data.aggregated_by_section as Record<string, unknown>;
  const parseSec = (v: unknown): InvestmentRuleRow[] =>
    Array.isArray(v) ? (v as InvestmentRuleRow[]).filter((x) => x && typeof x === "object") : [];
  return {
    problem: parseSec(a.problem),
    solution: parseSec(a.solution),
    founder: parseSec(a.founder),
  };
}

export async function saveAggregatedRulesForUser(
  admin: SupabaseClient,
  userId: string,
  agg: AggregatedRulesBySection
): Promise<void> {
  const { error } = await admin.from("user_investment_rules_context").upsert(
    {
      user_id: userId,
      aggregated_by_section: agg as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) console.error("user_investment_rules_context upsert:", error);
}

/** Rebuild aggregate from all investment_rules rows for user. */
export async function rebuildUserAggregateFromDb(admin: SupabaseClient, userId: string): Promise<AggregatedRulesBySection> {
  const { data } = await admin
    .from("investment_rules")
    .select("rule_json, keywords")
    .eq("user_id", userId);
  const rows: InvestmentRuleRow[] = [];
  for (const row of data ?? []) {
    const j = row.rule_json as Record<string, unknown> | null;
    const kw = Array.isArray(row.keywords) ? (row.keywords as string[]) : [];
    if (!j) continue;
    const parsed = parseRulesPayload({ rules: [j] });
    const pr = parsed[0];
    if (pr) rows.push({ ...pr, keywords: kw.length ? kw : pr.keywords });
  }
  const deduped = await dedupeRulesByEmbedding(rows);
  const agg = bucketBySection(deduped);
  await saveAggregatedRulesForUser(admin, userId, agg);
  return agg;
}

export async function processInvestmentRuleDocument(opts: {
  admin: SupabaseClient;
  userId: string;
  documentId: string;
  pdfBuffer: Buffer;
}): Promise<{ rulesInserted: number }> {
  const { admin, userId, documentId, pdfBuffer } = opts;
  const extracted = await extractRulesJsonFromPdf(pdfBuffer);
  let withKw: InvestmentRuleRow[] = [];
  for (const r of extracted) {
    const keywords = await extractKeywordsForRule(r);
    withKw.push({ ...r, keywords });
  }
  withKw = await dedupeRulesByEmbedding(withKw);
  let inserted = 0;
  for (const r of withKw) {
    const { error } = await admin.from("investment_rules").insert({
      document_id: documentId,
      user_id: userId,
      rule_text: r.rule,
      condition_text: r.condition,
      rule_section: r.rule_section,
      condition_section: r.condition_section,
      polarity: r.polarity,
      target_score_key: r.target_score_key,
      specific_score_change: r.specific_score_change,
      keywords: r.keywords,
      rule_json: r as unknown as Record<string, unknown>,
    });
    if (!error) inserted++;
    else console.error("investment_rules insert:", error);
  }
  await rebuildUserAggregateFromDb(admin, userId);
  return { rulesInserted: inserted };
}

export type InjectionMapResult = {
  problem_injection: string;
  solution_injection: string;
  founder_injection: string;
  founder_cross_context: string;
};

export async function runInvestmentRulesInjectionMap(opts: {
  aggregated: AggregatedRulesBySection;
  phase1MarketSnippet: string;
  problemSignalSnippet: string;
  solutionSignalSnippet: string;
}): Promise<InjectionMapResult> {
  const empty: InjectionMapResult = {
    problem_injection: "",
    solution_injection: "",
    founder_injection: "",
    founder_cross_context: "",
  };
  const hasRules =
    opts.aggregated.problem.length +
      opts.aggregated.solution.length +
      opts.aggregated.founder.length >
    0;
  if (!hasRules) return empty;
  try {
    const raw = await runWithTextMulti(
      PROMPT_INVESTMENT_RULES_INJECTION_MAP,
      [
        { label: "aggregated_rules_by_section", value: opts.aggregated },
        { label: "phase1_market_snippet", value: opts.phase1MarketSnippet },
        { label: "problem_signal_snippet", value: opts.problemSignalSnippet },
        { label: "solution_signal_snippet", value: opts.solutionSignalSnippet },
      ],
      "flash",
      false
    );
    const o = raw as Record<string, unknown>;
    return {
      problem_injection: typeof o.problem_injection === "string" ? o.problem_injection : "",
      solution_injection: typeof o.solution_injection === "string" ? o.solution_injection : "",
      founder_injection: typeof o.founder_injection === "string" ? o.founder_injection : "",
      founder_cross_context: typeof o.founder_cross_context === "string" ? o.founder_cross_context : "",
    };
  } catch {
    return empty;
  }
}

export function buildFounderInvestmentSuffix(injection: InjectionMapResult): string {
  const parts: string[] = [];
  if (injection.founder_injection.trim())
    parts.push(`Fund rules (founder): ${injection.founder_injection.trim()}`);
  if (injection.founder_cross_context.trim())
    parts.push(`Cross-context (problem/market for founder rules): ${injection.founder_cross_context.trim()}`);
  return parts.join("\n");
}

/** Optional suffix for Founder A/B: aggregated founder rules + cross-injection map output. */
export function formatFounderInvestmentCriteriaSuffix(
  agg: AggregatedRulesBySection | null,
  injection: InjectionMapResult
): string | undefined {
  const parts: string[] = [];
  if (agg?.founder?.length) {
    parts.push(
      `Founder-section rules (rubric overlay only; not deck facts): ${JSON.stringify(agg.founder)}`
    );
  }
  const inj = buildFounderInvestmentSuffix(injection);
  if (inj.trim()) parts.push(inj);
  const s = parts.join("\n\n").trim();
  return s || undefined;
}
