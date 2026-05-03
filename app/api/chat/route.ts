import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_CHAT_TOOL_PERMISSIONS, runWorkspaceChat, type ChatMessage, type ChatToolPermissions } from "@/lib/chat/workspace-chat";
import { appendSavedChatMessage, ensureSavedChatThread } from "@/lib/chat/history";

type ChatRequest = {
  message?: unknown;
  dealId?: unknown;
  history?: unknown;
  threadId?: unknown;
  permissions?: unknown;
};

function parseHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw) {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const role = o.role === "user" || o.role === "assistant" ? o.role : null;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!role || !content) continue;
    out.push({ role, content: content.slice(0, 4000) });
    if (out.length >= 12) break;
  }
  return out;
}

function parsePermissions(raw: unknown): Partial<ChatToolPermissions> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<ChatToolPermissions> = {};
  for (const key of Object.keys(DEFAULT_CHAT_TOOL_PERMISSIONS) as Array<keyof ChatToolPermissions>) {
    if (typeof obj[key] === "boolean") out[key] = obj[key];
  }
  return out;
}

function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as ChatRequest | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const dealId = typeof body?.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : null;
  const requestedThreadId = typeof body?.threadId === "string" && body.threadId.trim() ? body.threadId.trim() : null;
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  try {
    const admin = createAdminClient();
    if (req.headers.get("accept")?.includes("text/event-stream")) {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const thread = await ensureSavedChatThread({
              admin,
              userId: user.id,
              threadId: requestedThreadId,
              firstMessage: message,
            });
            await appendSavedChatMessage({
              admin,
              userId: user.id,
              threadId: thread.id,
              role: "user",
              content: message,
              dealId,
            });
            controller.enqueue(sse({ type: "start", threadId: thread.id }));
            const result = await runWorkspaceChat({
              admin,
              userId: user.id,
              message,
              dealId,
              history: parseHistory(body?.history),
              permissions: parsePermissions(body?.permissions),
              onAssistantDelta: (text) => controller.enqueue(sse({ type: "delta", text })),
            });
            await appendSavedChatMessage({
              admin,
              userId: user.id,
              threadId: thread.id,
              role: "assistant",
              content: result.message || "",
              dealId: result.dealId ?? dealId,
              actions: result.actions ?? [],
              citations: result.citations ?? [],
            });
            controller.enqueue(sse({ type: "done", result: { ...result, threadId: thread.id } }));
            controller.close();
          } catch (e) {
            console.error("[workspace-chat-stream]", e);
            controller.enqueue(sse({ type: "error", error: e instanceof Error ? e.message : "Chat failed" }));
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

    const thread = await ensureSavedChatThread({
      admin,
      userId: user.id,
      threadId: requestedThreadId,
      firstMessage: message,
    });
    await appendSavedChatMessage({
      admin,
      userId: user.id,
      threadId: thread.id,
      role: "user",
      content: message,
      dealId,
    });

    const result = await runWorkspaceChat({
      admin,
      userId: user.id,
      message,
      dealId,
      history: parseHistory(body?.history),
      permissions: parsePermissions(body?.permissions),
    });

    await appendSavedChatMessage({
      admin,
      userId: user.id,
      threadId: thread.id,
      role: "assistant",
      content: result.message || "",
      dealId: result.dealId ?? dealId,
      actions: result.actions ?? [],
      citations: result.citations ?? [],
    });

    return NextResponse.json({ ...result, threadId: thread.id });
  } catch (e) {
    console.error("[workspace-chat]", e);
    const msg = e instanceof Error ? e.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
