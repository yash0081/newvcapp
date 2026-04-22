/**
 * Builds supabase/seed-invested-companies.sql from Invested Companies_.md
 * Run: node scripts/generate-invested-companies-sql.mjs
 *
 * Maps JSON into deal_problem, deal_solution, deal_traction (all columns where possible),
 * deal_metrics, deal_competitors, deal_investors (+ investors), founders (parsed fields).
 */
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const mdPath = join(root, "Invested Companies_.md");
const outPath = join(root, "supabase", "seed-invested-companies.sql");

function normalizeMarkdownJson(line) {
  let s = line;
  s = s.replace(/\\_/g, "_");
  s = s.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  s = s.replace(/\\\)/g, ")").replace(/\\\(/g, "(");
  s = s.replace(/\\-/g, "-");
  s = s.replace(/\\&/g, "&");
  s = s.replace(/\\\\"/g, '\\"');
  return s;
}

function parseJsonLine(line) {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  return JSON.parse(normalizeMarkdownJson(t));
}

function splitSections(md) {
  const acceptedMarker = "Info and Reasoning abt each company (Accepted):";
  const passedMarker = "Passed Companies (Rejection):";
  const iAccepted = md.indexOf(acceptedMarker);
  const iPassed = md.indexOf(passedMarker);
  return {
    acceptedBlock: md.slice(iAccepted + acceptedMarker.length, iPassed),
    passedBlock: md.slice(iPassed + passedMarker.length),
  };
}

function extractLines(sectionText) {
  const out = [];
  for (const line of sectionText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    out.push(parseJsonLine(t));
  }
  return out;
}

const ID_SUFFIXES = [
  "000000000001",
  "000000000002",
  "000000000003",
  "000000000004",
  "000000000005",
  "000000000006",
  "000000000007",
  "000000000008",
  "000000000009",
  "00000000000a",
];

function dealId(i) {
  return `1a000000-0000-4000-8000-${ID_SUFFIXES[i]}`;
}
function analysisId(i) {
  return `1b000000-0000-4000-8000-${ID_SUFFIXES[i]}`;
}

/** Stable UUID for investor name (PK for seed idempotency on re-run of investors block). */
function investorUuid(name) {
  // Case-sensitive so distinct spellings in source (e.g. WillowTree vs Willowtree) get unique PKs.
  const h = createHash("sha256")
    .update("seed-investor:" + name.trim())
    .digest("hex");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-4" +
    h.slice(13, 16) +
    "-a" +
    h.slice(17, 20) +
    "-" +
    h.slice(20, 32)
  );
}

function dollarQuote(s) {
  let tag = "j";
  while (s.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${s}$${tag}$`;
}

function sqlString(s) {
  if (s == null) return "NULL";
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function sqlTextArray(arr) {
  if (!arr || !arr.length) return "NULL";
  return "ARRAY[" + arr.map((x) => sqlString(x)).join(", ") + "]::text[]";
}

function sqlJsonb(val) {
  if (val == null) return "NULL";
  return `${dollarQuote(JSON.stringify(val))}::jsonb`;
}

function humanizeKey(k) {
  return k
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveAssumptions(obj, decision) {
  const out = [];
  if (decision === "passed" && obj.hypothetical_investment_rejection_reasoning) {
    const rej = obj.hypothetical_investment_rejection_reasoning;
    if (typeof rej === "object" && rej) {
      for (const [k, v] of Object.entries(rej)) {
        if (typeof v === "string" && v.trim()) {
          const text = v.trim();
          out.push({
            assumption_type: "pass_rationale",
            assumption_text: humanizeKey(k),
            inversion: null,
            must_be_true: text,
            is_linchpin: false,
            fragility_score: null,
            why_fragile: null,
            failure_mode: text.length > 400 ? text.slice(0, 397) + "…" : text,
          });
        }
      }
    }
  }
  if (decision === "invested") {
    const ps = obj.problem_statement || {};
    const sol = obj.solution || {};
    const headline = ps.core_concept || ps.core_issue || "the core problem";
    const product = sol.primary_product || "the product";
    out.push({
      assumption_type: "market",
      assumption_text: "Problem urgency and budget",
      inversion: null,
      must_be_true: `Target customers treat "${headline}" as a priority worth paying to solve at venture-scale economics.`,
      is_linchpin: true,
      fragility_score: null,
      why_fragile: "If the pain is merely 'nice to have', growth stalls.",
      failure_mode:
        "Long sales cycles, churn, or inability to extract ACVs that support the raise.",
    });
    out.push({
      assumption_type: "product",
      assumption_text: "Differentiation holds",
      inversion: null,
      must_be_true: `${product} sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).`,
      is_linchpin: false,
      fragility_score: null,
      why_fragile: "Feature gaps or reliability issues erode win rate.",
      failure_mode: "Margin compression or R&D treadmill to stay parity.",
    });
    out.push({
      assumption_type: "execution",
      assumption_text: "Team velocity through next stage",
      inversion: null,
      must_be_true:
        "The team can hire, sell, and ship through the next funding milestone without losing focus.",
      is_linchpin: false,
      fragility_score: null,
      why_fragile: "Key-person risk or GTM mis-hires.",
      failure_mode: "Missed milestones and down-round or flat round.",
    });
  }
  return out;
}

function buildProblemStatement(obj) {
  const ps = obj.problem_statement || {};
  const headline = ps.core_concept || ps.core_issue || "";
  const body = ps.description || "";
  const barriers = ps.key_barriers || ps.barriers || [];
  const b = Array.isArray(barriers)
    ? barriers.map((x, i) => `${i + 1}. ${x}`).join("\n")
    : "";
  return [headline, body, b ? `Barriers:\n${b}` : ""].filter(Boolean).join("\n\n");
}

function buildSolutionSummary(obj) {
  const s = obj.solution || {};
  return [s.primary_product, s.architecture, s.value_proposition]
    .filter(Boolean)
    .join("\n\n");
}

function problemBarriers(obj) {
  const ps = obj.problem_statement || {};
  return ps.key_barriers || ps.barriers || [];
}

/** Split problem fields from deck JSON (not scrunched into one blob). */
function mapDealProblem(obj) {
  const ps = obj.problem_statement || {};
  const barriers = problemBarriers(obj);
  const headline = ps.core_concept || ps.core_issue || null;
  const body = ps.description || null;
  const problem_statement = buildProblemStatement(obj);
  const root_cause_depth =
    barriers[0] ||
    body ||
    (headline ? `Underlying tension: ${headline}` : null);
  const economic_gravity =
    body ||
    (barriers.length
      ? `Economic impact implied by: ${barriers.slice(0, 2).join(" ")}`
      : null);
  const structural_urgency = barriers.length
    ? barriers.map((x, i) => `${i + 1}. ${x}`).join("\n")
    : null;
  const issueLower = `${headline || ""} ${body || ""} ${barriers.join(" ")}`.toLowerCase();
  let persona_clarity = null;
  if (/smb|small and medium|business|merchant|restaurant/i.test(issueLower))
    persona_clarity = "SMB / operator buyer";
  else if (/bank|lender|underwrit|financial institution|fintech|carrier|insurance/i.test(issueLower))
    persona_clarity = "Enterprise / regulated financial buyer";
  else if (/trader|algo|retail user|consumer|individual/i.test(issueLower))
    persona_clarity = "Pro user or consumer";
  const economic_buyer_persona =
    persona_clarity ||
    (headline ? `Economic buyer tied to: ${headline.slice(0, 120)}` : null);
  const budget_priority_validation =
    barriers.find((b) => /budget|cost|fee|priority|pay/i.test(b)) || null;
  return {
    problem_statement,
    root_cause_depth,
    economic_gravity,
    structural_urgency,
    persona_clarity,
    economic_buyer_persona,
    budget_priority_validation,
    stated_problem_ref: headline,
    signal_completeness: "historical_seed",
  };
}

/** Infer moat / defensibility copy from solution + company context. */
function mapDealSolution(obj) {
  const sol = obj.solution || {};
  const summary = buildSolutionSummary(obj);
  const primary = sol.primary_product || null;
  const kf = Array.isArray(sol.key_features) ? sol.key_features : [];
  const joined = `${summary} ${kf.join(" ")}`.toLowerCase();
  let moat_type = "composite";
  if (/zk|cryptograph|patent|proprietary model|ml model|agent/i.test(joined))
    moat_type = "technical / data";
  if (/network|liquidity|api|integration|ecosystem|bridge/i.test(joined))
    moat_type = "network + integrations";
  if (/compliance|regulat|sr 11-7|cfpb|fair lending/i.test(joined))
    moat_type = "regulatory + workflow";
  const replication_difficulty = kf.length
    ? `High replication cost: ${kf.slice(0, 2).join("; ")}`
    : "Requires deep domain + product execution to copy.";
  const compounding_potential =
    typeof sol.value_proposition === "string"
      ? `Compounding via: ${sol.value_proposition.slice(0, 400)}`
      : null;
  const technical_moat_evidence =
    kf.length > 0
      ? kf.slice(0, 4).join("\n")
      : typeof sol.value_proposition === "string"
        ? sol.value_proposition
        : null;
  const competitor_landscape = extractCompetitorLandscape(obj);
  return {
    solution_summary: summary,
    product_type: primary,
    moat_type,
    replication_difficulty,
    compounding_potential,
    technical_moat_evidence,
    differentiation_proof_points: JSON.stringify(kf),
    competitor_landscape_json: JSON.stringify(competitor_landscape),
    signal_completeness: "historical_seed",
  };
}

/** Named incumbents + names mined from pass rationale. */
const INCUMBENT_NAMES = new Set([
  "Toast",
  "Square",
  "Clover",
  "SumUp",
  "Wise",
  "Revolut",
  "Airwallex",
  "Stripe",
  "Adyen",
  "Kalshi",
  "Polymarket",
  "Crypto.com",
  "Salesforce",
  "Guidewire",
  "Interactive Brokers",
  "FalconX",
  "State Farm",
  "Geico",
  "Chime",
  "Upgrade",
  "Pathward",
  "Varo Bank",
  "OpenAI",
  "Anthropic",
  "Google",
  "Microsoft",
  "Meta",
  "PayPal",
  "Goldman Sachs",
  "JPMorganChase",
]);

function extractCompetitorLandscape(obj) {
  const rows = [];
  const seen = new Set();
  const add = (name, note) => {
    const k = name.trim();
    if (!k || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    rows.push({ name: k, category: "incumbent / alternative", note: note || null });
  };
  const scan = (text) => {
    if (!text || typeof text !== "string") return;
    for (const n of INCUMBENT_NAMES) {
      if (text.includes(n)) add(n, "Referenced in source narrative");
    }
  };
  const rej = obj.hypothetical_investment_rejection_reasoning;
  if (rej && typeof rej === "object") {
    for (const v of Object.values(rej)) {
      if (typeof v === "string") scan(v);
    }
  }
  scan(JSON.stringify(obj.solution || {}));
  scan(JSON.stringify(obj.problem_statement || {}));
  return rows;
}

function collectInvestorNames(traction) {
  const names = new Set();
  const add = (x) => {
    if (typeof x === "string" && x.trim()) names.add(x.trim());
    if (Array.isArray(x)) x.forEach(add);
  };
  if (!traction || typeof traction !== "object") return [];
  add(traction.key_investors);
  const f = traction.funding;
  if (f && typeof f === "object") {
    add(f.lead_investors);
    add(f.lead_investor);
    add(f.participating_investors);
  }
  return [...names];
}

function mapDealTraction(obj) {
  const traction = obj.traction || {};
  const tJson = JSON.stringify(traction);
  const milestones =
    traction.milestones ||
    traction.business_metrics ||
    traction.performance_metrics ||
    null;
  const mArr = Array.isArray(milestones) ? milestones : null;
  const lines = mArr || [];
  const revenueLines = lines.filter((l) =>
    /\$|arr|revenue|mrr|volume|billion|million|tpv|contracts/i.test(l)
  );
  const growthLines = lines.filter((l) =>
    /growth|woow|mom|yoy|\d+x|increase|expansion/i.test(l)
  );
  const customerLines = lines.filter((l) =>
    /fortune|bank|customer|partner|logo|user|merchant|businesses|claims|adjusters/i.test(l)
  );
  const hq = typeof obj.headquarters === "string" ? obj.headquarters : "";
  const fy = typeof obj.founded_year === "number" ? obj.founded_year : null;
  const funding = traction.funding && typeof traction.funding === "object" ? traction.funding : {};
  const latest =
    funding.latest_round ||
    funding.latest ||
    traction.latest_round ||
    null;
  const benchmark_context = [hq && `HQ: ${hq}`, fy && `Founded: ${fy}`, latest && `Round: ${latest}`]
    .filter(Boolean)
    .join(" | ");
  const investorNames = collectInvestorNames(traction);
  const leadSet = new Set();
  if (typeof funding.lead_investor === "string")
    leadSet.add(funding.lead_investor.trim().toLowerCase());
  if (typeof funding.lead_investors === "string") {
    funding.lead_investors.split(/,|\s+and\s+/i).forEach((s) => {
      const t = s.trim();
      if (t) leadSet.add(t.toLowerCase());
    });
  }
  if (Array.isArray(funding.lead_investors)) {
    for (const x of funding.lead_investors) {
      if (typeof x === "string" && x.trim()) leadSet.add(x.trim().toLowerCase());
    }
  }
  const investor_list = investorNames.map((name) => ({
    name,
    role: leadSet.has(name.trim().toLowerCase()) ? "lead" : "participant",
  }));
  return {
    traction_evidence_json: tJson,
    phase1_traction_json: tJson,
    milestones_detected: mArr ? JSON.stringify(mArr) : null,
    inferred_stage: fy ? `Founded ${fy}` : null,
    benchmark_context: benchmark_context || null,
    revenue_data: revenueLines.length ? revenueLines.join("\n") : null,
    growth_signals: growthLines.length ? growthLines.join("\n") : null,
    customer_depth: customerLines.length ? customerLines.join("\n") : null,
    user_traction: lines.filter((l) => /user|trader|volume|contract/i.test(l)).join("\n") || null,
    notable_partners_and_validation: mArr ? JSON.stringify(mArr) : null,
    investor_list: investor_list.length ? JSON.stringify(investor_list) : null,
    signal_completeness: "historical_seed",
  };
}

/** Key-value metrics from traction for deal_metrics rows. */
function metricsFromTraction(obj) {
  const rows = [];
  const t = obj.traction || {};
  const push = (name, value) => {
    if (value == null || value === "") return;
    rows.push({
      metric_name: name,
      metric_value: typeof value === "string" ? value : JSON.stringify(value),
      confidence: "deck_text",
      source_type: "historical_seed",
      is_verified: false,
    });
  };
  if (typeof obj.founded_year === "number") push("founded_year", String(obj.founded_year));
  push("headquarters", obj.headquarters);
  if (t.total_funding) push("total_funding", t.total_funding);
  if (t.latest_round) push("latest_round", t.latest_round);
  const f = t.funding;
  if (f && typeof f === "object") {
    if (f.total_funding) push("total_funding", f.total_funding);
    if (f.total_equity) push("total_equity", f.total_equity);
    if (f.debt_facility) push("debt_facility", f.debt_facility);
    if (f.latest_round) push("latest_round", f.latest_round);
    if (f.seed_round) push("seed_round", f.seed_round);
    if (f.status) push("funding_status", f.status);
  }
  const bm = t.business_metrics || t.performance_metrics || t.milestones;
  if (Array.isArray(bm)) {
    bm.forEach((line, i) => push(`traction_highlight_${i + 1}`, line));
  }
  return rows;
}

const SCHOOL_RE =
  /\b(MIT|Stanford|Harvard|Yale|Princeton|Columbia|UC Berkeley|Berkeley|UCLA|Oxford|Cambridge|Imperial|ETH Zurich|Cornell|Carnegie Mellon|Caltech|Waterloo|McGill|UPenn|Wharton)\b/gi;

function extractSchools(text) {
  if (!text) return [];
  const m = text.match(SCHOOL_RE);
  return m ? [...new Set(m.map((x) => x.replace(/\s+/g, " ").trim()))] : [];
}

function extractYcBatch(text) {
  if (!text) return null;
  const m = text.match(
    /Y Combinator\s*(?:\(|,|\s)+(?:Winter|Summer|Spring|Fall)\s*(\d{4})/i
  );
  if (m) return `YC ${m[0].replace(/Y Combinator\s*/i, "").trim()}`;
  const m2 = text.match(/\b(Winter|Summer|Spring|Fall)\s+(\d{4})\s+batch/i);
  if (m2) return `YC ${m2[1]} ${m2[2]}`;
  if (/Y Combinator/i.test(text) && /W\s*26|2026 batch/i.test(text)) return "YC (2026 batch)";
  return null;
}

const AWARD_RE =
  /\b(Rhodes Scholar|Thiel Fellow|30 Under 30|Forbes 30|Putnam|IMO|IOI|Olympiad|Y Combinator)\b/gi;

function extractAwards(text) {
  if (!text) return [];
  const m = text.match(AWARD_RE);
  return m ? [...new Set(m.map((x) => x.trim()))] : [];
}

function extractPreviousEmployers(background) {
  if (!background || typeof background !== "string") return [];
  const out = [];
  const patterns = [
    /(?:previously at|formerly at|former [^,;]+ at)\s*([^;.]+)/gi,
    /(?:previously|formerly)\s+([^;.]+?)\s+at\s+([^;.]+)/gi,
  ];
  for (const re of patterns) {
    let mm;
    const r = new RegExp(re.source, re.flags);
    while ((mm = r.exec(background)) !== null) {
      const chunk = (mm[2] ? `${mm[1].trim()} at ${mm[2].trim()}` : mm[1]).trim();
      if (chunk.length > 2 && chunk.length < 120) out.push(chunk);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function extractPastExits(background) {
  if (!background || typeof background !== "string") return [];
  const out = [];
  const m = background.match(/([A-Z][a-zA-Z0-9\s]+)\s*\(acquired[^)]*\)/g);
  if (m) out.push(...m);
  if (/acqui/i.test(background)) out.push(background.match(/acqui[^.]*/i)?.[0]?.slice(0, 200) || "Acquisition mentioned");
  return [...new Set(out)].slice(0, 5);
}

/** Employer / org names from "at X" patterns (for institutions jsonb). */
function extractInstitutionsFromBackground(background) {
  if (!background || typeof background !== "string") return [];
  const out = [];
  const re = /\bat\s+([^,;.]+?)(?=\s*[;,.\)]|$)/gi;
  let mm;
  while ((mm = re.exec(background)) !== null) {
    const chunk = mm[1].trim();
    if (chunk.length > 2 && chunk.length < 80) out.push(chunk);
  }
  return [...new Set(out)].slice(0, 12);
}

function mapFounderRow(f, obj) {
  const name = typeof f.name === "string" ? f.name : null;
  const role = typeof f.role === "string" ? f.role : null;
  const bg = typeof f.background === "string" ? f.background : "";
  const schools = extractSchools(bg);
  const orgs = extractInstitutionsFromBackground(bg);
  const yc =
    extractYcBatch(bg) ||
    extractYcBatch(JSON.stringify(obj.traction || {})) ||
    extractYcBatch(JSON.stringify(obj.founding_team || {}));
  const prev = extractPreviousEmployers(bg);
  const awards = extractAwards(bg);
  const exits = extractPastExits(bg);
  const institutions = [...new Set([...schools, ...orgs])];
  return {
    name,
    role,
    background_summary: bg || null,
    universities: schools,
    yc_batch: yc,
    previous_companies: prev.length ? prev : null,
    institutions: institutions.length ? institutions : null,
    awards_and_honors: awards.length ? awards : null,
    past_exits: exits.length ? exits : null,
    enrichment_raw: f,
  };
}

function collectLeadNames(funding) {
  const leads = [];
  if (funding && typeof funding === "object") {
    if (typeof funding.lead_investor === "string") leads.push(funding.lead_investor.trim());
    if (typeof funding.lead_investors === "string") {
      funding.lead_investors.split(/,|\s+and\s+/i).forEach((s) => {
        const t = s.trim();
        if (t) leads.push(t);
      });
    }
    if (Array.isArray(funding.lead_investors)) {
      for (const x of funding.lead_investors) {
        if (typeof x === "string" && x.trim()) leads.push(x.trim());
      }
    }
  }
  return leads;
}

function isLeadInvestor(iname, funding) {
  const n = iname.trim().toLowerCase();
  return collectLeadNames(funding).some((l) => l && l.toLowerCase() === n);
}

// ——— Build investor set across all deals ———
const md = readFileSync(mdPath, "utf8");
const { acceptedBlock, passedBlock } = splitSections(md);
const invested = extractLines(acceptedBlock);
const passed = extractLines(passedBlock);

const all = [
  ...invested.map((o) => ({ ...o, _decision: "invested" })),
  ...passed.map((o) => ({ ...o, _decision: "passed" })),
];

if (all.length !== ID_SUFFIXES.length) {
  console.error(`Expected ${ID_SUFFIXES.length} companies, got ${all.length}`);
  process.exit(1);
}

const globalInvestorNames = new Set();
for (const obj of all) {
  for (const n of collectInvestorNames(obj.traction)) globalInvestorNames.add(n);
}

let sql = `-- Seed: 10 companies from Invested Companies_.md
-- Populates: deals, deal_analyses, deal_problem (full columns), deal_solution (full), deal_traction (full),
-- deal_metrics, deal_competitors, investors + deal_investors, deal_assumptions, founders (parsed fields).
-- Replace REPLACE_WITH_YOUR_USER_UUID with your auth.users id.

BEGIN;

`;

for (const name of [...globalInvestorNames].sort()) {
  const id = investorUuid(name);
  sql += `INSERT INTO public.investors (id, name) VALUES ('${id}'::uuid, ${sqlString(name)});\n`;
}
sql += "\n";

for (let i = 0; i < all.length; i++) {
  const obj = all[i];
  const did = dealId(i);
  const aid = analysisId(i);
  const companyName = obj.company_name;
  const hq = typeof obj.headquarters === "string" ? obj.headquarters : null;
  const decision = obj._decision;
  const passDetail =
    decision === "passed" && obj.hypothetical_investment_rejection_reasoning
      ? JSON.stringify(obj.hypothetical_investment_rejection_reasoning)
      : null;
  const passReason = decision === "passed" ? "hypothetical_rejection" : null;
  const assumptions = deriveAssumptions(obj, decision);

  sql += `INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '${did}'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  ${sqlString(companyName)},
  ${sqlString(hq)},
  ${sqlString(decision)},
  'invested-companies-md',
  ${passReason ? sqlString(passReason) : "NULL"},
  ${passDetail ? sqlString(passDetail) : "NULL"}
);\n\n`;

  const { _decision: _d, ...rest } = obj;
  const cleanForDb = {
    ...rest,
    critical_assumptions: assumptions.map((a) => ({
      assumption_type: a.assumption_type,
      assumption_text: a.assumption_text,
      must_be_true: a.must_be_true,
      failure_mode: a.failure_mode,
      is_linchpin: a.is_linchpin,
    })),
  };

  sql += `INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '${aid}'::uuid,
  '${did}'::uuid,
  2,
  ${dollarQuote(JSON.stringify(cleanForDb))}::jsonb
);\n\n`;

  const p = mapDealProblem(obj);
  sql += `INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '${did}'::uuid,
  '${aid}'::uuid,
  ${sqlString(p.problem_statement)},
  ${sqlString(p.root_cause_depth)},
  ${sqlString(p.economic_gravity)},
  ${sqlString(p.structural_urgency)},
  ${sqlString(p.persona_clarity)},
  ${sqlString(p.economic_buyer_persona)},
  ${sqlString(p.budget_priority_validation)},
  ${sqlString(p.stated_problem_ref)},
  ${sqlString(p.signal_completeness)}
);\n\n`;

  const s = mapDealSolution(obj);
  sql += `INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '${did}'::uuid,
  '${aid}'::uuid,
  ${sqlString(s.solution_summary)},
  ${sqlString(s.product_type)},
  ${sqlString(s.moat_type)},
  ${sqlString(s.replication_difficulty)},
  ${sqlString(s.compounding_potential)},
  ${sqlString(s.technical_moat_evidence)},
  ${dollarQuote(s.differentiation_proof_points)}::jsonb,
  ${dollarQuote(s.competitor_landscape_json)}::jsonb,
  ${sqlString(s.signal_completeness)}
);\n\n`;

  const tr = mapDealTraction(obj);
  sql += `INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '${did}'::uuid,
  '${aid}'::uuid,
  ${dollarQuote(tr.traction_evidence_json)}::jsonb,
  ${dollarQuote(tr.phase1_traction_json)}::jsonb,
  ${tr.milestones_detected ? dollarQuote(tr.milestones_detected) + "::jsonb" : "NULL"},
  ${sqlString(tr.inferred_stage)},
  ${sqlString(tr.benchmark_context)},
  ${sqlString(tr.revenue_data)},
  ${sqlString(tr.growth_signals)},
  ${sqlString(tr.customer_depth)},
  ${sqlString(tr.user_traction)},
  ${tr.notable_partners_and_validation ? dollarQuote(tr.notable_partners_and_validation) + "::jsonb" : "NULL"},
  ${tr.investor_list ? dollarQuote(tr.investor_list) + "::jsonb" : "NULL"},
  ${sqlString(tr.signal_completeness)}
);\n\n`;

  for (const m of metricsFromTraction(obj)) {
    sql += `INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '${did}'::uuid,
  ${sqlString(m.metric_name)},
  ${sqlString(m.metric_value)},
  ${sqlString(m.confidence)},
  ${sqlString(m.source_type)},
  ${m.is_verified ? "true" : "false"}
);\n\n`;
  }

  const competitors = extractCompetitorLandscape(obj);
  for (const c of competitors) {
    sql += `INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '${did}'::uuid,
  '${aid}'::uuid,
  ${sqlString(c.name)},
  ${sqlString(c.category)},
  'referenced',
  ${sqlString(c.note)}
);\n\n`;
  }

  const invNames = collectInvestorNames(obj.traction);
  const funding = obj.traction?.funding && typeof obj.traction.funding === "object" ? obj.traction.funding : {};
  for (const iname of invNames) {
    const iid = investorUuid(iname);
    const isLead = isLeadInvestor(iname, funding);
    sql += `INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '${did}'::uuid,
  '${iid}'::uuid,
  ${sqlString(isLead ? "lead" : "participant")},
  ${sqlString(typeof funding.latest_round === "string" ? funding.latest_round : obj.traction?.latest_round || null)},
  NULL
);\n\n`;
  }

  for (const a of assumptions) {
    sql += `INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '${did}'::uuid,
  '${aid}'::uuid,
  ${sqlString(a.assumption_text)},
  ${sqlString(a.assumption_type)},
  ${sqlString(a.inversion)},
  ${sqlString(a.must_be_true)},
  ${a.is_linchpin ? "true" : "false"},
  ${a.fragility_score != null ? a.fragility_score : "NULL"},
  ${sqlString(a.why_fragile)},
  ${sqlString(a.failure_mode)}
);\n\n`;
  }

  const founders = Array.isArray(obj.founders) ? obj.founders : [];
  for (const f of founders) {
    const fr = mapFounderRow(f, obj);
    sql += `INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '${did}'::uuid,
  ${sqlString(fr.name)},
  ${sqlString(fr.role)},
  ${sqlString(fr.background_summary)},
  ${sqlTextArray(fr.universities)},
  ${sqlString(fr.yc_batch)},
  ${sqlJsonb(fr.previous_companies)},
  ${sqlJsonb(fr.institutions)},
  ${sqlJsonb(fr.awards_and_honors)},
  ${sqlJsonb(fr.past_exits)},
  'invested-companies-md',
  ${sqlJsonb(fr.enrichment_raw)}
);\n\n`;
  }
}

sql += "COMMIT;\n";

writeFileSync(outPath, sql, "utf8");
console.log(`Wrote ${outPath} (${all.length} deals, ${globalInvestorNames.size} investors)`);
