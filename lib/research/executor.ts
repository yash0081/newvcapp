import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import type { ResearchSource } from "@/lib/research/types";

export type ExecutionOk = {
  ok: true;
  notes: string;
  sources: ResearchSource[];
  suggestedStepUpdates: Array<{ reason: string; website: string; task: string }>;
};

export type ExecutionErr = {
  ok: false;
  errorMessage: string;
};

export type ExecutionResult = ExecutionOk | ExecutionErr;

function isBroadWebSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return !s || s === "web" || s === "broad-web" || s === "general-web";
}

function parseExecution(raw: string): Omit<ExecutionOk, "ok"> | null {
  const normalizeSource = (s: unknown): ResearchSource | null => {
    if (!s || typeof s !== "object") return null;
    const x = s as Record<string, unknown>;
    const url = typeof x.url === "string" ? x.url.trim() : "";
    if (!url) return null;
    return {
      url,
      title: typeof x.title === "string" ? x.title : undefined,
      snippet: typeof x.snippet === "string" ? x.snippet : undefined,
    };
  };

  const normalizeUpdates = (v: unknown): Array<{ reason: string; website: string; task: string }> =>
    Array.isArray(v)
      ? v
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

  try {
    const p = (parseJsonFromResponseOrNull(raw) ?? null) as
      | {
          notes?: unknown;
          summary?: unknown;
          findings?: unknown;
          sources?: unknown;
          evidence?: unknown;
          suggestedStepUpdates?: unknown;
        }
      | null;
    if (!p || typeof p !== "object") return null;

    const sourcesRaw = Array.isArray(p.sources) ? p.sources : Array.isArray(p.evidence) ? p.evidence : [];
    const sources = sourcesRaw.map(normalizeSource).filter((s): s is ResearchSource => Boolean(s));
    const updates = normalizeUpdates(p.suggestedStepUpdates);
    const notes =
      typeof p.notes === "string"
        ? p.notes
        : typeof p.summary === "string"
          ? p.summary
          : Array.isArray(p.findings)
            ? p.findings
                .map((f) => (typeof f === "string" ? f : ""))
                .filter(Boolean)
                .join("\n")
            : "";
    if (!notes && sources.length === 0) return null;
    return { notes, sources, suggestedStepUpdates: updates };
  } catch {
    return null;
  }
}

function fallbackFromRaw(raw: string): Omit<ExecutionOk, "ok"> | null {
  const text = raw.trim();
  const urlRegex = /(https?:\/\/[^\s)]+[^\s),.!?;:])/gi;
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const m of text.matchAll(urlRegex)) {
    const url = String(m[1] || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url });
    if (sources.length >= 8) break;
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 16)
    .join("\n");

  if (!lines && sources.length === 0) return null;

  return {
    notes: lines || "Execution completed, but model output was unstructured.",
    sources,
    suggestedStepUpdates: [],
  };
}

export async function executeResearchStep(args: {
  companyName: string;
  companyContext: string;
  website: string;
  task: string;
}): Promise<ExecutionResult> {
  const sourceConstraint = isBroadWebSource(args.website)
    ? {
        mode: "broad_web",
        instruction: "Use the best available public web sources. The step is not tied to a particular website.",
      }
    : {
        mode: "source_constrained",
        instruction:
          "Use this source hint as a required target. If it is accessible and relevant, cite it directly; supplement with other sources only when needed.",
        website: args.website,
      };
  const prompt = `Execute one public-web research step.
Return strict JSON only:
{
  "notes": "bullet-like concise findings",
  "sources": [{"url":"https://...","title":"...","snippet":"..."}],
  "suggestedStepUpdates": [{"reason":"...","website":"...","task":"..."}]
}
Rules:
- Use Google Search grounding/server-side browsing. Do not assume the preferred website is already open.
- If Source constraint mode is "broad_web", choose the best sources for the task and do not force any particular website.
- If Source constraint mode is "source_constrained", use the provided source hint as a required target. If the source is inaccessible or has no relevant evidence, say that explicitly in notes.
- Stay focused on the research task. Do not return adjacent facts that fail to answer it.
- Use external web evidence where possible.
- Include 2-6 sources when available.
- Suggested follow-up steps should use website "web" unless they truly require a specific source.
- If evidence is weak, say so explicitly in notes.`;

  let raw = "";
  try {
    raw = await vertexRunWithTextMulti(
      getResearchModel("flash"),
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "Company context", value: args.companyContext || "No context." },
        { label: "Source constraint", value: sourceConstraint },
        { label: "Research task", value: args.task },
      ],
      true
    );
  } catch (e) {
    return {
      ok: false,
      errorMessage: `Execution failed while running this step: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = parseExecution(raw);
  if (parsed) {
    return { ok: true, ...parsed };
  }

  if (raw) {
    const fb = fallbackFromRaw(raw);
    if (fb) return { ok: true, ...fb };
  }

  return {
    ok: false,
    errorMessage: "Execution returned no usable content.",
  };
}
