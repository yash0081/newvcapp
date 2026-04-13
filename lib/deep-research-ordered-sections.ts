import type { DealSourcingResult } from "@/lib/deal-sourcing-pipeline";
import type { SimilarPeerForPrompt } from "@/lib/similar-deals";
import { vertexStreamText } from "@/lib/vertex";

export type DeepSectionId =
  | "problem"
  | "solution"
  | "traction"
  | "team"
  | "risks"
  | "similar_deals"
  | "memo";

function safeSnippet(obj: unknown, max = 12000): string {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}\n…[truncated]`;
  } catch {
    return String(obj).slice(0, max);
  }
}

function companyNameFromResult(r: DealSourcingResult): string {
  const p = r.parsing_json as Record<string, unknown> | undefined;
  const co = p?.company_overview as Record<string, unknown> | undefined;
  return typeof co?.company_name === "string" ? co.company_name.trim() : "Company";
}

type SectionSpec = { id: DeepSectionId; title: string; prompt: string };

function buildSectionSpecs(r: DealSourcingResult, company: string): SectionSpec[] {
  const ps = r.pipeline_summaries;
  const problemPreview = ps?.problem?.trim() ?? "";
  const solutionPreview = ps?.solution?.trim() ?? "";
  const tractionPreview = ps?.traction?.trim() ?? "";
  const founderPreview = ps?.founder?.trim() ?? "";
  const assumptionsPreview = ps?.assumptions?.trim() ?? "";

  const peers = (r.similar_peers_context ?? []) as SimilarPeerForPrompt[];
  const peerLines =
    peers.length > 0
      ? peers
          .slice(0, 12)
          .map(
            (p, i) =>
              `${i + 1}. ${p.company_name ?? "Peer"} (sim ${typeof p.similarity_confidence === "number" ? p.similarity_confidence.toFixed(2) : "—"})`
          )
          .join("\n")
      : "(No comparable deals indexed yet.)";

  return [
    {
      id: "problem",
      title: "Problem",
      prompt: `You are writing the **Problem** section of a VC diligence memo for **${company}**.

Use ONLY the JSON and preview below. Write 2–4 tight paragraphs: pain, buyer, urgency, market depth. No scores, no bullet labels like "Summary:". Markdown allowed (bold sparingly).

### Pipeline preview
${problemPreview || "(none)"}

### Problem agent JSON
${safeSnippet(r.problem_quality_3c_json)}`,
    },
    {
      id: "solution",
      title: "Solution",
      prompt: `You are writing the **Solution & defensibility** section for **${company}**.

Use ONLY the data below. Cover product, moat, differentiation, replication risk. 2–4 paragraphs.

### Pipeline preview
${solutionPreview || "(none)"}

### Solution agent JSON
${safeSnippet(r.solution_defensibility_json)}`,
    },
    {
      id: "traction",
      title: "Traction",
      prompt: `You are writing the **Traction** section for **${company}**.

Use ONLY the data below. Stage, revenue/growth signals, investors, evidence quality. 2–4 paragraphs.

### Pipeline preview
${tractionPreview || "(none)"}

### Traction agent JSON
${safeSnippet(r.traction_signal_json)}`,
    },
    {
      id: "team",
      title: "Team",
      prompt: `You are writing the **Team** section for **${company}**.

Use ONLY the data below. Founders, relevant experience, gaps. 2–4 paragraphs.

### Pipeline preview
${founderPreview || "(none)"}

### Founder signals JSON
${safeSnippet(r.founder_signal_json)}`,
    },
    {
      id: "risks",
      title: "Risks & assumptions",
      prompt: `You are writing **Risks & key assumptions** for **${company}**.

Use ONLY the data below. Core assumptions, failure modes, open questions. 2–4 paragraphs.

### Pipeline preview
${assumptionsPreview || "(none)"}

### Assumptions / risk JSON
${safeSnippet(r.core_assumption_json)}`,
    },
    {
      id: "similar_deals",
      title: "Similar deals (corpus)",
      prompt: `You are summarizing **similar companies in the investor's corpus** for **${company}**.

Peers (from hybrid retrieval — informational only):
${peerLines}

Write 1–3 paragraphs on patterns and how ${company} compares. If the list is empty, say corpus peers are not available yet.`,
    },
    {
      id: "memo",
      title: "Memo-style summary",
      prompt: `Write a **short investment memo summary** (2–3 paragraphs) for **${company}**.

Ground in: thesis fit, problem, solution, traction, team, risks. Composite score context: thesis ${r.thesis_fit_score?.toFixed?.(1) ?? "—"}, problem ${r.problem_quality_score?.toFixed?.(1) ?? "—"}, solution ${r.solution_defensibility_score?.toFixed?.(1) ?? "—"}, traction ${r.traction_signal_score?.toFixed?.(1) ?? "—"}, founder ${r.founder_signal_score?.toFixed?.(1) ?? "—"}. No score table — integrate qualitatively.

### Thesis fit JSON (snippet)
${safeSnippet(r.thesis_fit_json, 8000)}`,
    },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run Vertex streams **sequentially** (one section at a time) to avoid 429s; emit NDJSON in fixed order.
 * Returns full markdown for persistence (e.g. chat_messages).
 */
export async function emitOrderedDeepResearchSections(args: {
  result: DealSourcingResult;
  send: (e: Record<string, unknown>) => void;
  model?: string;
}): Promise<string> {
  const model =
    args.model ||
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    process.env.GEMINI_MODEL_FLASH_LITE ||
    "gemini-2.5-flash-lite";

  const company = companyNameFromResult(args.result);
  const sections = buildSectionSpecs(args.result, company);
  const send = args.send;
  let fullMd = "";
  send({ type: "sections_begin" });

  for (let si = 0; si < sections.length; si++) {
    const s = sections[si]!;
    send({ type: "section_start", section: s.id, title: s.title });
    fullMd += `## ${s.title}\n\n`;

    try {
      for await (const chunk of vertexStreamText(model, s.prompt, false)) {
        fullMd += chunk;
        send({ type: "section_delta", section: s.id, text: chunk });
      }
    } catch (e) {
      const errLine = `\n\n_[Section stream error: ${e instanceof Error ? e.message : String(e)}]_\n`;
      fullMd += errLine;
      send({ type: "section_delta", section: s.id, text: errLine });
    }

    fullMd += "\n\n";
    send({ type: "section_end", section: s.id });

    if (si < sections.length - 1) {
      await sleep(350 + Math.floor(Math.random() * 200));
    }
  }

  return fullMd.trim();
}
