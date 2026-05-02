import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runWorkspaceChat, type ChatMessage } from "@/lib/chat/workspace-chat";

type ChatRequest = {
  message?: unknown;
  dealId?: unknown;
  history?: unknown;
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

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as ChatRequest | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const dealId = typeof body?.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : null;
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  try {
    const admin = createAdminClient();
    const result = await runWorkspaceChat({
      admin,
      userId: user.id,
      message,
      dealId,
      history: parseHistory(body?.history),
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[workspace-chat]", e);
    const msg = e instanceof Error ? e.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
