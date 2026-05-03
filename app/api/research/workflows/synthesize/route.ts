import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/research/db";
import { streamChatResearchAnswer, synthesizeChatResearchAnswer } from "@/lib/research/chat-synthesis";
import type { ResearchSource } from "@/lib/research/types";
import { stripMarkdownText } from "@/lib/plain-text";

type RawRun = {
  dealName?: unknown;
  task?: unknown;
  notes?: unknown;
  sources?: unknown;
};

function parseSources(raw: unknown): ResearchSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchSource[] = [];
  for (const source of raw) {
      const o = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
      const url = typeof o.url === "string" ? o.url.trim() : "";
      if (!url) continue;
      out.push({
        url,
        title: typeof o.title === "string" ? o.title : undefined,
        snippet: typeof o.snippet === "string" ? o.snippet : undefined,
      });
      if (out.length >= 12) break;
  }
  return out;
}

function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { userPrompt?: unknown; researchFocus?: unknown; companies?: unknown; runs?: unknown }
    | null;
  const runs = Array.isArray(body?.runs)
    ? (body.runs as RawRun[])
        .map((run) => ({
          dealName: typeof run.dealName === "string" ? run.dealName.slice(0, 200) : "Company",
          task: typeof run.task === "string" ? run.task.slice(0, 1000) : "Research",
          notes: typeof run.notes === "string" ? run.notes.slice(0, 12000) : "",
          sources: parseSources(run.sources),
        }))
        .filter((run) => run.notes.trim())
        .slice(0, 20)
    : [];
  if (!runs.length) return NextResponse.json({ error: "runs are required" }, { status: 400 });

  const payload = {
    userPrompt: typeof body?.userPrompt === "string" ? body.userPrompt.slice(0, 4000) : "",
    researchFocus: typeof body?.researchFocus === "string" ? body.researchFocus.slice(0, 5000) : "",
    companies: Array.isArray(body?.companies) ? body.companies.filter((x): x is string => typeof x === "string").slice(0, 12) : [],
    runs,
  };

  if (req.headers.get("accept")?.includes("text/event-stream")) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let answer = "";
          controller.enqueue(sse({ type: "start" }));
          for await (const chunk of streamChatResearchAnswer(payload)) {
            if (!chunk) continue;
            answer += chunk;
            controller.enqueue(sse({ type: "delta", text: chunk }));
          }
          const cleaned = stripMarkdownText(answer).trim();
          controller.enqueue(sse({ type: "done", answer: cleaned || answer.trim() }));
          controller.close();
        } catch (error) {
          const fallback = await synthesizeChatResearchAnswer(payload).catch(() => "");
          if (fallback) controller.enqueue(sse({ type: "delta", text: fallback }));
          controller.enqueue(sse({ type: fallback ? "done" : "error", answer: fallback, error: error instanceof Error ? error.message : "Research synthesis failed" }));
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  }

  const answer = await synthesizeChatResearchAnswer(payload);

  return NextResponse.json({ answer });
}
