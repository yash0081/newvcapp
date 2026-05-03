import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatAction, ChatCitation } from "@/lib/chat/workspace-chat";
import { stripMarkdownText } from "@/lib/plain-text";

export type SavedChatThread = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  dealId: string | null;
  preview: string;
};

export type SavedChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
  citations?: ChatCitation[];
  dealId?: string | null;
  created_at: string;
};

type ThreadRow = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function titleFromMessage(message: string): string {
  const compact = stripMarkdownText(message).trim().replace(/\s+/g, " ");
  if (!compact) return "New chat";
  return compact.length > 48 ? `${compact.slice(0, 45)}...` : compact;
}

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asSavedMessage(row: MessageRow): SavedChatMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  const meta = safeMeta(row.metadata);
  return {
    id: row.id,
    role: row.role,
    content: stripMarkdownText(row.content),
    actions: Array.isArray(meta.actions) ? (meta.actions as ChatAction[]) : undefined,
    citations: Array.isArray(meta.citations) ? (meta.citations as ChatCitation[]) : undefined,
    dealId: typeof meta.dealId === "string" ? meta.dealId : null,
    created_at: row.created_at,
  };
}

export async function listSavedChatThreads(admin: SupabaseClient, userId: string): Promise<SavedChatThread[]> {
  const threadsRes = await admin
    .from("chat_threads")
    .select("id, title, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(40);
  if (threadsRes.error) throw threadsRes.error;

  const rows = (threadsRes.data ?? []) as ThreadRow[];
  if (!rows.length) return [];

  const messageRes = await admin
    .from("chat_messages")
    .select("id, thread_id, role, content, metadata, created_at")
    .in("thread_id", rows.map((row) => row.id))
    .order("created_at", { ascending: false });
  if (messageRes.error) throw messageRes.error;

  const latestByThread = new Map<string, MessageRow & { thread_id: string }>();
  for (const message of (messageRes.data ?? []) as Array<MessageRow & { thread_id: string }>) {
    if (!latestByThread.has(message.thread_id)) latestByThread.set(message.thread_id, message);
  }

  return rows.map((thread) => {
    const latest = latestByThread.get(thread.id);
    const meta = safeMeta(latest?.metadata);
    const title = thread.title?.trim() || titleFromMessage(latest?.content ?? "");
    return {
      id: thread.id,
      title,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      dealId: typeof meta.dealId === "string" ? meta.dealId : null,
      preview: stripMarkdownText(latest?.content ?? "").trim().slice(0, 120),
    };
  });
}

export async function loadSavedChatThread(admin: SupabaseClient, userId: string, threadId: string) {
  const threadRes = await admin
    .from("chat_threads")
    .select("id, title, created_at, updated_at")
    .eq("id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (threadRes.error) throw threadRes.error;
  if (!threadRes.data) return null;

  const messagesRes = await admin
    .from("chat_messages")
    .select("id, role, content, metadata, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (messagesRes.error) throw messagesRes.error;

  const messages = ((messagesRes.data ?? []) as MessageRow[]).map(asSavedMessage).filter((m): m is SavedChatMessage => Boolean(m));
  const lastDealId = [...messages].reverse().find((m) => m.dealId)?.dealId ?? null;
  const thread = threadRes.data as ThreadRow;
  return {
    thread: {
      id: thread.id,
      title: thread.title?.trim() || titleFromMessage(messages[0]?.content ?? ""),
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      dealId: lastDealId,
      preview: stripMarkdownText(messages[messages.length - 1]?.content ?? "").slice(0, 120),
    } satisfies SavedChatThread,
    messages,
  };
}

export async function deleteSavedChatThread(admin: SupabaseClient, userId: string, threadId: string): Promise<boolean> {
  const res = await admin
    .from("chat_threads")
    .delete()
    .eq("id", threadId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (res.error) throw res.error;
  return Boolean(res.data?.id);
}

export async function ensureSavedChatThread(args: {
  admin: SupabaseClient;
  userId: string;
  threadId?: string | null;
  firstMessage: string;
}) {
  if (args.threadId) {
    const existing = await args.admin
      .from("chat_threads")
      .select("id, title")
      .eq("id", args.threadId)
      .eq("user_id", args.userId)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data?.id) return { id: existing.data.id as string, created: false };
  }

  const inserted = await args.admin
    .from("chat_threads")
    .insert({
      user_id: args.userId,
      title: titleFromMessage(args.firstMessage),
    })
    .select("id")
    .single();
  if (inserted.error || !inserted.data?.id) throw inserted.error ?? new Error("Failed to create chat thread");
  return { id: inserted.data.id as string, created: true };
}

export async function appendSavedChatMessage(args: {
  admin: SupabaseClient;
  userId: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  dealId?: string | null;
  actions?: ChatAction[];
  citations?: ChatCitation[];
}) {
  const thread = await args.admin
    .from("chat_threads")
    .select("id, title")
    .eq("id", args.threadId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (thread.error) throw thread.error;
  if (!thread.data) throw new Error("Chat thread not found");

  const metadata = {
    dealId: args.dealId ?? null,
    actions: args.actions ?? [],
    citations: args.citations ?? [],
  };

  const inserted = await args.admin
    .from("chat_messages")
    .insert({
      thread_id: args.threadId,
      role: args.role,
      content: stripMarkdownText(args.content),
      metadata,
    })
    .select("id, role, content, metadata, created_at")
    .single();
  if (inserted.error || !inserted.data) throw inserted.error ?? new Error("Failed to save chat message");

  await args.admin
    .from("chat_threads")
    .update({
      updated_at: new Date().toISOString(),
      title: thread.data.title || titleFromMessage(args.content),
    })
    .eq("id", args.threadId)
    .eq("user_id", args.userId);

  const message = asSavedMessage(inserted.data as MessageRow);
  if (!message) throw new Error("Failed to normalize chat message");
  return message;
}
