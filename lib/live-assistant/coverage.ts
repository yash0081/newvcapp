import type { ClaimSection } from "@/lib/live-assistant/claim-classifier";

export type CoverageChecklist = Record<ClaimSection, string[]>;
export type CoverageState = Record<ClaimSection, Set<string>>;

export const DEFAULT_CHECKLIST: CoverageChecklist = {
  team: ["founder_background", "hiring_plan"],
  problem: ["pain_severity", "current_alternative"],
  solution: ["value_prop", "defensibility"],
  market: ["tam", "customer_segment"],
  product: ["roadmap", "current_capability"],
  traction: ["revenue", "growth", "churn"],
  gtm: ["acquisition_channel", "sales_motion"],
  competition: ["primary_competitors", "differentiation"],
  financials: ["burn", "runway"],
  risks: ["execution_risk", "market_risk"],
  other: [],
};

function emptyState(): CoverageState {
  return {
    team: new Set<string>(),
    problem: new Set<string>(),
    solution: new Set<string>(),
    market: new Set<string>(),
    product: new Set<string>(),
    traction: new Set<string>(),
    gtm: new Set<string>(),
    competition: new Set<string>(),
    financials: new Set<string>(),
    risks: new Set<string>(),
    other: new Set<string>(),
  };
}

function fillFromText(state: CoverageState, section: ClaimSection, text: string) {
  const s = text.toLowerCase();
  const add = (slot: string, cond: boolean) => {
    if (cond) state[section].add(slot);
  };
  if (section === "traction") {
    add("revenue", /\b(arr|revenue|mrr)\b/.test(s));
    add("growth", /\b(growth|mom|yoy|qoq)\b/.test(s));
    add("churn", /\bchurn\b/.test(s));
  }
  if (section === "gtm") {
    add("acquisition_channel", /\b(channel|inbound|outbound|seo|ads|partnership)\b/.test(s));
    add("sales_motion", /\b(self-serve|sales-led|plg|enterprise sales|mid-market)\b/.test(s));
  }
  if (section === "market") {
    add("tam", /\b(tam|sam|som)\b/.test(s));
    add("customer_segment", /\b(smb|enterprise|mid-market|developer|consumer)\b/.test(s));
  }
}

export function updateCoverageState(
  prev: CoverageState | undefined,
  claims: Array<{ section: ClaimSection; text: string }>,
): CoverageState {
  const next = prev ?? emptyState();
  for (const c of claims) fillFromText(next, c.section, c.text);
  return next;
}

export function missingCoveragePrompts(state: CoverageState, checklist: CoverageChecklist = DEFAULT_CHECKLIST): string[] {
  const prompts: string[] = [];
  for (const section of Object.keys(checklist) as ClaimSection[]) {
    const slots = checklist[section];
    const covered = state[section];
    for (const slot of slots) {
      if (!covered.has(slot)) {
        prompts.push(`Ask about ${slot.replace(/_/g, " ")} (${section}).`);
      }
    }
  }
  return prompts;
}

