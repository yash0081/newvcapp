import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { appendSavedChatMessage } from "@/lib/chat/history";
import type { ChatAction, ChatCitation } from "@/lib/chat/workspace-chat";

export async function POST(req: Request, ctx: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    role?: unknown;
    content?: unknown;
    dealId?: unknown;
    actions?: unknown;
    citations?: unknown;
  } | null;
  const role = body?.role === "user" || body?.role === "assistant" ? body.role : null;
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const dealId = typeof body?.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : null;
  if (!role || !content) return NextResponse.json({ error: "role and content are required" }, { status: 400 });

  try {
    const message = await appendSavedChatMessage({
      admin: createAdminClient(),
      userId: user.id,
      threadId,
      role,
      content,
      dealId,
      actions: Array.isArray(body?.actions) ? (body.actions as ChatAction[]) : [],
      citations: Array.isArray(body?.citations) ? (body.citations as ChatCitation[]) : [],
    });
    return NextResponse.json({ message });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save message";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
