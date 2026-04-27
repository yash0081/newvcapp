import { runWithTextMultiRaw } from "@/lib/gemini";
import type { ResearchSource } from "@/lib/research/types";

type ExecutionResult = {
  notes: string;
  sources: ResearchSource[];
  suggestedStepUpdates: Array<{ reason: string; website: string; task: string }>;
};

function stripCodeFence(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith("```")) return s;
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseExecution(raw: string): ExecutionResult | null {
  try {
    const p = JSON.parse(stripCodeFence(raw)) as {
      notes?: unknown;
      sources?: unknown;
      suggestedStepUpdates?: unknown;
    };
    const sources = Array.isArray(p.sources)
      ? p.sources
          .map((s) => {
            const x = s as Record<string, unknown>;
            return {
              url: typeof x.url === "string" ? x.url : "",
              title: typeof x.title === "string" ? x.title : undefined,
              snippet: typeof x.snippet === "string" ? x.snippet : undefined,
            };
          })
          .filter((s) => s.url)
      : [];
    const updates = Array.isArray(p.suggestedStepUpdates)
      ? p.suggestedStepUpdates
          .map((u) => {
            const x = u as Record<string, unknown>;
            return {
              reason: typeof x.reason === "string" ? x.reason : "",
              website: typeof x.website === "string" ? x.website : "",
              task: typeof x.task === "string" ? x.task : "",
            };
          })
          .filter((u) => u.reason && u.website && u.task)
      : [];
    const notes = typeof p.notes === "string" ? p.notes : "";
    if (!notes) return null;
    return { notes, sources, suggestedStepUpdates: updates };
  } catch {
    return null;
  }
}

export async function executeResearchStep(args: {
  companyName: string;
  companyContext: string;
  website: string;
  task: string;
}): Promise<ExecutionResult> {
  const prompt = `Execute one public-web research step.
Return strict JSON only:
{
  "notes": "bullet-like concise findings",
  "sources": [{"url":"https://...","title":"...","snippet":"..."}],
  "suggestedStepUpdates": [{"reason":"...","website":"...","task":"..."}]
}
Rules:
- Use external web evidence where possible.
- Include 2-6 sources when available.
- If evidence is weak, say so explicitly in notes.`;

  try {
    const raw = await runWithTextMultiRaw(
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "Company context", value: args.companyContext || "No context." },
        { label: "Preferred website", value: args.website },
        { label: "Research task", value: args.task },
      ],
      "flash",
      true
    );
    const parsed = parseExecution(raw);
    if (parsed) return parsed;
  } catch (e) {
    return {
      notes: `Execution failed while running this step: ${e instanceof Error ? e.message : String(e)}`,
      sources: [],
      suggestedStepUpdates: [],
    };
  }

  return {
    notes: "No structured result could be extracted from execution output.",
    sources: [],
    suggestedStepUpdates: [],
  };
}

