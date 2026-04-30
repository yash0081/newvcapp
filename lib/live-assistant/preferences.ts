import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimSection } from "@/lib/live-assistant/claim-classifier";

export type LiveAssistantPreferenceSignals = {
  sectionWeights: Partial<Record<ClaimSection, number>>;
  websiteDomains: string[];
  focusHints: string[];
  preferenceConfidence: number;
  domainAffinity: Record<string, number>;
  taskAffinity: Record<string, number>;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeDomain(s: string): string {
  return s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
}

export async function loadLiveAssistantPreferenceSignals(
  admin: SupabaseClient,
  userId: string,
): Promise<LiveAssistantPreferenceSignals> {
  const [sitePref, websitePref] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("user_research_site_preference")
      .select("domain, category, preference_score, usage_count")
      .eq("user_id", userId)
      .order("usage_count", { ascending: false })
      .limit(12),
    admin
      .schema("deal_intel")
      .from("website_preference")
      .select("website_domain, task_types, focus_guidance, preference_score, confidence, recency_weight")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(12),
  ]);

  const sectionWeights: Partial<Record<ClaimSection, number>> = {};
  const focusHints: string[] = [];
  const websiteDomains: string[] = [];
  const domainAffinity = new Map<string, number>();
  const taskAffinity = new Map<string, number>();
  let confidenceSum = 0;
  let confidenceN = 0;

  for (const row of (sitePref.data ?? []) as Array<Record<string, unknown>>) {
    const cat = String(row.category ?? "").toLowerCase();
    const score = Number(row.preference_score ?? 0);
    const usage = Number(row.usage_count ?? 0);
    const usageFactor = clamp(1 + Math.log10(Math.max(1, usage + 1)) * 0.08, 1, 1.28);
    const w = clamp((1 + score * 0.4) * usageFactor, 0.6, 1.7);
    if (cat.includes("traction")) sectionWeights.traction = Math.max(sectionWeights.traction ?? 1, w);
    if (cat.includes("market")) sectionWeights.market = Math.max(sectionWeights.market ?? 1, w);
    if (cat.includes("financial")) sectionWeights.financials = Math.max(sectionWeights.financials ?? 1, w);
    if (cat.includes("risk")) sectionWeights.risks = Math.max(sectionWeights.risks ?? 1, w);
    const domain = normalizeDomain(String(row.domain ?? ""));
    if (domain) {
      websiteDomains.push(domain);
      domainAffinity.set(domain, Math.max(domainAffinity.get(domain) ?? 0, clamp(0.5 + score * 0.4 + usage * 0.02, 0.2, 1.8)));
    }
  }

  for (const row of (websitePref.data ?? []) as Array<Record<string, unknown>>) {
    const domain = normalizeDomain(String(row.website_domain ?? ""));
    if (domain) websiteDomains.push(domain);
    const focus = String(row.focus_guidance ?? "").trim();
    if (focus) focusHints.push(focus.slice(0, 160));
    const rowPref = Number(row.preference_score ?? 0.5);
    const rowConf = Number(row.confidence ?? 0.5);
    const rowRecency = Number(row.recency_weight ?? 1);
    const calibrated = clamp(rowPref * 0.45 + rowConf * 0.4 + rowRecency * 0.15, 0, 1);
    confidenceSum += calibrated;
    confidenceN += 1;
    if (domain) {
      const prev = domainAffinity.get(domain) ?? 0;
      domainAffinity.set(domain, Math.max(prev, clamp(0.7 + calibrated * 0.9, 0.3, 1.9)));
    }
    const tasks = Array.isArray(row.task_types) ? row.task_types : [];
    for (const t of tasks.slice(0, 3)) {
      const s = String(t).toLowerCase();
      if (s.includes("traction")) sectionWeights.traction = Math.max(sectionWeights.traction ?? 1, 1.15);
      if (s.includes("gtm")) sectionWeights.gtm = Math.max(sectionWeights.gtm ?? 1, 1.1);
      if (s.includes("market")) sectionWeights.market = Math.max(sectionWeights.market ?? 1, 1.1);
      if (s.includes("risk")) sectionWeights.risks = Math.max(sectionWeights.risks ?? 1, 1.1);
      taskAffinity.set(s, Math.max(taskAffinity.get(s) ?? 0, clamp(0.8 + calibrated * 0.7, 0.4, 1.8)));
    }
  }

  return {
    sectionWeights,
    websiteDomains: Array.from(new Set(websiteDomains)).slice(0, 10),
    focusHints: Array.from(new Set(focusHints)).slice(0, 8),
    preferenceConfidence: confidenceN > 0 ? clamp(confidenceSum / confidenceN, 0.25, 1) : 0.5,
    domainAffinity: Object.fromEntries(Array.from(domainAffinity.entries()).slice(0, 20)),
    taskAffinity: Object.fromEntries(Array.from(taskAffinity.entries()).slice(0, 20)),
  };
}

