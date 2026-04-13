import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAggregatedRulesForUser } from "@/lib/investment-rules";
import { vertexRunWithText } from "@/lib/vertex";
import { formatInvestmentRulesForSystemPrompt } from "@/lib/agentic-chat-context";

const MEMO_SECTIONS = [
  "Executive summary",
  "Company overview",
  "Market & problem",
  "Product / solution",
  "Traction & metrics",
  "Team",
  "Assumptions and risks",
  "Comparable companies",
  "Investment thesis",
  "Recommendation",
] as const;

function jsonBlock(label: string, value: unknown, maxChars: number): string {
  if (value == null) return `${label}: (none)`;
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n… (truncated)`;
  return `${label}:\n${s}`;
}

function rowHasText(row: Record<string, unknown> | null | undefined): boolean {
  if (!row || typeof row !== "object") return false;
  return Object.values(row).some((v) => {
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "number") return !Number.isNaN(v);
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return false;
  });
}

function compactSimilarPeers(peers: unknown): unknown {
  if (!Array.isArray(peers)) return peers;
  return peers.slice(0, 12).map((p) => {
    if (!p || typeof p !== "object") return p;
    const o = p as Record<string, unknown>;
    return {
      company_name: o.company_name ?? o.name,
      decision: o.decision,
      problem_one_liner: o.problem_one_liner,
      solution_one_liner: o.solution_one_liner,
    };
  });
}

function contextHasSubstance(args: {
  problem: Record<string, unknown> | null;
  solution: Record<string, unknown> | null;
  traction: Record<string, unknown> | null;
  founders: Record<string, unknown>[];
  scores: Record<string, unknown>[];
  rawTruncated: string;
  similarPeers: unknown;
  dealMeta: Record<string, unknown>;
}): boolean {
  if (rowHasText(args.problem) || rowHasText(args.solution) || rowHasText(args.traction)) return true;
  if (args.founders.some((f) => rowHasText(f))) return true;
  if (args.scores.length > 0) return true;
  if (args.rawTruncated.trim().length > 4 && args.rawTruncated !== "{}") return true;
  if (args.similarPeers != null) {
    if (Array.isArray(args.similarPeers) && args.similarPeers.length > 0) return true;
    if (typeof args.similarPeers === "object" && Object.keys(args.similarPeers as object).length > 0)
      return true;
  }
  const d = args.dealMeta;
  if (typeof d.decision === "string" && d.decision.trim()) return true;
  if (typeof d.pass_reason === "string" && d.pass_reason.trim()) return true;
  if (typeof d.pass_reason_detail === "string" && d.pass_reason_detail.trim()) return true;
  if (typeof d.website === "string" && d.website.trim()) return true;
  return false;
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: dealId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: deal, error } = await admin
    .from("deals")
    .select("id, company_name, user_id, decision, pass_reason, pass_reason_detail, website")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: analysis } = await admin
    .from("deal_analyses")
    .select("id, raw_output, similar_peers_json")
    .eq("deal_id", dealId)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const analysisId = analysis?.id as string | undefined;

  const [problemRes, solutionRes, tractionRes, foundersRes, scoresRes] = await Promise.all([
    analysisId
      ? admin.from("deal_problem").select("*").eq("analysis_id", analysisId).limit(1).maybeSingle()
      : Promise.resolve({ data: null as null }),
    analysisId
      ? admin.from("deal_solution").select("*").eq("analysis_id", analysisId).limit(1).maybeSingle()
      : Promise.resolve({ data: null as null }),
    analysisId
      ? admin.from("deal_traction").select("*").eq("analysis_id", analysisId).limit(1).maybeSingle()
      : Promise.resolve({ data: null as null }),
    admin.from("founders").select("name, role, background_summary, linkedin_url, universities, yc_batch").eq("deal_id", dealId),
    analysisId
      ? admin
          .from("deal_scores")
          .select("dimension, raw_score, weighted_score, scoring_stage")
          .eq("analysis_id", analysisId)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const problem = (problemRes.data ?? null) as Record<string, unknown> | null;
  const solution = (solutionRes.data ?? null) as Record<string, unknown> | null;
  const traction = (tractionRes.data ?? null) as Record<string, unknown> | null;
  const founders = (foundersRes.data ?? []) as Record<string, unknown>[];
  const scores = (scoresRes.data ?? []) as Record<string, unknown>[];

  const raw = analysis?.raw_output;
  const rawTruncated =
    raw && typeof raw === "object" ? JSON.stringify(raw, null, 2).slice(0, 100_000) : "{}";

  const similarPeers = compactSimilarPeers(analysis?.similar_peers_json);

  const dealMeta = {
    company_name: deal.company_name,
    decision: deal.decision,
    pass_reason: deal.pass_reason,
    pass_reason_detail: deal.pass_reason_detail,
    website: deal.website,
  };

  const hasContext = contextHasSubstance({
    problem,
    solution,
    traction,
    founders,
    scores,
    rawTruncated,
    similarPeers,
    dealMeta,
  });

  const rules = await loadAggregatedRulesForUser(admin, user.id);
  const rulesBlock = formatInvestmentRulesForSystemPrompt(rules);

  const model =
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    process.env.GEMINI_MODEL_FLASH_LITE ||
    "gemini-2.5-flash-lite";

  const corpus = [
    jsonBlock("Deal", dealMeta, 20_000),
    jsonBlock("Problem row (latest analysis)", problem, 25_000),
    jsonBlock("Solution row (latest analysis)", solution, 25_000),
    jsonBlock("Traction row (latest analysis)", traction, 25_000),
    jsonBlock("Founders", founders, 30_000),
    jsonBlock("Scores", scores, 15_000),
    jsonBlock("Similar peers snapshot", similarPeers, 25_000),
    jsonBlock("Pipeline / profile JSON (may be partial for seed deals)", rawTruncated, 100_000),
  ].join("\n\n---\n\n");

  const insufficientRule = hasContext
    ? "Do **not** reply with a blanket phrase like \"Insufficient data in corpus.\" If a section is thin, write a short careful inference from the fields you do have and label uncertainty briefly (e.g. \"Limited traction detail in corpus — …\")."
    : "If almost nothing is present, say so briefly per section without repeating the same sentence ten times.";

  const prompt = `You are writing an internal VC investment memo draft for **${deal.company_name || "the company"}**.

${rulesBlock ? `${rulesBlock}\n\n` : ""}## Corpus (structured + raw)
Use this as the factual basis. Prefer relational rows when they conflict with stale JSON. You may synthesize connective prose, but do not invent concrete numbers, customers, or investors that are not implied by the corpus.

${corpus}

## Output format
Write **plain text** only. For each section below, start a line exactly in this form (uppercase SECTION, colon, space, title):
SECTION: <title>

Then put one or more short paragraphs for that section. Leave one blank line before the next SECTION line.

Required sections, in this order:
${MEMO_SECTIONS.map((s) => `- SECTION: ${s}`).join("\n")}

## Style
- Concise, professional, no bullet spam; short paragraphs.
- ${insufficientRule}
- No markdown headings (# or ##); use the SECTION lines only as structure.`;

  try {
    const memo = await vertexRunWithText(model, prompt, false);
    return NextResponse.json({ memo });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
