import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  chatModelForTask,
  classifyChatTaskWithGemma,
  retrieveLimitForTask,
} from "@/lib/chat-router-gemma";
import {
  buildAgenticSystemPrompt,
  formatFundThesisForPrompt,
  formatInvestmentRulesForSystemPrompt,
  formatRetrievedChunksForPrompt,
} from "@/lib/agentic-chat-context";
import { loadAggregatedRulesForUser } from "@/lib/investment-rules";
import {
  mapTaskToQueryType,
  retrieveContextNodesForQuery,
} from "@/lib/retrieval-orchestrator";
import { resolveDealIdsFromTabularFilter } from "@/lib/filter-deals-from-query";
import { compressChatHistoryIfNeeded } from "@/lib/chat-history-compress";
import { streamChatAnswerWithRetry } from "@/lib/chat-generate-with-retry";
import { buildChatPlanSummary } from "@/lib/chat-plan";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let body: {
    threadId?: string | null;
    dealId?: string | null;
    message?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return new Response(JSON.stringify({ error: "message required" }), { status: 400 });
  }

  const admin = createAdminClient();
  const flashLite =
    process.env.GEMINI_MODEL_FLASH_LITE ||
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    "gemini-2.5-flash-lite";
  // Chat-history compression: cheap / high-throughput; defaults to FLASH_LITE chain.
  const historySummaryModel =
    process.env.GEMINI_MODEL_CHAT_HISTORY_SUMMARY?.trim() || flashLite;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        let threadId = body.threadId ?? null;
        if (!threadId) {
          const { data: t, error: te } = await admin
            .from("chat_threads")
            .insert({
              user_id: user.id,
              deal_id: body.dealId ?? null,
              title: message.slice(0, 80),
            })
            .select("id")
            .single();
          if (te || !t) {
            send({ type: "error", message: "Failed to create thread" });
            controller.close();
            return;
          }
          threadId = t.id as string;
          send({ type: "thread", threadId });
        }

        await admin.from("chat_messages").insert({
          thread_id: threadId,
          role: "user",
          content: message,
        });

        const { data: prior } = await admin
          .from("chat_messages")
          .select("role, content")
          .eq("thread_id", threadId)
          .order("created_at", { ascending: true })
          .limit(40);
        const rawHistory =
          (prior ?? [])
            .slice(0, -1)
            .map((m) => `${m.role}: ${(m.content as string).slice(0, 2000)}`)
            .join("\n") || "";

        const task = await classifyChatTaskWithGemma(message);
        const queryType = mapTaskToQueryType(task);
        const model = chatModelForTask(task);
        const retrieveLimit = retrieveLimitForTask(task);

        let tabularIdsForRetrieval: string[] | undefined;
        let tabularCount: number | null = null;
        if (queryType === "filter_semantic" || task === "filtering") {
          tabularIdsForRetrieval = await resolveDealIdsFromTabularFilter(admin, user.id, message);
          tabularCount = tabularIdsForRetrieval.length;
        }

        const rules = await loadAggregatedRulesForUser(admin, user.id);
        const rulesBlock =
          task === "filtering"
            ? "Tabular / list filters take priority; cite retrieved deal rows. Fund rules are secondary for this turn."
            : formatInvestmentRulesForSystemPrompt(rules);
        const { data: thesisRow } = await admin
          .from("fund_thesis")
          .select("thesis_text")
          .eq("user_id", user.id)
          .maybeSingle();
        const thesisText =
          thesisRow && typeof (thesisRow as { thesis_text?: string }).thesis_text === "string"
            ? (thesisRow as { thesis_text: string }).thesis_text
            : null;
        const institutionalBlock =
          task === "filtering" ? "" : formatFundThesisForPrompt(thesisText);
        const chunks = await retrieveContextNodesForQuery(admin, {
          userId: user.id,
          queryText: message,
          queryType,
          chatTask: task,
          focusDealId: body.dealId ?? null,
          limit: retrieveLimit,
          precomputedTabularDealIds: tabularIdsForRetrieval,
        });

        send({
          type: "step",
          label: "planner",
          detail: buildChatPlanSummary({
            task,
            tabularDealCount: tabularCount,
            retrievedChunkCount: chunks.length,
          }),
        });
        send({ type: "step", label: "retrieve", detail: queryType });

        let dealName: string | null = null;
        if (body.dealId) {
          const { data: d } = await admin
            .from("deals")
            .select("company_name")
            .eq("id", body.dealId)
            .eq("user_id", user.id)
            .maybeSingle();
          dealName = (d?.company_name as string) ?? null;
        }

        const system = buildAgenticSystemPrompt({
          taskLabel: task,
          dealName,
          rulesBlock,
          institutionalBlock,
          contextBlock: formatRetrievedChunksForPrompt(chunks),
          workspaceHint: body.dealId
            ? undefined
            : "You can **attach a PDF** in this Assistant for a full scored pipeline, or use **Decks & thesis**. Ordinary messages use indexed deal context and your rules only.",
        });

        const historyBlock = await compressChatHistoryIfNeeded(
          rawHistory,
          historySummaryModel
        );
        const fullUser = `${historyBlock ? `${historyBlock}\n\n` : ""}Current user message:\n${message}\n\nAnswer using the context blocks. Cite [n] references when relevant.`;

        send({
          type: "step",
          label: "generate",
          detail: `${model} · ${task}`,
        });
        const prompt = `${system}\n\n---\n\n${fullUser}`;
        let text = "";
        for await (const part of streamChatAnswerWithRetry(model, prompt)) {
          if (part.kind === "delta") {
            text += part.text;
            send({ type: "delta", text: part.text });
          } else {
            text = part.text;
            send({ type: "replace", text: part.text });
          }
        }

        await admin.from("chat_messages").insert({
          thread_id: threadId,
          role: "assistant",
          content: text,
        });

        await admin
          .from("chat_threads")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", threadId);

        send({ type: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send({ type: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
