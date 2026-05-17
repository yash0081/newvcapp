import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { stripMarkdownText } from "@/lib/plain-text";
import { getResearchModel } from "@/lib/research/research-model-env";
import { sanitizeResearchNotes, sanitizeResearchSources } from "@/lib/research/public-output";
import type { ResearchSource } from "@/lib/research/types";
import { vertexRunWithTextMulti, vertexStreamText } from "@/lib/vertex";

type ResearchSynthesisRun = {
  dealName: string;
  task: string;
  notes: string;
  sources?: ResearchSource[];
};

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function compactRun(run: ResearchSynthesisRun): Record<string, unknown> {
  return {
    company: stripMarkdownText(run.dealName),
    task: stripMarkdownText(run.task),
    findings: sanitizeResearchNotes(run.notes).slice(0, 5000),
    sources: sanitizeResearchSources(run.sources).map((source) => ({
      title: stripMarkdownText(source.title || host(source.url || "")),
      url: source.url,
      snippet: stripMarkdownText(source.snippet || "").slice(0, 500),
    })),
  };
}

function fallbackAnswer(runs: ResearchSynthesisRun[]): string {
  const chunks = runs
    .map((run) => sanitizeResearchNotes(run.notes).trim())
    .filter(Boolean)
    .slice(0, 5);
  return chunks.length
    ? chunks.join("\n\n")
    : "The research finished, but there was not enough usable evidence to write a confident answer.";
}

export async function synthesizeChatResearchAnswer(args: {
  userPrompt: string;
  researchFocus: string;
  companies: string[];
  runs: ResearchSynthesisRun[];
}): Promise<string> {
  const prompt = `Write the final chat answer after a completed VC research workflow.

Return strict JSON only:
{
  "answer": "plain text final answer"
}

Rules:
- This is the final answer, not a progress report. Do not mention plans, steps, tasks, workflows, how many searches ran, or internal tool names.
- Answer the user's actual request, not the broad research scaffold. Include every topic the user asked for, and remove facts that do not help answer those topics.
- Use saved workspace context, internal database evidence, document evidence, and web research together. Do not limit yourself to internal context. Do not repeat internal context unless it answers the question.
- Be selective. Do not include founder background, origin story, market sizing, traction, or other schema buckets unless the user asked for them or they are necessary to answer the question.
- If the user asks for competitors, patents, common investors, customers, pricing, or similar concrete fields, organize the answer around those fields.
- If the evidence is conflicting or thin, say that plainly.
- Write in polished regular prose with complete sentences. Use short labeled paragraphs when useful, but no bullets, numbered lists, tables, code fences, bold markers, or link markup.
- Keep the answer substantial enough to answer the request, but do not dump raw evidence. A good answer is usually 3 to 8 concise paragraphs.
- Preserve exact company names, investor names, source names, dates, patent numbers, and numbers when they appear in the evidence. Do not invent missing values.

User request is authoritative. Research focus may include broader analysis instructions that helped the planner, but those broader instructions must not expand the final answer beyond what the user asked.`;

  try {
    const raw = await vertexRunWithTextMulti(
      getResearchModel("flash"),
      prompt,
      [
        { label: "Original user request", value: stripMarkdownText(args.userPrompt || args.researchFocus) },
        { label: "Research focus used by planner", value: stripMarkdownText(args.researchFocus) },
        { label: "Companies researched", value: args.companies.map(stripMarkdownText) },
        { label: "Research outputs", value: args.runs.map(compactRun) },
      ],
      false,
    );
    const parsed = parseJsonFromResponseOrNull(raw) as { answer?: unknown } | null;
    const answer = typeof parsed?.answer === "string" ? stripMarkdownText(parsed.answer) : stripMarkdownText(raw);
    return answer || fallbackAnswer(args.runs);
  } catch {
    return fallbackAnswer(args.runs);
  }
}

function streamingSynthesisPrompt(args: {
  userPrompt: string;
  researchFocus: string;
  companies: string[];
  runs: ResearchSynthesisRun[];
}): string {
  return `Write the final chat answer after a completed VC research workflow.

Rules:
- This is the final answer, not a progress report. Do not mention plans, steps, tasks, workflows, how many searches ran, or internal tool names.
- Answer the user's actual request, not the broad research scaffold. Include every topic the user asked for, and remove facts that do not help answer those topics.
- Use saved workspace context, internal database evidence, document evidence, and web research together. Do not limit yourself to internal context. Do not repeat internal context unless it answers the question.
- Be selective. Do not include founder background, origin story, market sizing, traction, or other schema buckets unless the user asked for them or they are necessary to answer the question.
- If the user asks for competitors, patents, common investors, customers, pricing, or similar concrete fields, organize the answer around those fields.
- If the evidence is conflicting or thin, say that plainly.
- Write in polished regular prose with complete sentences. Use short labeled paragraphs when useful, but no bullets, numbered lists, tables, code fences, bold markers, or link markup.
- Keep the answer substantial enough to answer the request, but do not dump raw evidence. A good answer is usually 3 to 8 concise paragraphs.
- Preserve exact company names, investor names, source names, dates, patent numbers, and numbers when they appear in the evidence. Do not invent missing values.
- Output the answer text directly. Do not wrap it in JSON.

User request is authoritative. Research focus may include broader analysis instructions that helped the planner, but those broader instructions must not expand the final answer beyond what the user asked.

Original user request:
${stripMarkdownText(args.userPrompt || args.researchFocus)}

Research focus used by planner:
${stripMarkdownText(args.researchFocus)}

Companies researched:
${JSON.stringify(args.companies.map(stripMarkdownText))}

Research outputs:
${JSON.stringify(args.runs.map(compactRun), null, 2)}`;
}

export async function* streamChatResearchAnswer(args: {
  userPrompt: string;
  researchFocus: string;
  companies: string[];
  runs: ResearchSynthesisRun[];
}): AsyncGenerator<string, void, unknown> {
  const prompt = streamingSynthesisPrompt(args);
  for await (const chunk of vertexStreamText(getResearchModel("flash"), prompt, false)) {
    if (chunk) yield chunk;
  }
}
