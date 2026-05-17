import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ensureSavedChatThread, listSavedChatThreads } from "@/lib/chat/history";

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dealId = new URL(req.url).searchParams.get("dealId")?.trim() || null;

  try {
    const threads = await listSavedChatThreads(createAdminClient(), user.id, { dealId });
    return NextResponse.json({ threads });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load chats";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { title?: unknown; dealId?: unknown } | null;
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "New chat";
  const dealId = typeof body?.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : null;

  try {
    const thread = await ensureSavedChatThread({
      admin: createAdminClient(),
      userId: user.id,
      firstMessage: title,
      dealId,
    });
    return NextResponse.json({ threadId: thread.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create chat";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
