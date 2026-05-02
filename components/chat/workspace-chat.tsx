"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, ExternalLink, FileText, Loader2, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type DealOption = { id: string; name: string };

type ChatAction =
  | {
      type: "open_document";
      label: string;
      href: string;
      documentId: string;
      filename: string;
    }
  | {
      type: "open_link";
      label: string;
      href: string;
      detail?: string;
    }
  | {
      type: "propose_generate_document";
      label: string;
      prompt: string;
      dealId: string | null;
      dealName: string | null;
      typeId: string;
      typeName: string;
      outputFormat: string;
      skipResearch?: boolean;
    }
  | {
      type: "propose_research";
      label: string;
      focus: string;
      dealIds: string[];
      dealNames: string[];
    }
  | {
      type: "propose_record_update";
      label: string;
      dealId: string;
      dealName: string;
      updates: Array<{ target: string; value: string }>;
    }
  | {
      type: "record_update";
      label: string;
      detail: string;
    };

type ChatCitation = {
  label: string;
  href?: string;
  snippet: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
  citations?: ChatCitation[];
};

type PreflightResearchStep = {
  task?: string;
  sourceHint?: string;
  reason?: string;
};

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function WorkspaceChat({ deals }: { deals: DealOption[] }) {
  const [dealId, setDealId] = useState<string>("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Ask about a company, saved documents, diligence facts, or tell me to update a record. Choose a company to keep me focused, or leave it workspace-wide.",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedDeal = useMemo(() => deals.find((d) => d.id === dealId) ?? null, [deals, dealId]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const userMsg: ChatMessage = { id: newId(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    try {
      const history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, dealId: dealId || null, history }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        actions?: ChatAction[];
        citations?: ChatCitation[];
        dealId?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Chat failed");
      if (data.dealId && !dealId) setDealId(data.dealId);
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          content: data.message || "I could not produce a response.",
          actions: data.actions ?? [],
          citations: data.citations ?? [],
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          content: e instanceof Error ? e.message : "Chat failed.",
        },
      ]);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function runAction(action: ChatAction, key: string) {
    if (busyAction) return;
    setBusyAction(key);
    try {
      if (action.type === "propose_generate_document") {
        const res = await fetch("/api/document-generation/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dealId: action.dealId,
            typeId: action.typeId,
            prompt: action.prompt,
            skipResearch: Boolean(action.skipResearch),
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | {
              draft?: { id: string; title?: string };
              preflight?: { researchSteps?: PreflightResearchStep[]; missingInfo?: unknown[]; rationale?: string };
              needsResearch?: boolean;
              error?: string;
            }
          | null;
        if (res.status === 409 && json?.needsResearch) {
          const steps = json.preflight?.researchSteps ?? [];
          const stepLines = steps
            .map((s) => {
              const task = typeof s.task === "string" ? s.task : "";
              const source = typeof s.sourceHint === "string" && s.sourceHint ? ` (${s.sourceHint})` : "";
              const reason = typeof s.reason === "string" && s.reason ? ` - ${s.reason}` : "";
              return task ? `- ${task}${source}${reason}` : "";
            })
            .filter(Boolean);
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              role: "assistant",
              content:
                `I checked the available info and this document may need more research first.${json.preflight?.rationale ? `\n\n${json.preflight.rationale}` : ""}` +
                (stepLines.length ? `\n\nSuggested research:\n${stepLines.join("\n")}` : ""),
              actions: [
                { ...action, label: `Generate ${action.typeName} anyway`, skipResearch: true },
                action.dealId
                  ? {
                      type: "propose_research",
                      label: `Run research first for ${action.dealName ?? "company"}`,
                      focus: action.prompt,
                      dealIds: [action.dealId],
                      dealNames: [action.dealName ?? "Company"],
                    }
                  : {
                      type: "open_link",
                      label: "Open document generator",
                      href: "/home/document-generator",
                      detail: "Add company context or choose research before generating.",
                    },
              ],
            },
          ]);
          return;
        }
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        const draft = json?.draft;
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "assistant",
            content: draft?.title ? `Generated "${draft.title}".` : "Generated the document.",
            actions: draft?.id
              ? [
                  {
                    type: "open_link",
                    label: "Open generated document",
                    href: `/home/generated-documents/${draft.id}`,
                  },
                  {
                    type: "open_link",
                    label: "Download file",
                    href: `/api/document-generation/drafts/${draft.id}/download`,
                  },
                ]
              : [],
          },
        ]);
      } else if (action.type === "propose_research") {
        const created: Array<{ dealName: string; href: string }> = [];
        for (let i = 0; i < action.dealIds.length; i++) {
          const dealIdForRun = action.dealIds[i]!;
          const res = await fetch("/api/research/workflows/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dealId: dealIdForRun, focus: action.focus }),
          });
          const json = (await res.json().catch(() => null)) as { error?: string } | null;
          if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
          created.push({ dealName: action.dealNames[i] ?? "Company", href: `/home/deal-intel/${dealIdForRun}/research` });
        }
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "assistant",
            content:
              created.length === 1
                ? `Generated a research plan for ${created[0]!.dealName}.`
                : `Generated ${created.length} research plans.`,
            actions: created.map((c) => ({
              type: "open_link",
              label: `Open ${c.dealName} research`,
              href: c.href,
            })),
          },
        ]);
      } else if (action.type === "propose_record_update") {
        const res = await fetch("/api/chat/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "record_update", dealId: action.dealId, updates: action.updates }),
        });
        const json = (await res.json().catch(() => null)) as { actions?: ChatAction[]; error?: string } | null;
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "assistant",
            content: `Applied ${action.updates.length} update${action.updates.length === 1 ? "" : "s"} to ${action.dealName}.`,
            actions: json?.actions ?? [],
          },
        ]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          content: e instanceof Error ? e.message : "The action failed.",
        },
      ]);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="shrink-0 border-b border-zinc-200 px-4 py-3 md:px-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-base font-semibold text-zinc-950">Workspace chat</h1>
            <p className="text-xs text-zinc-500">
              {selectedDeal ? `Focused on ${selectedDeal.name}` : "Workspace-wide until a company is selected or inferred."}
            </p>
          </div>
          <select
            value={dealId}
            onChange={(e) => setDealId(e.target.value)}
            className="crm-input h-9 max-w-full rounded-lg py-1.5 md:w-72"
          >
            <option value="">All companies</option>
            {deals.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          {messages.map((m) => (
            <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[88%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
                  m.role === "user"
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-900",
                )}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
                {m.actions?.length ? (
                  <div className="mt-3 flex flex-col gap-2 border-t border-zinc-200 pt-2">
                    {m.actions.map((a, i) => {
                      const key = `${m.id}-${a.type}-${i}`;
                      if (a.type === "open_document" || a.type === "open_link") {
                        return (
                        <a
                          key={key}
                          href={a.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {a.label}
                          {"detail" in a && a.detail ? <span className="font-normal text-zinc-500">{a.detail}</span> : null}
                        </a>
                        );
                      }
                      if (a.type === "propose_generate_document") {
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                            className="inline-flex items-center gap-2 rounded-md border border-zinc-900 bg-zinc-900 px-2 py-1 text-left text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyAction === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                            {a.label}
                            <span className="font-normal text-zinc-300">
                              {a.outputFormat.toUpperCase()}
                              {a.dealName ? ` - ${a.dealName}` : ""}
                            </span>
                          </button>
                        );
                      }
                      if (a.type === "propose_research") {
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                            className="inline-flex items-center gap-2 rounded-md border border-blue-700 bg-blue-700 px-2 py-1 text-left text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyAction === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                            {a.label}
                          </button>
                        );
                      }
                      if (a.type === "propose_record_update") {
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                            className="inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-emerald-700 px-2 py-1 text-left text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyAction === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            {a.label}
                            <span className="font-normal text-emerald-100">{a.dealName}</span>
                          </button>
                        );
                      }
                      return (
                        <div key={key} className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-900">
                          <span className="font-semibold">{a.label}:</span> {a.detail}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {m.citations?.length ? (
                  <details className="mt-3 border-t border-zinc-200 pt-2">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-500">Context used</summary>
                    <div className="mt-2 space-y-2">
                      {m.citations.slice(0, 6).map((c, i) => (
                        <div key={`${c.label}-${i}`} className="rounded-md bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600">
                          <div className="font-medium text-zinc-800">
                            {c.href ? (
                              <a className="hover:underline" href={c.href} target="_blank" rel="noreferrer">
                                {c.label}
                              </a>
                            ) : (
                              c.label
                            )}
                          </div>
                          <div className="mt-0.5 line-clamp-3">{c.snippet}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          ))}
          {busy ? (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-200 bg-zinc-50 px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-4xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask about traction, open the latest deck, or update a record..."
            className="crm-input min-h-[44px] resize-none rounded-lg bg-white"
            rows={2}
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !input.trim()}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            title="Send"
          >
            {busy ? <Sparkles className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
