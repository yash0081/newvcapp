import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { rankSitesForTask } from "@/lib/research/site-ranking";
import { getResearchModel } from "@/lib/research/research-model-env";
import type { ResearchPlanSuggestion, WebsiteCategory } from "@/lib/research/types";

type UserPref = {
  domain: string;
  category: string;
  preference_score: number;
  success_rate: number;
  usage_count: number;
};

function toStringSafe(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asCategory(v: unknown): WebsiteCategory | undefined {
  const s = toStringSafe(v);
  if (
    s === "founder" ||
    s === "product" ||
    s === "market" ||
    s === "traction" ||
    s === "hiring" ||
    s === "legal" ||
    s === "news" ||
    s === "general"
  ) {
    return s;
  }
  return undefined;
}

function parseSuggestion(raw: string): ResearchPlanSuggestion | null {
  const parsed = parseJsonFromResponseOrNull(raw) as
    | {
        summary?: unknown;
        steps?: Array<{ website?: unknown; task?: unknown; category?: unknown; dependsOnStepIds?: unknown }>;
      }
    | null;
  if (!parsed || typeof parsed !== "object") return null;

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps
        .map((s) => ({
          website: toStringSafe(s.website),
          task: toStringSafe(s.task),
          category: asCategory(s.category),
          dependsOnStepIds: Array.isArray(s.dependsOnStepIds)
            ? s.dependsOnStepIds.filter((x): x is string => typeof x === "string")
            : [],
        }))
        .filter((s) => s.website && s.task)
    : [];
  if (!steps.length) return null;
  return {
    summary: toStringSafe(parsed.summary) || "Auto-generated research plan.",
    steps,
  };
}

function fallbackFromRaw(args: {
  raw: string;
  companyName: string;
  prefs: UserPref[];
}): ResearchPlanSuggestion | null {
  const text = args.raw.trim();
  if (!text) return null;

  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const enumeratedTasks: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.)]|[-*•])\s+(.+)$/);
    if (m && m[1]) enumeratedTasks.push(m[1].trim());
    if (enumeratedTasks.length >= 6) break;
  }

  if (enumeratedTasks.length < 3) return null;

  const steps = enumeratedTasks.map((task) => {
    const top = rankSitesForTask({
      task,
      companyName: args.companyName,
      userPreferences: args.prefs,
      limit: 1,
    })[0];
    return {
      website: top?.domain || "company-website",
      task,
      category: top?.category || "general",
      dependsOnStepIds: [] as string[],
    };
  });

  return {
    summary: `Recovered plan for ${args.companyName || "this company"} (model output was loosely structured).`,
    steps,
  };
}

function deterministicFallback(args: {
  companyName: string;
  companyContext: string;
  prefs: UserPref[];
}): ResearchPlanSuggestion {
  const coreTasks = [
    "Validate founder background, prior exits, and hiring quality signals.",
    "Verify product positioning, pricing, and technical differentiation evidence.",
    "Assess traction signals (customers, growth, fundraising, and partnerships).",
    "Map competitor landscape and market timing risks.",
  ];
  const steps = coreTasks.map((task) => {
    const top = rankSitesForTask({
      task,
      companyName: args.companyName,
      userPreferences: args.prefs,
      limit: 1,
    })[0];
    return {
      website: top?.domain || "company-website",
      task,
      category: top?.category || "general",
      dependsOnStepIds: [],
    };
  });

  return {
    summary: `Initial plan for ${args.companyName || "this company"} based on default research strategy.`,
    steps,
  };
}

export async function generateResearchPlan(args: {
  companyName: string;
  companyContext: string;
  preferences: UserPref[];
}): Promise<ResearchPlanSuggestion> {
  const rankedExamples = rankSitesForTask({
    task: "Research founder quality and company traction",
    companyName: args.companyName,
    userPreferences: args.preferences,
    limit: 5,
  });

  const prompt = `You are creating a practical startup diligence workflow.
Return strict JSON only with shape:
{
  "summary": "string",
  "steps": [
    {
      "website": "domain-or-site-hint",
      "task": "clear task instruction",
      "category": "founder|product|market|traction|hiring|legal|news|general",
      "dependsOnStepIds": []
    }
  ]
}
Rules:
- Produce 4-7 steps.
- Prefer high-signal public sources.
- Keep tasks specific and evidence-oriented.
- If website is company website, use "company-website".`;

  let raw = "";
  try {
    raw = await vertexRunWithTextMulti(
      getResearchModel("flash"),
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "Known company context", value: args.companyContext || "No context available yet." },
        { label: "Top ranked websites", value: rankedExamples },
        { label: "User website preferences", value: args.preferences },
      ],
      false
    );
    const parsed = parseSuggestion(raw);
    if (parsed) return parsed;

    const recovered = fallbackFromRaw({
      raw,
      companyName: args.companyName,
      prefs: args.preferences,
    });
    if (recovered) return recovered;
  } catch {
    // Fall through to deterministic fallback below
  }

  return deterministicFallback({
    companyName: args.companyName,
    companyContext: args.companyContext,
    prefs: args.preferences,
  });
}
