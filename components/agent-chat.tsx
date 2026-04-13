"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Paperclip, Sparkles } from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string; dealId?: string };

function dealIdFromMessageContent(content: string): string | undefined {
  const m = content.match(/\/home\/deal\/([a-f0-9-]{36})/i);
  return m?.[1];
}

export function AgentChat({
  dealId,
  dealName,
  variant = "full",
  activeThreadId,
  onThreadResolved,
  onNewChat,
}: {
  dealId?: string | null;
  dealName?: string;
  variant?: "full" | "embedded";
  /** From URL: hydrate messages when user picks a thread */
  activeThreadId?: string | null;
  onThreadResolved?: (threadId: string) => void;
  onNewChat?: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  /** Live streamed markdown for ordered deep-research sections (when no thread, shown until folded into messages). */
  const [deepResearchMd, setDeepResearchMd] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, steps, loading, pdfLoading, deepResearchMd]);

  useEffect(() => {
    if (variant === "embedded") return;
    const tid = activeThreadId ?? null;
    if (!tid) {
      setMessages([]);
      setThreadId(null);
      return;
    }
    setThreadId(tid);
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/chat/threads/${tid}/messages`);
      const data = await res.json().catch(() => ({}));
      if (cancelled || !res.ok) return;
      const rows = (data as { messages?: { role: string; content: string }[] }).messages ?? [];
      setMessages(
        rows
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, variant]);

  function onPickPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setPendingPdf(f);
    }
    e.target.value = "";
  }

  async function runDeepResearchPipeline() {
    if (!pendingPdf) return;
    const file = pendingPdf;
    const tidForUpload = threadId ?? activeThreadId ?? null;
    setPdfLoading(true);
    setDeepResearchMd("");
    if (!tidForUpload) {
      setMessages((m) => [...m, { role: "user", content: `Deep research — PDF: ${file.name}` }]);
    }
    setPendingPdf(null);

    const reloadMessages = async () => {
      const tid = threadId ?? activeThreadId;
      if (!tid || variant === "embedded") return;
      const res = await fetch(`/api/chat/threads/${tid}/messages`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const rows = (data as { messages?: { role: string; content: string }[] }).messages ?? [];
      setMessages(
        rows
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      );
    };

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (tidForUpload) formData.append("threadId", tidForUpload);
      formData.append("fileName", file.name);
      const res = await fetch("/api/pitch-decks/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = (data as { error?: string }).error || "Upload failed.";
        setMessages((m) => [...m, { role: "assistant", content: err }]);
        setDeepResearchMd("");
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setMessages((m) => [...m, { role: "assistant", content: "Streaming not supported." }]);
        setDeepResearchMd("");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let doneDealId: string | null = null;
      let sectionAcc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          const t = msg.type as string | undefined;
          if (t === "sections_begin") {
            sectionAcc = "";
            setDeepResearchMd("");
          }
          if (t === "section_start" && typeof msg.title === "string") {
            sectionAcc += `\n\n## ${String(msg.title)}\n\n`;
            setDeepResearchMd(sectionAcc);
          }
          if (t === "section_delta" && typeof msg.text === "string") {
            sectionAcc += String(msg.text);
            setDeepResearchMd(sectionAcc);
          }
          if (t === "done" && typeof msg.dealId === "string") {
            doneDealId = msg.dealId as string;
          }
          if (t === "error") {
            const em = typeof msg.message === "string" ? msg.message : "Pipeline error.";
            setMessages((m) => [...m, { role: "assistant", content: em }]);
            setDeepResearchMd("");
            return;
          }
        }
      }

      if (doneDealId) {
        if (tidForUpload) {
          setDeepResearchMd("");
          await reloadMessages();
        } else {
          const body =
            sectionAcc.trim().length > 0
              ? `${sectionAcc}\n\n---\nDeep research complete.\n/home/deal/${doneDealId}`
              : `Deep research finished.\n/home/deal/${doneDealId}`;
          setMessages((m) => [...m, { role: "assistant", content: body, dealId: doneDealId }]);
          setDeepResearchMd("");
        }
      } else {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "Pipeline finished without a deal id." },
        ]);
        setDeepResearchMd("");
      }
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Upload request failed." }]);
      setDeepResearchMd("");
    } finally {
      setPdfLoading(false);
    }
  }

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput("");
    setSteps([]);
    setLoading(true);
    setMessages((m) => [...m, { role: "user", content: msg }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId: dealId ?? null,
          threadId: threadId ?? activeThreadId ?? null,
          message: msg,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const err = (j as { error?: string }).error || "Request failed.";
        setMessages((m) => {
          const n = [...m];
          if (n.length && n[n.length - 1]?.role === "assistant") n[n.length - 1] = { role: "assistant", content: err };
          return n;
        });
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        setMessages((m) => {
          const n = [...m];
          if (n.length && n[n.length - 1]?.role === "assistant")
            n[n.length - 1] = { role: "assistant", content: "No stream." };
          return n;
        });
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(t) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (ev.type === "thread" && typeof ev.threadId === "string") {
            const id = ev.threadId as string;
            setThreadId(id);
            onThreadResolved?.(id);
          }
          if (ev.type === "step") {
            setSteps((s) => [...s, `${String(ev.label ?? "")}: ${String(ev.detail ?? "")}`]);
          }
          if (ev.type === "delta" && typeof ev.text === "string") {
            acc += ev.text as string;
            setMessages((m) => {
              const n = [...m];
              const last = n[n.length - 1];
              if (last?.role === "assistant") n[n.length - 1] = { role: "assistant", content: acc };
              return n;
            });
          }
          if (ev.type === "replace" && typeof ev.text === "string") {
            acc = ev.text as string;
            setMessages((m) => {
              const n = [...m];
              const last = n[n.length - 1];
              if (last?.role === "assistant") n[n.length - 1] = { role: "assistant", content: acc };
              return n;
            });
          }
          if (ev.type === "error") {
            const em = (ev.message as string) || "Error";
            setMessages((m) => {
              const n = [...m];
              if (n.length && n[n.length - 1]?.role === "assistant") n[n.length - 1] = { role: "assistant", content: em };
              return n;
            });
          }
        }
      }
    } finally {
      setLoading(false);
    }
  }

  const shell =
    variant === "full"
      ? "flex flex-col flex-1 min-h-0 h-full bg-white"
      : "flex flex-col h-[min(32rem,calc(100vh-14rem))] min-h-[22rem] rounded-2xl border border-zinc-200/90 bg-zinc-50/40 shadow-sm overflow-hidden";

  const title = dealName ? `Diligence · ${dealName}` : "Chat";

  return (
    <div className={shell}>
      <div className="shrink-0 border-b border-zinc-200/80 bg-white/90 px-4 py-3 md:px-5 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-zinc-900">{title}</h2>
          <p className="text-xs text-zinc-600 mt-0.5 leading-relaxed max-w-xl">
            {dealName
              ? "Grounded on this deal’s indexed context and your fund rules."
              : "Ask about your corpus. Attach a PDF, then run Deep research to analyze a deck. Ordinary messages route automatically."}
          </p>
        </div>
        {variant === "full" && onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="text-xs font-medium text-zinc-600 hover:text-zinc-900 shrink-0"
          >
            New chat
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto w-full px-3 py-4 md:px-5 space-y-4">
          {messages.length === 0 && (
            <p className="text-sm text-zinc-600 text-center py-8 px-4 leading-relaxed">
              Start a conversation, or attach a PDF and press <strong className="font-medium text-zinc-800">Deep research</strong>{" "}
              to run the full deck pipeline.
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  m.role === "user"
                    ? "max-w-[88%] rounded-2xl rounded-br-md bg-zinc-900 text-white px-4 py-2.5 text-[15px] leading-relaxed shadow-sm"
                    : "max-w-[92%] rounded-2xl rounded-bl-md bg-white text-zinc-800 px-4 py-2.5 text-[15px] leading-relaxed border border-zinc-200/90 shadow-sm"
                }
              >
                {m.content ? (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                ) : m.role === "assistant" && loading ? (
                  <span className="inline-flex gap-1 text-zinc-500 text-sm">
                    <span className="animate-pulse">Thinking</span>
                    <span className="animate-pulse delay-75">·</span>
                    <span className="animate-pulse delay-150">·</span>
                    <span className="animate-pulse delay-200">·</span>
                  </span>
                ) : null}
                {m.role === "assistant" && (m.dealId || dealIdFromMessageContent(m.content)) && (
                  <div className="mt-3">
                    <Link
                      href={`/home/deal/${m.dealId ?? dealIdFromMessageContent(m.content)}`}
                      className="inline-flex text-sm font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2"
                    >
                      Open deal page →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          ))}
          {pdfLoading && deepResearchMd.length === 0 && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 px-3 py-2.5">
              <p className="text-xs text-zinc-600 leading-relaxed">
                <span className="font-medium text-zinc-800">Analyzing deck</span>
                <span className="inline-flex gap-1 ml-1 text-zinc-500">
                  <span className="animate-pulse">·</span>
                  <span className="animate-pulse delay-75">·</span>
                  <span className="animate-pulse delay-150">·</span>
                </span>
              </p>
              <p className="text-[11px] text-zinc-500 mt-1">Sections will stream here when ready.</p>
            </div>
          )}
          {deepResearchMd.length > 0 && (
            <div className="rounded-xl border border-violet-200/90 bg-violet-50/35 px-3 py-2.5">
              <p className="text-xs font-medium text-violet-900 mb-1.5">Deep research</p>
              <div className="text-[13px] whitespace-pre-wrap text-zinc-800 leading-relaxed">{deepResearchMd}</div>
            </div>
          )}
          {steps.length > 0 && (
            <div className="border-t border-zinc-100 pt-2">
              <button
                type="button"
                onClick={() => setStepsOpen((v) => !v)}
                className="text-[11px] text-zinc-500 hover:text-zinc-700"
              >
                {stepsOpen ? "Hide" : "Show"} retrieval details ({steps.length})
              </button>
              {stepsOpen && (
                <div className="text-[11px] text-zinc-500 px-1 space-y-0.5 font-mono mt-1">
                  {steps.map((s, i) => (
                    <div key={i}>{s}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={onPickPdf}
      />

      <div className="shrink-0 border-t border-zinc-200/80 bg-zinc-50/95 backdrop-blur-md px-3 py-3 md:px-5">
        <div className="max-w-2xl mx-auto w-full space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pdfLoading || loading}
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:opacity-40"
            >
              <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Attach PDF
            </button>
            {pendingPdf && (
              <span className="text-xs text-zinc-600 truncate max-w-[140px]" title={pendingPdf.name}>
                {pendingPdf.name}
              </span>
            )}
            <button
              type="button"
              disabled={loading || pdfLoading || !pendingPdf}
              onClick={() => void runDeepResearchPipeline()}
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-40 disabled:bg-zinc-300 disabled:border-zinc-300"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Deep research
            </button>
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Message…"
              rows={variant === "full" ? 2 : 2}
              disabled={loading || pdfLoading}
              className="flex-1 resize-none rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 text-[15px] text-zinc-900 placeholder:text-zinc-400 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-300 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={loading || pdfLoading || !input.trim()}
              className="shrink-0 rounded-full bg-zinc-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900 transition-colors min-w-[5.5rem]"
            >
              {loading ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
