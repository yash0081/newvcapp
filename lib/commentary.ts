/**
 * Evidence-rich aggregation for deal-sourcing pipeline (Phase 1–4).
 * Surfaces from-deck content, *_evidence fields, scores, signal_completeness, and summaries.
 * Supports legacy pipeline fields where present.
 */

import { normalizeScore0to10 } from "@/lib/model-scores";

export interface CommentaryInputs {
  parsing_json: Record<string, unknown> | null;
  problem_extraction_json?: Record<string, unknown> | null;
  solution_extraction_json?: Record<string, unknown> | null;
  problem_web_json?: Record<string, unknown> | null;
  solution_web_json?: Record<string, unknown> | null;
  founder_web_json?: Record<string, unknown> | null;
  metrics_web_json?: Record<string, unknown> | null;
  thesis_fit_json?: Record<string, unknown> | null;
  founder_signal_json?: Record<string, unknown> | null;
  traction_signal_json?: Record<string, unknown> | null;
  problem_quality_3c_json?: Record<string, unknown> | null;
  solution_defensibility_json?: Record<string, unknown> | null;
  market_power_json?: Record<string, unknown> | null;
  core_assumption_json?: Record<string, unknown> | null;
  /** V2-2 aggregation prompt outputs (previews); separate from agent JSONs. */
  pipeline_summaries?: {
    founder?: string;
    traction?: string;
    problem?: string;
    solution?: string;
    assumptions?: string;
  } | null;
  questions_first_order_json?: Record<string, unknown> | null;
  questions_structural_json?: Record<string, unknown> | null;
  questions_combined_json?: Record<string, unknown> | null;
}

const SECTION_SEP = "\n\n";

function getStr(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Thesis UI: segment first, score in parentheses (no "Score:" — avoids accordion bold-label bugs). */
function formatThesisFitEvaluationLines(
  ind?: Record<string, unknown>,
  stg?: Record<string, unknown>,
  fund?: Record<string, unknown>
): string[] {
  const lines: string[] = [];
  if (ind && (ind.score != null || getStr(ind, "startup_industry"))) {
    const label = getStr(ind, "startup_industry") || "—";
    const sc = ind.score;
    lines.push(`Industry — ${label} (${sc ?? "—"}/10)`);
  }
  if (stg && (stg.score != null || getStr(stg, "stage"))) {
    const label = getStr(stg, "stage") || "—";
    const sc = stg.score;
    lines.push(`Stage — ${label} (${sc ?? "—"}/10)`);
  }
  if (fund && (fund.score != null || getStr(fund, "funding"))) {
    const label = getStr(fund, "funding") || "—";
    const sc = fund.score;
    lines.push(`Funding fit — ${label} (${sc ?? "—"}/10)`);
  }
  return lines;
}

/** Build thesis `details` text: optional preamble, then `Scores` + dimension lines (UI shows scores at bottom). */
function buildThesisDetailsBodyWithScores(args: {
  evalLines: string[];
  scorePreamble: string | null;
  hasStructuredScores: boolean;
}): string {
  const { evalLines, scorePreamble, hasStructuredScores } = args;
  const chunks: string[] = [];
  if (scorePreamble && !hasStructuredScores) chunks.push(scorePreamble);
  if (evalLines.length > 0) {
    chunks.push(`Scores\n${evalLines.join("\n")}`);
  }
  return chunks.join("\n\n");
}

/**
 * Models often prepend "Industry 5, Stage 1, Funding 1" before real reasoning.
 * Keep summary prose-first; optional score-only preamble is returned for details (append after structured lines).
 */
function partitionThesisAlignmentReasoning(reasoning: string): {
  prose: string;
  scorePreamble: string | null;
} {
  const trimmed = reasoning.trim();
  if (!trimmed) return { prose: "", scorePreamble: null };

  const blocks = trimmed.split(/\n\n+/);
  if (blocks.length >= 2) {
    const first = blocks[0];
    const looksLikeScoreDump =
      first.length < 520 &&
      /\d/.test(first) &&
      /industry/i.test(first) &&
      /stage/i.test(first) &&
      /fund/i.test(first) &&
      first.split(/[.!?]+/).filter((s) => s.trim().length > 20).length <= 2;
    if (looksLikeScoreDump) {
      return {
        prose: blocks.slice(1).join("\n\n").trim(),
        scorePreamble: first.trim(),
      };
    }
  }

  return { prose: trimmed, scorePreamble: null };
}

function pickCompanyName(input: CommentaryInputs): string | null {
  const co = input.parsing_json?.company_overview as Record<string, unknown> | undefined;
  if (co && typeof co.company_name === "string" && co.company_name.trim()) return co.company_name.trim();
  return getStr(input.parsing_json, "company_name")
    ?? (input.problem_extraction_json ? getStr(input.problem_extraction_json, "company_name") : null)
    ?? (input.solution_extraction_json ? getStr(input.solution_extraction_json, "company_name") : null);
}

function arrOfStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim());
}

/** Legacy: separate corpus blobs from older pipeline runs (no longer appended per section). */
export function formatUserCorpusContextBlock(c: unknown, title = "Similar deals in your corpus"): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  const summary = typeof o.summary === "string" && o.summary.trim() ? o.summary.trim() : null;
  const notes = Array.isArray(o.peer_pattern_notes) ? arrOfStrings(o.peer_pattern_notes) : [];
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (notes.length > 0) parts.push(notes.map((n) => "• " + n).join("\n"));
  if (parts.length === 0) return null;
  return `${title}\n${parts.join("\n\n")}`;
}

export function getUserCorpusSummarySentence(c: unknown): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const s = (c as Record<string, unknown>).summary;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

/** Details line: peer bullets only (when summary is already surfaced in section summary). */
export function formatUserCorpusPeerNotesOnly(c: unknown, title = "Corpus peer notes"): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const notes = Array.isArray((c as Record<string, unknown>).peer_pattern_notes)
    ? arrOfStrings((c as Record<string, unknown>).peer_pattern_notes)
    : [];
  if (notes.length === 0) return null;
  return `${title}\n${notes.map((n) => "• " + n).join("\n")}`;
}

/** Models / DB occasionally return a JSON object as a string — unwrap for downstream keys. */
function parseJsonObjectIfString<T extends Record<string, unknown>>(val: unknown): T | undefined {
  if (val && typeof val === "object" && !Array.isArray(val)) return val as T;
  if (typeof val === "string") {
    try {
      const p = JSON.parse(val) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) return p as T;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Remove common model echo where the assistant pastes the system prompt / schema after the real answer. */
export function stripModelPromptEcho(text: string): string {
  if (!text || typeof text !== "string") return text;
  let out = text;
  const cutPatterns = [
    /\n+(You are a Venture Capital[\s\S]*)$/i,
    /\n+(INPUTS:[\s\S]*)$/i,
    /\n+(\*{0,2}OUTPUT SCHEMA\*{0,2}:[\s\S]*)$/i,
    /\n+(OUTPUT SCHEMA:[\s\S]*)$/i,
    /\n+(SEARCH EXECUTION LIST[\s\S]*)$/i,
    /\n+(RULES:[\s\S]*)$/i,
    /\n+(CONSTRAINTS:[\s\S]*)$/i,
  ];
  for (const re of cutPatterns) {
    out = out.replace(re, "").trimEnd();
  }

  // Models sometimes emit bracketed citation markers like:
  //   "[parsed_startup_data, cite: 13, 14]"
  //   "[cite: team_roster_from_phase1_deck_json, 3]"
  // Strip any bracketed span that contains "cite:" (numeric or label-based).
  out = out.replace(/\[[^\]]*\bcite\s*:\s*[^\]]*\]/gi, "");
  // Bare trailing cite fragments (uncommon)
  out = out.replace(/\s*\[cite\s*:\s*[^\]]*\]/gi, "");
  // Google Search grounding often appends inline source-index lists like [1, 5, 6, 18] (not user-facing refs).
  out = out.replace(/\s*\[\s*\d{1,2}(?:\s*,\s*\d{1,2})+\s*\]/g, "");
  out = out.replace(/\s+\[\s*\d{1,2}\s*\](?=\s*[.!?]|,|\s*$)/g, "");
  // IMPORTANT: Do NOT collapse newlines into spaces; that destroys formatting in the UI
  // (e.g. competitor lists becoming "clumped" into a single line).
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  return out;
}

/** Keep aggregation / preview summaries short (UI); does not alter "No summary." */
export function clampSummarySentences(text: string, maxSentences = 3): string {
  const t = stripModelPromptEcho(text).trim();
  if (!t || t === "No summary.") return text;
  const parts = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [t];
  const trimmed = parts.map((s) => s.trim()).filter(Boolean);
  if (trimmed.length <= maxSentences) return trimmed.join(" ");
  return trimmed.slice(0, maxSentences).join(" ");
}

export function sanitizeStructuredAnalysis(s: StructuredAnalysis): StructuredAnalysis {
  const mapSection = (sec: AnalysisSection): AnalysisSection => ({
    summary:
      sec.summary === "No summary."
        ? sec.summary
        : clampSummarySentences(sec.summary, 3),
    details: stripModelPromptEcho(sec.details),
  });
  return {
    problem: mapSection(s.problem),
    solution: mapSection(s.solution),
    founderTeam: mapSection(s.founderTeam),
    traction: mapSection(s.traction),
    assumptions: mapSection(s.assumptions),
    thesisFit: mapSection(s.thesisFit),
    questions: mapSection(s.questions),
  };
}

/** Format an evidence object: only non-null/non-empty; optional label map for keys. */
function formatEvidence(
  obj: Record<string, unknown> | null | undefined,
  keyLabels?: Record<string, string>
): string[] {
  if (!obj || typeof obj !== "object") return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const label = keyLabels?.[key] ?? key.replace(/_/g, " ");
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const first = value[0];
      if (typeof first === "object" && first !== null && !Array.isArray(first)) {
        const rows = value.map((item, i) => {
          const o = item as Record<string, unknown>;
          const overlap =
            getStr(o, "corpus_peer_overlap") ?? getStr(o, "also_invested_in_corpus_peers");
          const name = getStr(o, "name") ?? getStr(o, "investor") ?? `Item ${i + 1}`;
          const cat = getStr(o, "category");
          const threat = getStr(o, "threat_assessment");
          if (overlap) {
            const rest = [cat, threat].filter(Boolean).join(" — ");
            return rest
              ? `${name} — ${rest} — also in corpus peers (${overlap})`
              : `${name} — also in corpus peers (${overlap})`;
          }
          const bits = [name, cat, threat].filter(Boolean);
          return bits.join(" — ");
        });
        // Investor lists should be horizontal (and should not contain "Label: " patterns)
        // so the UI doesn't bold arbitrary substrings (it parses `": "` as a label delimiter).
        if (label === "Investors") lines.push(`${label}: ${rows.join("; ")}`);
        else lines.push(`${label}:\n  ${rows.join("\n  ")}`);
      } else {
        const strs = arrOfStrings(value);
        if (strs.length > 0) lines.push(`${label}: ${strs.join("; ")}`);
      }
    } else if (typeof value === "boolean") {
      lines.push(`${label}: ${value ? "Yes" : "No"}`);
    } else if (typeof value === "string" && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    } else if (typeof value === "number") {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines;
}

/** Format nested evidence objects (e.g. TAM_evidence, winner_take_most_evidence). */
function formatNestedEvidence(
  parent: Record<string, unknown> | null | undefined,
  keys: string[],
  keyLabels?: Record<string, string>
): string[] {
  if (!parent) return [];
  const out: string[] = [];
  for (const key of keys) {
    const child = parent[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const label = keyLabels?.[key] ?? key.replace(/_/g, " ");
      const lines = formatEvidence(child as Record<string, unknown>, keyLabels);
      if (lines.length > 0) out.push(`${label}\n${lines.map((l) => "  " + l).join("\n")}`);
    }
  }
  return out;
}

function scoresLine(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!obj) return null;
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && !Number.isNaN(v)) {
      const n = normalizeScore0to10(v);
      parts.push(`${k.replace(/_/g, " ")}: ${Number.isInteger(n) ? n : n.toFixed(1)}`);
    } else if (typeof v === "string") {
      const parsed = parseFloat(v);
      if (!Number.isNaN(parsed)) {
        const n = normalizeScore0to10(parsed);
        parts.push(`${k.replace(/_/g, " ")}: ${Number.isInteger(n) ? n : n.toFixed(1)}`);
      }
    }
  }
  const completeness = getStr(obj, "signal_completeness");
  if (completeness) parts.push(`Completeness: ${completeness}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ——— Problem ———
function buildProblem(input: CommentaryInputs, out: string[]) {
  const company = pickCompanyName(input);
  const problemObj = input.parsing_json?.problem as Record<string, unknown> | undefined;
  const summary = problemObj ? getStr(problemObj, "problem_statement") : getStr(input.problem_extraction_json ?? null, "summary_problem");
  const targetCustomer = problemObj ? getStr(problemObj, "target_customer") : null;
  const painPoints = problemObj ? arrOfStrings(problemObj.pain_points) : [];

  const fromDeck: string[] = [];
  if (company) fromDeck.push(company);
  if (summary) fromDeck.push(summary);
  if (targetCustomer) fromDeck.push(`Target customer: ${targetCustomer}`);
  if (painPoints.length > 0) fromDeck.push("Pain points: " + painPoints.join("; "));
  if (fromDeck.length > 0) out.push("Problem (from deck)\n" + fromDeck.join(" "));

  const p3 = input.problem_quality_3c_json as Record<string, unknown> | undefined;
  // V2: problem_analysis, customer_analysis, scores, signal_interpretation
  const problemAnalysis = p3?.problem_analysis as Record<string, unknown> | undefined;
  const customerAnalysis = p3?.customer_analysis as Record<string, unknown> | undefined;
  if (problemAnalysis) {
    const lines = formatEvidence(problemAnalysis, {
      stated_problem_ref: "Stated problem",
      economic_gravity: "Economic gravity",
      structural_urgency: "Structural urgency",
      root_cause_depth: "Root cause depth",
    });
    if (lines.length > 0) out.push("Problem analysis\n" + lines.join("\n"));
  }
  if (customerAnalysis) {
    const lines = formatEvidence(customerAnalysis, {
      economic_buyer_persona: "Economic buyer persona",
      budget_priority_validation: "Budget priority validation",
      persona_clarity: "Persona clarity",
    });
    if (lines.length > 0) out.push("Customer analysis\n" + lines.join("\n"));
  }
  const ev = p3?.problem_evidence as Record<string, unknown> | undefined;
  if (ev && !problemAnalysis) {
    const lines = formatEvidence(ev, {
      stated_problem_summary: "Stated problem summary",
      affected_customer_persona: "Affected customer persona",
      economic_impact_described: "Economic impact described",
      mission_critical_indicators: "Mission critical indicators",
      explicit_budget_owner_mentioned: "Explicit budget owner",
      frequency_indicators: "Frequency indicators",
      scope_of_affected_users_described: "Scope of affected users",
      expansion_or_upsell_potential_described: "Expansion/upsell potential",
    });
    if (lines.length > 0) out.push("Problem evidence\n" + lines.join("\n"));
  }
  const pScores = (p3?.scores ?? p3) as Record<string, unknown> | undefined;
  const scoreStr = scoresLine(pScores, ["pain_severity_score", "buyer_authority_score", "structural_tailwinds_score", "venture_scale_plausibility", "budget_signal_score", "recurrence_score", "buyer_clarity_score", "venture_plausibility_score"]);
  if (scoreStr) out.push("Problem scores\n" + scoreStr);
  const sig = p3?.signal_interpretation as Record<string, unknown> | undefined;
  const pSummary = getStr(sig ?? null, "problem_quality_summary") ?? getStr(p3 ?? null, "problem_quality_summary") ?? getStr(input.problem_web_json ?? null, "problem_quality_commentary");
  if (pSummary) out.push("Problem summary\n" + pSummary);
}

// ——— Solution ———
function buildSolution(input: CommentaryInputs, out: string[]) {
  const solutionObj = input.parsing_json?.solution as Record<string, unknown> | undefined;
  const summary = solutionObj ? getStr(solutionObj, "solution_summary") : getStr(input.solution_extraction_json ?? null, "summary_solution");
  const productType = solutionObj ? getStr(solutionObj, "product_type") : null;
  const coreFeatures = solutionObj ? arrOfStrings(solutionObj.core_features) : [];
  const differentiation = solutionObj ? arrOfStrings(solutionObj.claimed_differentiation) : [];

  const fromDeck: string[] = [];
  if (summary) fromDeck.push(summary);
  if (productType) fromDeck.push(`Product type: ${productType}`);
  if (coreFeatures.length > 0) fromDeck.push("Core features: " + coreFeatures.join("; "));
  if (differentiation.length > 0) fromDeck.push("Differentiation: " + differentiation.join("; "));
  if (fromDeck.length > 0) out.push("Solution (from deck)\n" + fromDeck.join(" "));

  const s3 = input.solution_defensibility_json as Record<string, unknown> | undefined;
  const solAnalysis = s3?.solution_analysis as Record<string, unknown> | undefined;
  const defSignals = s3?.defensibility_signals as Record<string, unknown> | undefined;
  if (solAnalysis) {
    const lines = formatEvidence(solAnalysis, {
      stated_solution_ref: "Stated solution",
      technical_moat_evidence: "Technical moat evidence",
      competitor_landscape: "Competitor landscape",
      differentiation_proof_points: "Differentiation proof points",
    });
    if (lines.length > 0) out.push("Solution analysis\n" + lines.join("\n"));
  }
  if (defSignals) {
    const lines = formatEvidence(defSignals, {
      moat_type: "Moat type",
      compounding_potential: "Compounding potential",
      replication_difficulty: "Replication difficulty",
    });
    if (lines.length > 0) out.push("Defensibility signals\n" + lines.join("\n"));
  }
  const ev = s3?.solution_evidence as Record<string, unknown> | undefined;
  if (ev && !solAnalysis) {
    const lines = formatEvidence(ev, {
      stated_solution_summary: "Stated solution summary",
      core_technology_or_approach: "Core technology/approach",
      claimed_improvement_over_alternatives: "Claimed improvement over alternatives",
      identified_competitors: "Identified competitors",
      differentiation_claims_stated: "Differentiation claims",
      ip_or_proprietary_assets_detected: "IP/proprietary assets",
      network_effect_indicators: "Network effect indicators",
      data_advantage_indicators: "Data advantage indicators",
      regulatory_or_structural_barriers: "Regulatory/structural barriers",
      switching_cost_indicators: "Switching cost indicators",
      distribution_advantages_detected: "Distribution advantages",
    });
    if (lines.length > 0) out.push("Solution evidence\n" + lines.join("\n"));
  }
  const sScores = (s3?.scores ?? s3) as Record<string, unknown> | undefined;
  const scoreStr = scoresLine(sScores, ["10x_improvement_plausibility", "defensibility_potential", "competitive_edge_score", "moat_compounding_potential", "differentiation_clarity"]);
  if (scoreStr) out.push("Solution scores\n" + scoreStr);
  const sig = s3?.signal_interpretation as Record<string, unknown> | undefined;
  const sSummary = getStr(sig ?? null, "solution_summary") ?? getStr(s3 ?? null, "solution_summary") ?? getStr(input.solution_web_json ?? null, "solution_quality_commentary");
  if (sSummary) out.push("Solution summary\n" + sSummary);
}

// ——— Founder / team ———
function buildTeam(input: CommentaryInputs, out: string[]) {
  const parsing = input.parsing_json;
  const teamVal = parsing?.["team"] ?? parsing?.["team_members"];
  if (Array.isArray(teamVal) && teamVal.length > 0) {
    const memberLines = teamVal.slice(0, 8).map((mRaw) => {
      const m = mRaw as Record<string, unknown>;
      const name = typeof m.name === "string" ? m.name : getStr(m, "name") ?? "Unknown";
      const role = getStr(m, "role");
      const background = getStr(m, "background_summary");
      let line = role ? `${name} (${role})` : name;
      if (background) line += ` — ${background}`;
      return line;
    });
    out.push("Founder / team (from deck)\n" + memberLines.join("\n"));
  }

  const f3 = input.founder_signal_json as Record<string, unknown> | undefined;
  // V2: { per_founder: [...], collective: { team_evidence, scores, signal_interpretation } }
  const perFounder = Array.isArray(f3?.per_founder) ? f3.per_founder : [];
  const collective = parseJsonObjectIfString(f3?.collective);
  if (perFounder.length > 0) {
    const founderBlocks = perFounder.map((p, i) => {
      const r = p as Record<string, unknown>;
      const name = getStr(r, "founder_name") ?? `Founder ${i + 1}`;
      const lines = formatEvidence(r, {
        elite_institutions: "Elite institutions",
        intellectual_achievements: "Intellectual achievements",
        technical_proof_points: "Technical proof points",
        professional_velocity: "Professional velocity",
        exit_history: "Exit history",
        intelligence_score_proxy: "Intelligence score",
      });
      if (lines.length > 0) return `${name}\n${lines.join("\n")}`;
      try {
        const raw = JSON.stringify(r, null, 2);
        return `${name}\n${raw.length > 12000 ? `${raw.slice(0, 12000)}\n…` : raw}`;
      } catch {
        return `${name}`;
      }
    });
    out.push("Per-founder signal\n" + founderBlocks.join("\n\n"));
  }
  const teamEv =
    (collective?.team_evidence as Record<string, unknown> | undefined) ??
    (f3?.team_evidence as Record<string, unknown> | undefined);
  if (teamEv) {
    const lines = formatEvidence(teamEv, {
      elite_academic_pedigree: "Elite academic pedigree",
      high_bar_previous_employers: "High-bar previous employers",
      technical_authority_proof: "Technical authority proof",
      team_cohesion_signals: "Team cohesion signals",
      magnetism_proof_points: "Magnetism proof points",
    });
    if (lines.length > 0) out.push("Team evidence\n" + lines.join("\n"));
  }
  const ev = f3?.founder_evidence as Record<string, unknown> | undefined;
  if (ev && !collective) {
    const lines = formatEvidence(ev, {
      founder_names: "Founder names",
      prior_exits_detected: "Prior exits detected",
      elite_institutions_detected: "Elite institutions",
      notable_companies_detected: "Notable companies",
      technical_credentials_detected: "Technical credentials",
      awards_or_distinctions_detected: "Awards/distinctions",
      repeat_founder_flag: "Repeat founder",
      industry_recognition_signals: "Industry recognition",
      recruiting_signals_detected: "Recruiting signals",
    });
    if (lines.length > 0) out.push("Founder evidence\n" + lines.join("\n"));
  }
  const fScores = (collective?.scores ?? f3) as Record<string, unknown> | undefined;
  const scoreStr = scoresLine(fScores, ["asymmetric_talent_score", "insight_edge_score", "recruiting_magnetism_proxy"]);
  if (scoreStr) out.push("Founder scores\n" + scoreStr);
  const sigInt = collective?.signal_interpretation as Record<string, unknown> | undefined;
  const fSummary = getStr(sigInt ?? null, "founder_signal_summary") ?? getStr(f3 ?? null, "founder_signal_summary") ?? getStr(input.founder_web_json ?? null, "founder_team_quality_commentary");
  if (fSummary) out.push("Founder summary\n" + fSummary);
}

// ——— Traction ———
function buildTraction(input: CommentaryInputs, out: string[]) {
  const parsing = input.parsing_json;
  const tractionVal = parsing?.traction as Record<string, unknown> | undefined;
  const fundVal = parsing?.fundraising as Record<string, unknown> | undefined;
  const metricsVal = (parsing?.metrics ?? tractionVal) as Record<string, unknown> | undefined;

  const fromDeck: string[] = [];
  const add = (o: Record<string, unknown> | undefined, label: string, key: string) => {
    if (!o) return;
    const v = o[key];
    if (v != null && typeof v === "string" && v.trim()) fromDeck.push(`${label}: ${v.trim()}`);
    else if (v != null && typeof v === "number") fromDeck.push(`${label}: ${v}`);
  };
  if (metricsVal) {
    add(metricsVal, "Revenue", "revenue");
    add(metricsVal, "ARR", "arr");
    add(metricsVal, "Growth rate", "growth_rate");
    add(metricsVal, "Customers", "customers");
    add(metricsVal, "Active users", "active_users");
    add(metricsVal, "Retention/churn", "retention_or_churn");
    const logos = arrOfStrings(metricsVal.notable_logos);
    if (logos.length > 0) fromDeck.push("Notable logos: " + logos.join(", "));
    const partner = arrOfStrings(metricsVal.partnerships);
    if (partner.length > 0) fromDeck.push("Partnerships: " + partner.join(", "));
  }
  if (fundVal) {
    add(fundVal, "Raising", "raising_amount");
    const round = getStr(fundVal, "round_type_or_stage") ?? getStr(fundVal, "round_type");
    if (round) fromDeck.push(`Round: ${round}`);
    add(fundVal, "Valuation", "valuation");
    const useOfFunds = arrOfStrings(fundVal.use_of_funds);
    if (useOfFunds.length > 0) fromDeck.push("Use of funds: " + useOfFunds.join("; "));
  }
  if (fromDeck.length > 0) out.push("Traction (from deck)\n" + fromDeck.join(" · "));

  const t3 = input.traction_signal_json as Record<string, unknown> | undefined;
  const ev = t3?.traction_evidence as Record<string, unknown> | undefined;
  if (ev) {
    const detectedMetrics = ev.detected_metrics as Record<string, unknown> | undefined;
    if (detectedMetrics) {
      const lines = formatEvidence(detectedMetrics, {
        revenue_data: "Revenue data",
        growth_signals: "Growth signals",
        customer_depth: "Customer depth",
        user_traction: "User traction",
      });
      if (lines.length > 0) out.push("Traction detected metrics\n" + lines.join("\n"));
    }
    const lines = formatEvidence(ev, {
      reported_arr: "Reported ARR",
      reported_revenue_growth_rate: "Revenue growth rate",
      customer_count: "Customer count",
      user_count: "User count",
      retention_metrics: "Retention metrics",
      expansion_revenue_signals: "Expansion revenue signals",
      notable_customers_or_logos: "Notable customers/logos",
      public_announcements_detected: "Public announcements",
      funding_stage_detected: "Funding stage detected",
      funding_history_detected: "Funding history",
      notable_partners_and_validation: "Notable partners and validation",
      investor_list: "Investor list",
      milestones_detected: "Milestones detected",
    });
    if (lines.length > 0) out.push("Traction evidence\n" + lines.join("\n"));
  }
  const inf = t3?.inferred_context as Record<string, unknown> | undefined;
  if (inf) {
    const infLines = formatEvidence(inf, {
      inferred_stage: "Inferred stage",
      benchmark_context: "Benchmark context",
      estimated_stage_if_missing: "Estimated stage (if missing)",
      stage_assumption_used_for_scoring: "Stage assumption for scoring",
      benchmark_comparison_note: "Benchmark comparison",
    });
    if (infLines.length > 0) out.push("Inferred context\n" + infLines.join("\n"));
  }
  const scoreStr = scoresLine(t3, ["traction_strength_score", "growth_acceleration_score", "stage_adjusted_signal_score"]);
  if (scoreStr) out.push("Traction scores\n" + scoreStr);
  const tSummary = getStr(t3 ?? null, "signal_summary") ?? getStr(input.metrics_web_json ?? null, "metrics_quality_commentary");
  if (tSummary) out.push("Traction summary\n" + tSummary);
}

// ——— Thesis fit ———
function buildThesis(input: CommentaryInputs, out: string[]) {
  const t2 = input.thesis_fit_json as Record<string, unknown> | undefined;
  if (!t2) return;
  // V2: industry_evaluation, stage_evaluation, funding_evaluation, overall_thesis_alignment_reasoning, auto_reject_flag
  const ind = t2.industry_evaluation as Record<string, unknown> | undefined;
  const stg = t2.stage_evaluation as Record<string, unknown> | undefined;
  const fund = t2.funding_evaluation as Record<string, unknown> | undefined;
  const rawReasoning =
    getStr(t2, "overall_thesis_alignment_reasoning") ?? getStr(t2, "thesis_alignment_reasoning");

  let scorePreamble: string | null = null;
  if (rawReasoning) {
    const part = partitionThesisAlignmentReasoning(rawReasoning);
    scorePreamble = part.scorePreamble;
    if (part.prose) out.push("Thesis fit reasoning\n" + part.prose);
  }

  const hasV2Scores = ind || stg || fund;
  const evalLines = hasV2Scores ? formatThesisFitEvaluationLines(ind, stg, fund) : [];
  if (evalLines.length > 0) {
    out.push(`Scores\n${evalLines.join("\n")}`);
  } else {
    const scoreStr = scoresLine(t2, ["sector_fit_score", "stage_fit_score", "geo_fit_score", "check_size_fit_score"]);
    if (scoreStr) out.push(`Scores\n${scoreStr}`);
  }

  if (scorePreamble && !hasV2Scores) {
    const legacy = scoresLine(t2, ["sector_fit_score", "stage_fit_score", "geo_fit_score", "check_size_fit_score"]);
    if (!legacy) {
      out.push(`Scores\n${scorePreamble}`);
    }
  }

  if (t2.auto_reject_flag === true) out.push("Thesis auto-reject\nThis deal was auto-rejected (thesis mismatch).");
}

// ——— Market ———
function buildMarket(input: CommentaryInputs, out: string[]) {
  const marketObj = input.parsing_json?.market as Record<string, unknown> | undefined;
  const fromDeck: string[] = [];
  if (marketObj) {
    const tam = getStr(marketObj, "tam_claim");
    const sam = getStr(marketObj, "sam_claim");
    const som = getStr(marketObj, "som_claim");
    const growth = arrOfStrings(marketObj.market_growth_claims);
    if (tam) fromDeck.push(`TAM: ${tam}`);
    if (sam) fromDeck.push(`SAM: ${sam}`);
    if (som) fromDeck.push(`SOM: ${som}`);
    if (growth.length > 0) fromDeck.push("Growth claims: " + growth.join("; "));
  }
  if (fromDeck.length > 0) out.push("Market (from deck)\n" + fromDeck.join(" · "));

  const m3 = input.market_power_json as Record<string, unknown> | undefined;
  if (m3) {
    const nested = formatNestedEvidence(m3, [
      "TAM_evidence", "winner_take_most_evidence", "structural_tailwinds_evidence",
      "market_fragmentation_evidence", "venture_scale_evidence",
    ], {
      TAM_evidence: "TAM evidence",
      winner_take_most_evidence: "Winner-take-most evidence",
      structural_tailwinds_evidence: "Structural tailwinds evidence",
      market_fragmentation_evidence: "Market fragmentation evidence",
      venture_scale_evidence: "Venture scale evidence",
    });
    if (nested.length > 0) out.push("Market evidence\n" + nested.join("\n\n"));
  }
  const scoreStr = scoresLine(m3, [
    "TAM_plausibility_score", "winner_take_most_potential", "structural_tailwinds_score",
    "market_fragmentation_score", "venture_scale_probability_estimate",
  ]);
  if (scoreStr) out.push("Market scores\n" + scoreStr);
  const mSummary = getStr(m3 ?? null, "market_power_summary");
  if (mSummary) out.push("Market summary\n" + mSummary);
}

// ——— Core assumptions ———
function buildCoreAssumptions(input: CommentaryInputs, out: string[]) {
  const core = input.core_assumption_json as Record<string, unknown> | null | undefined;
  if (!core) return;
  const assumptions = arrOfStrings(core.critical_assumptions ?? core.core_assumptions);
  if (assumptions.length > 0) out.push("Critical assumptions\n" + assumptions.map((a) => "• " + a).join("\n"));
  const linchpin = core.the_linchpin_assumption as Record<string, unknown> | undefined;
  if (linchpin) {
    const desc = getStr(linchpin, "description");
    if (desc) out.push("The linchpin assumption\n" + desc);
    if (typeof linchpin.fragility_score === "number") out.push("Linchpin fragility score\n" + linchpin.fragility_score);
    const why = getStr(linchpin, "why_it_is_fragile");
    if (why) out.push("Why it is fragile\n" + why);
  }
  const dominant = getStr(core, "dominant_fragile_assumption");
  if (dominant) out.push("Dominant fragile assumption\n" + dominant);
  const riskDyn = core.risk_dynamics as Record<string, unknown> | undefined;
  if (riskDyn) {
    const dep = getStr(riskDyn, "dependency_chain_complexity");
    const failure = getStr(riskDyn, "failure_mode_analysis");
    const killer = getStr(riskDyn, "killer_question_for_founders");
    if (dep) out.push("Dependency chain complexity\n" + dep);
    if (failure) out.push("Failure mode analysis\n" + failure);
    if (killer) out.push("Killer question for founders\n" + killer);
  }
  const fragility = core.fragility_score ?? linchpin?.fragility_score;
  const dependency = core.dependency_score;
  if (typeof fragility === "number" || typeof dependency === "number") {
    const parts: string[] = [];
    if (typeof fragility === "number") parts.push(`Fragility: ${fragility}`);
    if (typeof dependency === "number") parts.push(`Dependency: ${dependency}`);
    out.push("Assumption scores\n" + parts.join(" · "));
  }
  const failure = getStr(core, "failure_mode_summary");
  if (failure) out.push("Failure mode\n" + failure);
  const delta = getStr(core, "overall_conviction_delta");
  if (delta) out.push("Overall conviction delta\n" + delta);
}

// ——— Sources ———
function collectSources(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  const raw = obj["sources"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const title = getStr(e, "title");
      const url = getStr(e, "url") ?? getStr(e, "link");
      if (title && url) out.push(`${title} - ${url}`);
      else if (url) out.push(url);
      else if (title) out.push(title);
    }
  }
  return out;
}

export function aggregateCommentary(input: CommentaryInputs): string {
  const out: string[] = [];
  buildProblem(input, out);
  buildSolution(input, out);
  buildTeam(input, out);
  buildTraction(input, out);
  buildThesis(input, out);
  buildMarket(input, out);
  buildCoreAssumptions(input, out);

  const sources = [
    ...collectSources(input.problem_web_json ?? null),
    ...collectSources(input.solution_web_json ?? null),
    ...collectSources(input.founder_web_json ?? null),
    ...collectSources(input.metrics_web_json ?? null),
  ];
  const unique = Array.from(new Set(sources)).slice(0, 15);
  if (unique.length > 0) out.push("Sources\n" + unique.map((s) => "- " + s).join("\n"));

  return out.join(SECTION_SEP);
}

/** Character count for card preview; full text is on the analysis page. */
export const PREVIEW_CHARS = 520;

/** Return a short preview of the full analysis for the card (truncate + "… View full analysis" is shown via UI). */
export function getAnalysisPreview(fullAnalysis: string, maxChars: number = PREVIEW_CHARS): string {
  if (!fullAnalysis.trim()) return "";
  const trimmed = fullAnalysis.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

// ——— Structured aggregation (summary + expandable details per section) ———

export interface AnalysisSection {
  summary: string;
  details: string;
}

export interface StructuredAnalysis {
  problem: AnalysisSection;
  solution: AnalysisSection;
  founderTeam: AnalysisSection;
  traction: AnalysisSection;
  assumptions: AnalysisSection;
  thesisFit: AnalysisSection;
  questions: AnalysisSection;
}

function buildSection(summaryParts: string[], detailsParts: string[]): AnalysisSection {
  return {
    summary: summaryParts.filter(Boolean).join(" ").trim() || "No summary.",
    details: detailsParts.filter(Boolean).join("\n\n").trim() || "",
  };
}

export function aggregateCommentaryStructured(input: CommentaryInputs): StructuredAnalysis {
  const p3 = input.problem_quality_3c_json as Record<string, unknown> | undefined;
  const problemObj = input.parsing_json?.problem as Record<string, unknown> | undefined;
  const sigP = p3?.signal_interpretation as Record<string, unknown> | undefined;
  const problemSummaryFromAggregation =
    getStr(input.pipeline_summaries ?? null, "problem") ?? getStr(p3 ?? null, "summary_text");
  const problemSummary =
    problemSummaryFromAggregation ??
    getStr(sigP ?? null, "problem_quality_summary") ??
    getStr(p3 ?? null, "problem_quality_summary") ??
    getStr(input.problem_web_json ?? null, "problem_quality_commentary");
  const fromDeckProblem: string[] = [];
  if (problemObj) {
    const s = getStr(problemObj, "problem_statement");
    const tc = getStr(problemObj, "target_customer");
    if (s) fromDeckProblem.push(s);
    if (tc) fromDeckProblem.push(`Target: ${tc}`);
  }
  const problemAnalysis = p3?.problem_analysis as Record<string, unknown> | undefined;
  const customerAnalysis = p3?.customer_analysis as Record<string, unknown> | undefined;
  const pScores = (p3?.scores ?? p3) as Record<string, unknown> | undefined;
  const problemDetails: string[] = [];
  if (problemAnalysis) problemDetails.push("Analysis\n" + formatEvidence(problemAnalysis, { stated_problem_ref: "Stated problem", economic_gravity: "Economic gravity", structural_urgency: "Structural urgency", root_cause_depth: "Root cause depth" }).join("\n"));
  if (customerAnalysis) problemDetails.push("Customer\n" + formatEvidence(customerAnalysis, { economic_buyer_persona: "Economic buyer", budget_priority_validation: "Budget priority", persona_clarity: "Persona clarity" }).join("\n"));
  const evP = p3?.problem_evidence as Record<string, unknown> | undefined;
  if (evP && !problemAnalysis) problemDetails.push("Evidence\n" + formatEvidence(evP).join("\n"));
  const scoreStrP = scoresLine(pScores, ["pain_severity_score", "buyer_authority_score", "structural_tailwinds_score", "venture_scale_plausibility"]);
  if (scoreStrP) problemDetails.push("Scores: " + scoreStrP);

  const solutionObj = input.parsing_json?.solution as Record<string, unknown> | undefined;
  const s3 = input.solution_defensibility_json as Record<string, unknown> | undefined;
  const sigS = s3?.signal_interpretation as Record<string, unknown> | undefined;
  const solutionSummaryFromAggregation =
    getStr(input.pipeline_summaries ?? null, "solution") ?? getStr(s3 ?? null, "summary_text");
  const solutionSummaryText =
    solutionSummaryFromAggregation ??
    getStr(sigS ?? null, "solution_summary") ??
    getStr(s3 ?? null, "solution_summary") ??
    getStr(input.solution_web_json ?? null, "solution_quality_commentary");
  const fromDeckSolution: string[] = [];
  if (solutionObj) {
    const s = getStr(solutionObj, "solution_summary");
    const pt = getStr(solutionObj, "product_type");
    if (s) fromDeckSolution.push(s);
    if (pt) fromDeckSolution.push(`Product: ${pt}`);
  }
  const solAnalysis = s3?.solution_analysis as Record<string, unknown> | undefined;
  const defSignals = s3?.defensibility_signals as Record<string, unknown> | undefined;
  const solutionDetails: string[] = [];
  if (solAnalysis) solutionDetails.push("Analysis\n" + formatEvidence(solAnalysis, { stated_solution_ref: "Stated solution", technical_moat_evidence: "Technical moat", competitor_landscape: "Competitors", differentiation_proof_points: "Differentiation" }).join("\n"));
  if (defSignals) solutionDetails.push("Defensibility\n" + formatEvidence(defSignals).join("\n"));
  if (sigS) solutionDetails.push("Signal interpretation\n" + formatEvidence(sigS).join("\n"));
  const evS = s3?.solution_evidence as Record<string, unknown> | undefined;
  if (evS && !solAnalysis) solutionDetails.push("Evidence\n" + formatEvidence(evS).join("\n"));
  const sScores = (s3?.scores ?? s3) as Record<string, unknown> | undefined;
  const scoreStrS = scoresLine(sScores, ["10x_improvement_plausibility", "defensibility_potential", "competitive_edge_score"]);
  if (scoreStrS) solutionDetails.push("Scores: " + scoreStrS);

  const parsing = input.parsing_json;
  const teamVal = parsing?.["team"] ?? parsing?.["team_members"];
  const fromDeckTeam: string[] = [];
  if (Array.isArray(teamVal) && teamVal.length > 0) {
    fromDeckTeam.push(teamVal.slice(0, 4).map((m: unknown) => {
      const r = m as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : getStr(r, "name") ?? "Unknown";
      const role = getStr(r, "role");
      return role ? `${name} (${role})` : name;
    }).join("; "));
  }
  const f3 = input.founder_signal_json as Record<string, unknown> | undefined;
  const collective = parseJsonObjectIfString(f3?.collective);
  const sigInt = collective?.signal_interpretation as Record<string, unknown> | undefined;
  const founderSummaryFromAggregation =
    getStr(input.pipeline_summaries ?? null, "founder") ?? getStr(f3 ?? null, "summary_text");
  const founderSummaryText =
    founderSummaryFromAggregation ??
    getStr(sigInt ?? null, "founder_signal_summary") ??
    getStr(f3 ?? null, "founder_signal_summary") ??
    getStr(input.founder_web_json ?? null, "founder_team_quality_commentary");
  const founderDetails: string[] = [];
  const perFounder = Array.isArray(f3?.per_founder) ? f3.per_founder : [];
  if (perFounder.length > 0) {
    founderDetails.push(perFounder.map((p: unknown, i: number) => {
      const r = p as Record<string, unknown>;
      const name = getStr(r, "founder_name") ?? getStr(r, "name") ?? `Founder ${i + 1}`;
      const lines = formatEvidence(r, { elite_institutions: "Elite institutions", intellectual_achievements: "Achievements", technical_proof_points: "Technical proof", professional_velocity: "Velocity", exit_history: "Exits", intelligence_score_proxy: "Score" });
      if (lines.length > 0) return `${name}\n${lines.join("\n")}`;
      const role = getStr(r, "role");
      const background = getStr(r, "background") ?? getStr(r, "background_summary");
      if (role || background) {
        const bits = [name];
        if (role) bits.push(`Role: ${role}`);
        if (background) bits.push(`Background: ${background}`);
        return bits.join("\n");
      }
      // formatEvidence can skip nested shapes — still show raw founder JSON for in-depth view
      try {
        const raw = JSON.stringify(r, null, 2);
        return `${name}\n${raw.length > 12000 ? `${raw.slice(0, 12000)}\n…` : raw}`;
      } catch {
        return `${name}\n(no structured fields parsed)`;
      }
    }).join("\n\n"));
  }
  const teamEv =
    (collective?.team_evidence as Record<string, unknown> | undefined) ??
    (f3?.team_evidence as Record<string, unknown> | undefined);
  if (teamEv) {
    const teLines = formatEvidence(teamEv, {
      elite_academic_pedigree: "Academic pedigree",
      high_bar_previous_employers: "Previous employers",
      technical_authority_proof: "Technical authority",
      team_cohesion_signals: "Cohesion",
      magnetism_proof_points: "Magnetism",
    });
    if (teLines.length > 0) founderDetails.push("Team evidence\n" + teLines.join("\n"));
    else {
      try {
        const raw = JSON.stringify(teamEv, null, 2);
        founderDetails.push("Team evidence (raw)\n" + (raw.length > 12000 ? `${raw.slice(0, 12000)}\n…` : raw));
      } catch {
        /* ignore */
      }
    }
  }
  const completeness = collective ? getStr(collective, "signal_completeness") : null;
  if (completeness) founderDetails.push(`Signal completeness: ${completeness}`);
  const fScores = (collective?.scores ?? f3) as Record<string, unknown> | undefined;
  const scoreStrF = scoresLine(fScores, ["asymmetric_talent_score", "insight_edge_score", "recruiting_magnetism_proxy"]);
  if (scoreStrF) founderDetails.push("Scores: " + scoreStrF);

  // If structured extraction is still empty, reuse the same narrative builder as aggregateCommentary()
  const founderDetailsJoinedPreview = founderDetails.join("\n\n").trim();
  if (!founderDetailsJoinedPreview && f3) {
    const teamOut: string[] = [];
    buildTeam(input, teamOut);
    const merged = teamOut
      .filter((block) => {
        const b = block.trim();
        if (b.startsWith("Founder summary\n")) return false;
        return b.length > 0;
      })
      .join(SECTION_SEP)
      .trim();
    if (merged) founderDetails.push(merged);
  }
  if (!founderDetails.join("\n\n").trim() && f3) {
    try {
      const payload = {
        per_founder: f3.per_founder,
        collective: collective ?? f3.collective,
      };
      const raw = JSON.stringify(payload, null, 2);
      founderDetails.push(
        "Founder signals (full JSON)\n" + (raw.length > 24000 ? `${raw.slice(0, 24000)}\n… (truncated)` : raw)
      );
    } catch {
      /* ignore */
    }
  }

  const tractionVal = parsing?.traction as Record<string, unknown> | undefined;
  const fundVal = parsing?.fundraising as Record<string, unknown> | undefined;
  const metricsVal = (parsing?.metrics ?? tractionVal) as Record<string, unknown> | undefined;
  const fromDeckTraction: string[] = [];
  const add = (o: Record<string, unknown> | undefined, label: string, key: string) => {
    if (!o) return;
    const v = o[key];
    if (v != null && typeof v === "string" && (v as string).trim()) fromDeckTraction.push(`${label}: ${(v as string).trim()}`);
    else if (v != null && typeof v === "number") fromDeckTraction.push(`${label}: ${v}`);
  };
  if (metricsVal) { add(metricsVal, "ARR", "arr"); add(metricsVal, "Customers", "customers"); add(metricsVal, "Revenue", "revenue"); }
  if (fundVal) { add(fundVal, "Raising", "raising_amount"); const r = getStr(fundVal, "round_type_or_stage") ?? getStr(fundVal, "round_type"); if (r) fromDeckTraction.push(`Round: ${r}`); }
  const t3 = input.traction_signal_json as Record<string, unknown> | undefined;
  const tractionSummaryFromAggregation =
    getStr(input.pipeline_summaries ?? null, "traction") ?? getStr(t3 ?? null, "summary_text");
  const tSummaryText =
    tractionSummaryFromAggregation ??
    getStr(t3 ?? null, "signal_summary") ??
    getStr(input.metrics_web_json ?? null, "metrics_quality_commentary");
  const tractionDetails: string[] = [];
  const evT = t3?.traction_evidence as Record<string, unknown> | undefined;
  if (evT) {
    const dm = evT.detected_metrics as Record<string, unknown> | undefined;
    if (dm) {
      const dmLines = formatEvidence(dm, {
        revenue_data: "Revenue / ARR",
        growth_signals: "Growth signals",
        customer_depth: "Customer depth",
        user_traction: "User traction",
      });
      if (dmLines.length > 0) tractionDetails.push("Metrics\n" + dmLines.join("\n"));
    }
    tractionDetails.push(formatEvidence(evT, { notable_partners_and_validation: "Partners", investor_list: "Investors", milestones_detected: "Milestones" }).join("\n"));
  }
  const infT = t3?.inferred_context as Record<string, unknown> | undefined;
  if (infT) tractionDetails.push("Context\n" + formatEvidence(infT).join("\n"));
  const scoreStrT = scoresLine(t3 ?? null, ["traction_strength_score", "growth_acceleration_score", "stage_adjusted_signal_score"]);
  if (scoreStrT) tractionDetails.push("Scores: " + scoreStrT);

  const core = input.core_assumption_json as Record<string, unknown> | null | undefined;
  const assumptionsSummary: string[] = [];
  const assumptionsDetails: string[] = [];
  // Prefer the aggregation prompt's prose summary (no bullets); fall back to raw assumptions only if missing.
  const assumptionsSummaryText =
    getStr(input.pipeline_summaries ?? null, "assumptions") ?? getStr(core ?? null, "summary_text");
  if (assumptionsSummaryText) {
    assumptionsSummary.push(assumptionsSummaryText);
  }
  if (core) {
    const assumptions = arrOfStrings(core.critical_assumptions ?? core.core_assumptions);
    if (assumptions.length > 0) {
      if (!assumptionsSummaryText) assumptionsSummary.push(assumptions.slice(0, 2).map((a) => `• ${a}`).join(" "));
      assumptionsDetails.push("Critical assumptions\n" + assumptions.map((a) => "• " + a).join("\n"));
    }
    const linchpin = core.the_linchpin_assumption as Record<string, unknown> | undefined;
    const linchpinDesc = linchpin ? getStr(linchpin, "description") : getStr(core, "dominant_fragile_assumption");
    if (linchpinDesc) {
      if (!assumptionsSummaryText) assumptionsSummary.push(linchpinDesc.slice(0, 120) + (linchpinDesc.length > 120 ? "…" : ""));
      assumptionsDetails.push("Linchpin\n" + linchpinDesc);
      if (linchpin && typeof linchpin.why_it_is_fragile === "string") assumptionsDetails.push("Why fragile: " + linchpin.why_it_is_fragile);
    }
    const riskDyn = core.risk_dynamics as Record<string, unknown> | undefined;
    if (riskDyn) {
      const failure = getStr(riskDyn, "failure_mode_analysis");
      const killer = getStr(riskDyn, "killer_question_for_founders");
      if (failure) assumptionsDetails.push("Failure mode\n" + failure);
      if (killer) assumptionsDetails.push("Killer question\n" + killer);
    }
    const delta = getStr(core, "overall_conviction_delta");
    if (delta) assumptionsDetails.push("Conviction delta\n" + delta);
  }

  // Question generation outputs (from PROMPT_QUESTIONS_FIRST_ORDER / PROMPT_QUESTIONS_STRUCTURAL)
  const questionsDetails: string[] = [];
  const firstOrderQ = (input.questions_first_order_json ??
    core?.first_order_questions) as Record<string, unknown> | undefined;
  if (firstOrderQ) {
    const interrogations = Array.isArray(firstOrderQ.critical_assumption_interrogation)
      ? (firstOrderQ.critical_assumption_interrogation as unknown[])
      : [];
    interrogations.forEach((item, idx) => {
      const r = item as Record<string, unknown>;
      const assumption = getStr(r, "assumption");
      const killer = r.killer_questions as Record<string, unknown> | undefined;
      const lines: string[] = [];
      if (assumption) lines.push(`Assumption ${idx + 1}: ${assumption}`);
      if (killer) {
        const evQ = getStr(killer, "evidence");
        const behQ = getStr(killer, "behavioral_proof");
        const failQ = getStr(killer, "failure_boundary");
        const contraQ = getStr(killer, "contradictory_signal");
        if (evQ) lines.push(`Evidence question: ${evQ}`);
        if (behQ) lines.push(`Behavioral proof question: ${behQ}`);
        if (failQ) lines.push(`Failure boundary question: ${failQ}`);
        if (contraQ) lines.push(`Contradictory signal question: ${contraQ}`);
      }
      if (lines.length) questionsDetails.push(lines.join("\n"));
    });
    const linchpinQ = firstOrderQ.linchpin_questions as Record<string, unknown> | undefined;
    if (linchpinQ) {
      const lines: string[] = [];
      const real = getStr(linchpinQ, "real_world_evidence");
      const structural = getStr(linchpinQ, "structural_dependency_test");
      const market = getStr(linchpinQ, "market_contradiction");
      if (real) lines.push(`Linchpin real-world evidence: ${real}`);
      if (structural) lines.push(`Linchpin structural dependency test: ${structural}`);
      if (market) lines.push(`Linchpin market contradiction: ${market}`);
      if (lines.length) questionsDetails.push(lines.join("\n"));
    }
  }

  const structuralQ = (input.questions_structural_json ??
    core?.structural_auditor_questions) as Record<string, unknown> | undefined;
  if (structuralQ) {
    const dep = structuralQ.dependency_chain_questions as Record<string, unknown> | undefined;
    if (dep) {
      const lines: string[] = [];
      const weakest = getStr(dep, "weakest_link_verification");
      const unvalidated = getStr(dep, "unvalidated_step_check");
      const cascade = getStr(dep, "cascade_failure_test");
      if (weakest) lines.push(`Weakest-link verification: ${weakest}`);
      if (unvalidated) lines.push(`Unvalidated-step check: ${unvalidated}`);
      if (cascade) lines.push(`Cascade-failure test: ${cascade}`);
      if (lines.length) questionsDetails.push(lines.join("\n"));
    }
    const failureQs = Array.isArray(structuralQ.failure_mode_questions)
      ? arrOfStrings(structuralQ.failure_mode_questions)
      : [];
    if (failureQs.length > 0) {
      questionsDetails.push("Failure mode questions\n" + failureQs.join("\n"));
    }
    const credQs = Array.isArray(structuralQ.conviction_delta_credibility_questions)
      ? arrOfStrings(structuralQ.conviction_delta_credibility_questions)
      : [];
    if (credQs.length > 0) {
      questionsDetails.push("Conviction delta questions\n" + credQs.join("\n"));
    }
    // We intentionally do not surface second_order_dependencies in the UI.
  }

  // No summary text for questions section — only show detailed questions when expanded.

  const t2 = input.thesis_fit_json as Record<string, unknown> | undefined;
  const thesisSummary: string[] = [];
  const thesisDetails: string[] = [];
  if (t2) {
    const ind = t2.industry_evaluation as Record<string, unknown> | undefined;
    const stg = t2.stage_evaluation as Record<string, unknown> | undefined;
    const fund = t2.funding_evaluation as Record<string, unknown> | undefined;
    const rawReasoning =
      getStr(t2, "overall_thesis_alignment_reasoning") ?? getStr(t2, "thesis_alignment_reasoning");

    if (rawReasoning) {
      const { prose, scorePreamble } = partitionThesisAlignmentReasoning(rawReasoning);
      if (prose) thesisSummary.push(prose);
      const evalLines = formatThesisFitEvaluationLines(ind, stg, fund);
      const body = buildThesisDetailsBodyWithScores({
        evalLines,
        scorePreamble,
        hasStructuredScores: evalLines.length > 0,
      });
      if (body) thesisDetails.push(body);
    } else {
      const evalLines = formatThesisFitEvaluationLines(ind, stg, fund);
      const body = buildThesisDetailsBodyWithScores({
        evalLines,
        scorePreamble: null,
        hasStructuredScores: evalLines.length > 0,
      });
      if (body) thesisDetails.push(body);
    }

    if (t2.auto_reject_flag === true) thesisSummary.push("Auto-reject: thesis mismatch.");
  }

  return sanitizeStructuredAnalysis({
    problem: buildSection(
      problemSummaryFromAggregation ? [problemSummaryFromAggregation] : [...fromDeckProblem, problemSummary ?? ""].filter(Boolean),
      problemDetails
    ),
    solution: buildSection(
      solutionSummaryFromAggregation ? [solutionSummaryFromAggregation] : [...fromDeckSolution, solutionSummaryText ?? ""].filter(Boolean),
      solutionDetails
    ),
    founderTeam: buildSection(
      founderSummaryFromAggregation ? [founderSummaryFromAggregation] : [...fromDeckTeam, founderSummaryText ?? ""].filter(Boolean),
      founderDetails
    ),
    traction: buildSection(
      [...fromDeckTraction, tractionSummaryFromAggregation ?? tSummaryText ?? ""].filter(Boolean),
      tractionDetails
    ),
    assumptions: buildSection(
      assumptionsSummary,
      assumptionsDetails
    ),
    thesisFit: buildSection(
      thesisSummary.length > 0 ? thesisSummary : ["No thesis evaluation."],
      thesisDetails
    ),
    questions: buildSection(
      [],
      questionsDetails
    ),
  });
}

/** Build a short preview string from structured analysis (e.g. for cards). */
export function getStructuredPreview(structured: StructuredAnalysis, maxSections = 2): string {
  const parts: string[] = [];
  if (structured.problem.summary && structured.problem.summary !== "No summary.") parts.push(structured.problem.summary.slice(0, 150) + (structured.problem.summary.length > 150 ? "…" : ""));
  if (maxSections >= 2 && structured.solution.summary && structured.solution.summary !== "No summary.") parts.push(structured.solution.summary.slice(0, 120) + (structured.solution.summary.length > 120 ? "…" : ""));
  return parts.join(" ");
}
