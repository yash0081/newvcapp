"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { AgentChat } from "@/components/agent-chat";

type ThreadRow = {
  id: string;
  title: string | null;
  deal_id: string | null;
  updated_at: string;
};

export function ChatWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const activeThreadId = searchParams.get("thread");
  const dealFromUrl = searchParams.get("deal");

  const refreshThreads = useCallback(async () => {
    const res = await fetch("/api/chat/threads");
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray((data as { threads?: ThreadRow[] }).threads)) {
      setThreads((data as { threads: ThreadRow[] }).threads);
    }
  }, []);

  useEffect(() => {
    void refreshThreads().finally(() => setListLoading(false));
  }, [refreshThreads]);

  /** From deal page: reuse an existing deal-scoped thread or create one, then switch to ?thread=. */
  useEffect(() => {
    if (!dealFromUrl || activeThreadId || listLoading) return;
    let cancelled = false;
    void (async () => {
      try {
        const existing = await fetch(
          `/api/chat/threads?dealId=${encodeURIComponent(dealFromUrl)}`
        ).then((r) => r.json());
        if (cancelled) return;
        const row = (existing as { threads?: ThreadRow[] }).threads?.[0];
        if (row?.id) {
          router.replace(`/home/chat?thread=${encodeURIComponent(row.id)}`);
          await refreshThreads();
          return;
        }
        const created = await fetch("/api/chat/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deal_id: dealFromUrl,
            title: "Deal chat",
          }),
        }).then((r) => r.json());
        if (cancelled) return;
        const id = (created as { thread?: { id: string } }).thread?.id;
        if (id) {
          router.replace(`/home/chat?thread=${encodeURIComponent(id)}`);
          await refreshThreads();
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealFromUrl, activeThreadId, listLoading, router, refreshThreads]);

  function newChat() {
    router.push("/home/chat");
  }

  function selectThread(id: string) {
    router.push(`/home/chat?thread=${encodeURIComponent(id)}`);
  }

  async function deleteThread(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this chat?")) return;
    const res = await fetch(`/api/chat/threads/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    await refreshThreads();
    if (activeThreadId === id) {
      router.push("/home/chat");
    }
  }

  return (
    <div className="flex flex-1 min-h-0 w-full">
      <aside className="hidden md:flex w-[260px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80">
        <div className="p-2 border-b border-zinc-200/90">
          <button
            type="button"
            onClick={newChat}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-zinc-900 text-white text-sm font-medium py-2.5 px-3 hover:bg-zinc-800 transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0" />
            New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {listLoading ? (
            <p className="text-xs text-zinc-500 px-2 py-3">Loading…</p>
          ) : threads.length === 0 ? (
            <p className="text-xs text-zinc-500 px-2 py-3">No chats yet.</p>
          ) : (
            threads.map((t) => {
              const active = activeThreadId === t.id;
              const label = (t.title || "New chat").slice(0, 42);
              return (
                <div
                  key={t.id}
                  className={`group flex items-center gap-1 rounded-lg border ${
                    active
                      ? "border-zinc-300 bg-white shadow-sm"
                      : "border-transparent hover:bg-white/80 hover:border-zinc-200/80"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectThread(t.id)}
                    className="flex-1 min-w-0 text-left text-sm text-zinc-800 py-2 pl-2.5 pr-1 truncate"
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => void deleteThread(t.id, e)}
                    className="shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Delete chat"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="p-2 border-t border-zinc-200/90 md:hidden">
          <Link href="/home/deals" className="text-xs text-zinc-600 underline">
            Deals
          </Link>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <AgentChat
          variant="full"
          dealId={
            activeThreadId
              ? threads.find((t) => t.id === activeThreadId)?.deal_id ?? null
              : dealFromUrl
          }
          activeThreadId={activeThreadId}
          onThreadResolved={(id) => {
            router.replace(`/home/chat?thread=${encodeURIComponent(id)}`);
            void refreshThreads();
          }}
          onNewChat={newChat}
        />
      </div>
    </div>
  );
}
