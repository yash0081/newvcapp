import { DEFAULT_RESEARCH_SITES, type DefaultResearchSite } from "@/lib/research/default-sites";
import type { WebsiteCategory } from "@/lib/research/types";

type UserPref = {
  domain: string;
  category: string;
  preference_score: number;
  success_rate: number;
  usage_count: number;
};

export type RankedSite = {
  domain: string;
  label: string;
  category: WebsiteCategory;
  utility: number;
  rationale: string;
};

function classifyCategory(task: string): WebsiteCategory {
  const t = task.toLowerCase();
  if (/\b(founder|team|ceo|cto|background|experience)\b/.test(t)) return "founder";
  if (/\b(product|tech|roadmap|feature|integration)\b/.test(t)) return "product";
  if (/\b(market|tam|competitor|category|positioning)\b/.test(t)) return "market";
  if (/\b(revenue|traction|growth|customers|pricing|funding)\b/.test(t)) return "traction";
  if (/\b(hiring|jobs|talent|headcount)\b/.test(t)) return "hiring";
  if (/\b(legal|regulatory|compliance|risk)\b/.test(t)) return "legal";
  if (/\b(news|press|announcement)\b/.test(t)) return "news";
  return "general";
}

function semanticFit(site: DefaultResearchSite, category: WebsiteCategory): number {
  if (site.categories.includes(category)) return 1;
  if (category === "general") return 0.6;
  return 0.15;
}

function preferenceScore(site: DefaultResearchSite, category: WebsiteCategory, prefs: UserPref[]): number {
  const pref = prefs.find((p) => p.domain === site.domain && (p.category === category || p.category === "general"));
  if (!pref) return 0;
  const usageBoost = Math.min(0.2, pref.usage_count * 0.02);
  return pref.preference_score * 0.7 + pref.success_rate * 0.3 + usageBoost;
}

function domainHintBoost(site: DefaultResearchSite, companyName: string): number {
  if (!companyName) return 0;
  const n = companyName.toLowerCase();
  return site.domain.includes("company-website") ? 0.25 : n.includes("ai") && site.domain === "github.com" ? 0.1 : 0;
}

export function rankSitesForTask(args: {
  task: string;
  companyName: string;
  userPreferences: UserPref[];
  limit?: number;
}): RankedSite[] {
  const category = classifyCategory(args.task);
  const out = DEFAULT_RESEARCH_SITES.map((site) => {
    const sem = semanticFit(site, category);
    const pref = preferenceScore(site, category, args.userPreferences);
    const hint = domainHintBoost(site, args.companyName);
    const utility = sem * 0.6 + pref * 0.3 + hint * 0.1;
    return {
      domain: site.domain,
      label: site.label,
      category,
      utility,
      rationale: `semantic=${sem.toFixed(2)}, pref=${pref.toFixed(2)}, context=${hint.toFixed(2)}`,
    };
  });

  return out.sort((a, b) => b.utility - a.utility).slice(0, args.limit ?? 4);
}

