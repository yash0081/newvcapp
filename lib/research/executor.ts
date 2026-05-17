import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import {
  profileExecuteModelTier,
  profileExecuteTimeoutMs,
  profileFollowUpLimit,
  type ResearchProfile,
} from "@/lib/research/mode-router";
import type { ResearchSource } from "@/lib/research/types";
import {
  DEAL_INTEL_LAYER1A_SCHEMA_GUIDE,
  DEAL_INTEL_QUALITY_GUARDRAILS,
  USER_PREFERENCE_GUARDRAILS,
} from "@/lib/deal-intel/prompt-guidance";
import { stripMarkdownText } from "@/lib/plain-text";
import { sanitizeResearchNotes, sanitizeResearchSources } from "@/lib/research/public-output";

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

function formatExecutionError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .map((part) => (typeof part === "string" || typeof part === "number" ? String(part).trim() : ""))
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json.slice(0, 1000);
    } catch {
      // Fall through to generic copy.
    }
  }
  return "Unknown research execution error";
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
          .slice(0, 3)
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
    const sources = sanitizeResearchSources(sourcesRaw.map(normalizeSource).filter((s): s is ResearchSource => Boolean(s)));
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
    const cleanNotes = sanitizeResearchNotes(notes);
    if (!cleanNotes && sources.length === 0) return null;
    return { notes: cleanNotes, sources, suggestedStepUpdates: updates };
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
    notes: sanitizeResearchNotes(lines || "Execution completed, but model output was unstructured."),
    sources: sanitizeResearchSources(sources),
    suggestedStepUpdates: [],
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function executeResearchStep(args: {
  companyName: string;
  companyContext: string;
  website: string;
  task: string;
  internalContext?: string;
  researchProfile?: ResearchProfile;
  timeoutMs?: number;
}): Promise<ExecutionResult> {
  const profile = args.researchProfile ?? "standard";
  const timeoutMs = args.timeoutMs ?? profileExecuteTimeoutMs(profile);
  const modelTier = profileExecuteModelTier(profile);
  const maxFollowUps = profileFollowUpLimit(profile);
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
  "notes": "plain text concise findings with no formatting syntax",
  "sources": [{"url":"https://...","title":"...","snippet":"..."}],
  "suggestedStepUpdates": [{"reason":"...","website":"...","task":"..."}]
}
Rules:
- Use Google Search grounding/server-side browsing. Do not assume the preferred website is already open.
- If Source constraint mode is "broad_web", choose the best sources for the task and do not force any particular website.
- If Source constraint mode is "source_constrained", use the provided source hint as a required target. If the source is inaccessible or has no relevant evidence, say that explicitly in notes.
- Stay focused on the research task. Do not return adjacent facts that fail to answer it.
- Use external web evidence where possible.
- Use the internal workspace context first. If it answers part of the task, incorporate it and use web research to verify, update, or fill missing details. Do not repeat internal context as if it came from the web.
- Use deterministic database signals when supplied for keyword or SQL-style questions, such as common investors, saved traction, saved competitors, saved customers, and prior document evidence.
- Include 2-6 sources when available.
- suggestedStepUpdates: return **[]** when this step fully answers the task and leaves no new blocking gap. Otherwise return up to ${maxFollowUps || 0} items (never more than 3).
- Each suggestedStepUpdates entry must be **plan-quality**: a concrete next research step a human would add to the workflow, not a vague "dig deeper."
  - **reason**: one sentence naming **the company**, what **new** gap or conflict appeared (or what remained **unverified**), and why the **current step list** would miss it. Forbidden: "further research", "learn more", "continue investigating" without naming the gap.
  - **task**: a single **answerable** instruction that names the company and a **schema angle** (e.g. funding_round, competitors, founder_experience) or a **named entity** to resolve. Must differ from the step you just ran.
  - **website**: usually **"web"**. Use a specific domain only when a registry, filing, product docs, or official site is clearly the right next hop.
- Do not suggest follow-ups for generic company overviews, duplicate angles you already resolved, or "nice to have" context unrelated to the original task.
- If evidence is weak, say so explicitly in notes.
- Notes must be clean regular text. Do not use headings, bold markers, bullet characters, numbered lists, code fences, or link markup.
- Map every finding to the canonical Deal Intel schema when possible:
${DEAL_INTEL_LAYER1A_SCHEMA_GUIDE}

${DEAL_INTEL_QUALITY_GUARDRAILS}

${USER_PREFERENCE_GUARDRAILS}`;

  let raw = "";
  try {
    raw = await withTimeout(
      vertexRunWithTextMulti(
        getResearchModel(modelTier),
        prompt,
        [
          { label: "Company name", value: args.companyName || "Unknown" },
          { label: "Company context", value: args.companyContext || "No context." },
          { label: "Internal workspace retrieval and database signals", value: args.internalContext || "No additional internal context was retrieved for this step." },
          { label: "Source constraint", value: sourceConstraint },
          { label: "Research task", value: args.task },
        ],
        true,
      ),
      timeoutMs,
      "Research step",
    );
  } catch (e) {
    return {
      ok: false,
      errorMessage: `Execution failed while running this step: ${formatExecutionError(e)}`,
    };
  }

  const parsed = parseExecution(raw);
  if (parsed) {
    const updates =
      maxFollowUps <= 0 ? [] : parsed.suggestedStepUpdates.slice(0, maxFollowUps);
    return {
      ok: true,
      ...parsed,
      notes: sanitizeResearchNotes(parsed.notes),
      sources: sanitizeResearchSources(parsed.sources),
      suggestedStepUpdates: updates,
    };
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
