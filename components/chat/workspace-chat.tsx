"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, ExternalLink, FileText, Loader2, MessageSquare, Plus, Search, Settings2, Sparkles, Trash2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectBox } from "@/components/ui/select-box";

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
      type: "propose_custom_workflow";
      label: string;
      workflowId: string;
      workflowName: string;
      dealId: string | null;
      dealName: string | null;
      input: string;
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

type SavedThread = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  dealId: string | null;
  preview: string;
};

type ChatToolPermissions = {
  generateDocuments: boolean;
  runResearch: boolean;
  editRecords: boolean;
  createCompanies: boolean;
  useSimilarCompanySearch: boolean;
  useCriteriaAnalysis: boolean;
  runWorkflows: boolean;
};

const DEFAULT_TOOL_PERMISSIONS: ChatToolPermissions = {
  generateDocuments: true,
  runResearch: true,
  editRecords: true,
  createCompanies: true,
  useSimilarCompanySearch: true,
  useCriteriaAnalysis: true,
  runWorkflows: true,
};

const TOOL_PERMISSION_LABELS: Array<{ key: keyof ChatToolPermissions; label: string }> = [
  { key: "generateDocuments", label: "Generate documents" },
  { key: "runResearch", label: "Run research" },
  { key: "editRecords", label: "Edit company records" },
  { key: "createCompanies", label: "Create companies" },
  { key: "useSimilarCompanySearch", label: "Use similar-company search" },
  { key: "useCriteriaAnalysis", label: "Use criteria analysis" },
  { key: "runWorkflows", label: "Run saved workflows" },
];

type PreflightResearchStep = {
  task?: string;
  sourceHint?: string;
  reason?: string;
};

type ResearchWorkflowResponse = {
  workflow?: { id: string; deal_id?: string };
  steps?: Array<{ id: string; task?: string; website?: string; status?: string }>;
  error?: string;
};

type ResearchRun = {
  id?: string;
  step_id?: string;
  run_status?: string;
  output_notes?: string | null;
  sources?: Array<{ url?: string; title?: string; snippet?: string }>;
  error_message?: string | null;
  metadata?: { task?: string; website?: string } | null;
};

type ResearchExecuteResponse = {
  ok?: boolean;
  runs?: ResearchRun[];
  message?: string;
  error?: string;
};

type WorkflowRunResponse = {
  result?: {
    runId: string;
    summary: string;
    artifacts: Array<{ kind: string; label: string; href?: string; detail?: string }>;
    stepResults: Array<{ title: string; type: string; status: string; detail: string }>;
  };
  error?: string;
};

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function relativeTime(value: string): string {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const minutes = Math.max(0, Math.floor(diff / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function compactResearchNotes(text: string): string {
  return text
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function summarizeResearchRuns(runs: ResearchRun[], stepById: Map<string, { task?: string; website?: string }>): string {
  const completed = runs.filter((run) => run.run_status === "done");
  const failed = runs.filter((run) => run.run_status === "failed");
  const summaries = completed
    .map((run) => compactResearchNotes(run.output_notes ?? ""))
    .filter(Boolean)
    .slice(0, 3);
  const stepLines = runs.slice(0, 8).map((run, index) => {
    const step = run.step_id ? stepById.get(run.step_id) : null;
    const task = run.metadata?.task || step?.task || "Research step";
    const sources = (run.sources ?? [])
      .map((s) => (s.url ? sourceHost(s.url) : ""))
      .filter(Boolean)
      .slice(0, 3);
    const suffix = sources.length ? ` Sources: ${sources.join(", ")}.` : "";
    const status = run.run_status === "done" ? "completed" : run.run_status === "failed" ? "failed" : run.run_status || "ran";
    return `${index + 1}. ${task} (${status}).${suffix}`;
  });

  return [
    completed.length
      ? `I ran ${completed.length} research step${completed.length === 1 ? "" : "s"}${failed.length ? `; ${failed.length} failed` : ""}.`
      : failed.length
        ? `I tried to run the research, but ${failed.length} step${failed.length === 1 ? "" : "s"} failed.`
        : "I created the research workflow, but there were no ready steps to run.",
    summaries.length ? `Summary:\n${summaries.join("\n\n")}` : "",
    stepLines.length ? `Steps run:\n${stepLines.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export function WorkspaceChat({ deals, initialThreads }: { deals: DealOption[]; initialThreads: SavedThread[] }) {
  const [dealId, setDealId] = useState<string>("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<SavedThread[]>(initialThreads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolPermissions, setToolPermissions] = useState<ChatToolPermissions>(() => {
    if (typeof window === "undefined") return DEFAULT_TOOL_PERMISSIONS;
    const raw = window.localStorage.getItem("workspace-chat-tool-permissions");
    if (!raw) return DEFAULT_TOOL_PERMISSIONS;
    try {
      const parsed = JSON.parse(raw) as Partial<ChatToolPermissions>;
      return { ...DEFAULT_TOOL_PERMISSIONS, ...parsed };
    } catch {
      return DEFAULT_TOOL_PERMISSIONS;
    }
  });
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedDeal = useMemo(() => deals.find((d) => d.id === dealId) ?? null, [deals, dealId]);

  function setToolPermission(key: keyof ChatToolPermissions, value: boolean) {
    setToolPermissions((prev) => {
      const next = { ...prev, [key]: value };
      window.localStorage.setItem("workspace-chat-tool-permissions", JSON.stringify(next));
      return next;
    });
  }

  async function refreshThreads() {
    const res = await fetch("/api/chat/threads");
    const data = (await res.json().catch(() => ({}))) as { threads?: SavedThread[] };
    if (res.ok && Array.isArray(data.threads)) setThreads(data.threads);
  }

  async function loadThread(threadId: string) {
    if (loadingThread || threadId === activeThreadId) return;
    setLoadingThread(threadId);
    try {
      const res = await fetch(`/api/chat/threads/${threadId}`);
      const data = (await res.json().catch(() => ({}))) as {
        thread?: SavedThread;
        messages?: ChatMessage[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Failed to load chat");
      setActiveThreadId(threadId);
      setMessages(data.messages ?? []);
      setDealId(data.thread?.dealId ?? "");
    } finally {
      setLoadingThread(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function startNewChat() {
    setActiveThreadId(null);
    setMessages([]);
    setDealId("");
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function deleteThread(thread: SavedThread) {
    if (deletingThreadId) return;
    const confirmed = window.confirm(`Delete "${thread.title || "this chat"}"?`);
    if (!confirmed) return;
    setDeletingThreadId(thread.id);
    try {
      const res = await fetch(`/api/chat/threads/${thread.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to delete chat");
      setThreads((prev) => prev.filter((item) => item.id !== thread.id));
      if (activeThreadId === thread.id) {
        setActiveThreadId(null);
        setMessages([]);
        setDealId("");
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          content: e instanceof Error ? e.message : "Failed to delete chat.",
        },
      ]);
    } finally {
      setDeletingThreadId(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function saveAssistantMessage(message: ChatMessage, threadId = activeThreadId) {
    if (!threadId) return;
    await fetch(`/api/chat/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "assistant",
        content: message.content,
        dealId: dealId || null,
        actions: message.actions ?? [],
        citations: message.citations ?? [],
      }),
    }).catch(() => null);
    void refreshThreads();
  }

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
        body: JSON.stringify({ message: text, dealId: dealId || null, history, threadId: activeThreadId, permissions: toolPermissions }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        actions?: ChatAction[];
        citations?: ChatCitation[];
        dealId?: string | null;
        threadId?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Chat failed");
      if (data.dealId && !dealId) setDealId(data.dealId);
      if (data.threadId) setActiveThreadId(data.threadId);
      const threadIdForSave = data.threadId ?? activeThreadId;
      const assistantId = newId();
      const assistantActions = data.actions ?? [];
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: data.message || "I could not produce a response.",
          actions: assistantActions,
          citations: data.citations ?? [],
        },
      ]);
      void runAutoActions(assistantActions, assistantId, threadIdForSave);
      void refreshThreads();
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

  async function runAction(action: ChatAction, key: string, threadIdForSave = activeThreadId) {
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
            (() => {
              const message = {
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
              } satisfies ChatMessage;
              void saveAssistantMessage(message, threadIdForSave);
              return message;
            })(),
          ]);
          return;
        }
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        const draft = json?.draft;
        const message: ChatMessage = {
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
        };
        setMessages((prev) => [
          ...prev,
          message,
        ]);
        void saveAssistantMessage(message, threadIdForSave);
      } else if (action.type === "propose_research") {
        const created: Array<{ dealName: string; href: string; summary: string }> = [];
        for (let i = 0; i < action.dealIds.length; i++) {
          const dealIdForRun = action.dealIds[i]!;
          const res = await fetch("/api/research/workflows/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dealId: dealIdForRun, focus: action.focus }),
          });
          const json = (await res.json().catch(() => null)) as ResearchWorkflowResponse | null;
          if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
          const workflowId = json?.workflow?.id;
          const stepById = new Map((json?.steps ?? []).map((step) => [step.id, step]));
          const allRuns: ResearchRun[] = [];
          if (workflowId) {
            for (let attempt = 0; attempt < 5; attempt++) {
              const execRes = await fetch(`/api/research/workflows/${workflowId}/execute`, { method: "POST" });
              const execJson = (await execRes.json().catch(() => null)) as ResearchExecuteResponse | null;
              if (!execRes.ok) throw new Error(execJson?.error || `Failed to run research (${execRes.status})`);
              const runs = execJson?.runs ?? [];
              allRuns.push(...runs);
              if (!runs.length) break;
              if (runs.length < 8) break;
            }
          }
          created.push({
            dealName: action.dealNames[i] ?? "Company",
            href: `/home/deal-intel/${dealIdForRun}/research`,
            summary: summarizeResearchRuns(allRuns, stepById),
          });
        }
        const message: ChatMessage = {
          id: newId(),
          role: "assistant",
          content:
            created.length === 1
              ? `Finished research for ${created[0]!.dealName}.\n\n${created[0]!.summary}`
              : `Finished research for ${created.length} companies.\n\n${created.map((c) => `${c.dealName}:\n${c.summary}`).join("\n\n")}`,
          actions: created.map((c) => ({
            type: "open_link",
            label: `Open ${c.dealName} research results`,
            href: c.href,
          })),
        };
        setMessages((prev) => [
          ...prev,
          message,
        ]);
        void saveAssistantMessage(message, threadIdForSave);
      } else if (action.type === "propose_record_update") {
        const res = await fetch("/api/chat/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "record_update", dealId: action.dealId, updates: action.updates }),
        });
        const json = (await res.json().catch(() => null)) as { actions?: ChatAction[]; error?: string } | null;
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        const message: ChatMessage = {
            id: newId(),
            role: "assistant",
            content: `Applied ${action.updates.length} update${action.updates.length === 1 ? "" : "s"} to ${action.dealName}.`,
            actions: json?.actions ?? [],
        };
        setMessages((prev) => [...prev, message]);
        void saveAssistantMessage(message, threadIdForSave);
      } else if (action.type === "propose_custom_workflow") {
        const res = await fetch(`/api/workflows/${action.workflowId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealId: action.dealId, input: action.input }),
        });
        const json = (await res.json().catch(() => null)) as WorkflowRunResponse | null;
        if (!res.ok || !json?.result) throw new Error(json?.error || `Failed (${res.status})`);
        const stepLines = json.result.stepResults
          .map((step, index) => `${index + 1}. ${step.title} (${step.status}): ${compactResearchNotes(step.detail)}`)
          .join("\n");
        const message: ChatMessage = {
          id: newId(),
          role: "assistant",
          content: [
            `Finished ${action.workflowName}${action.dealName ? ` for ${action.dealName}` : ""}.`,
            json.result.summary ? `Summary:\n${json.result.summary}` : "",
            stepLines ? `Steps run:\n${stepLines}` : "",
          ].filter(Boolean).join("\n\n"),
          actions: json.result.artifacts
            .filter((artifact) => artifact.href)
            .map((artifact) => ({
              type: "open_link",
              label: artifact.label,
              href: artifact.href!,
              detail: artifact.detail,
            })),
        };
        setMessages((prev) => [...prev, message]);
        void saveAssistantMessage(message, threadIdForSave);
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

  async function runAutoActions(actions: ChatAction[], messageId: string, threadIdForSave = activeThreadId) {
    const runnable = actions.filter(
      (action) =>
        (action.type === "propose_generate_document" && toolPermissions.generateDocuments) ||
        (action.type === "propose_research" && toolPermissions.runResearch) ||
        (action.type === "propose_record_update" && toolPermissions.editRecords) ||
        (action.type === "propose_custom_workflow" && toolPermissions.runWorkflows),
    );
    for (const [i, action] of runnable.entries()) {
      await runAction(action, `${messageId}-${action.type}-${i}`, threadIdForSave);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 bg-white">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/70 md:flex">
        <div className="border-b border-zinc-200 p-3">
          <button
            type="button"
            onClick={startNewChat}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-800"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Saved chats</div>
          {threads.length ? (
            <div className="space-y-1">
              {threads.map((thread) => {
                const active = thread.id === activeThreadId;
                return (
                  <div
                    key={thread.id}
                    className={cn(
                      "group flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors",
                      active ? "bg-white text-zinc-950 shadow-sm ring-1 ring-zinc-200" : "text-zinc-700 hover:bg-white/80",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void loadThread(thread.id)}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      <MessageSquare className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-zinc-900" : "text-zinc-400")} />
                      <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold">{thread.title || "New chat"}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{thread.preview || "No messages yet"}</span>
                      </span>
                    </button>
                    <span className="mt-0.5 flex shrink-0 items-center gap-1">
                      <span className="text-[10px] text-zinc-400">{relativeTime(thread.updated_at)}</span>
                      <button
                        type="button"
                        onClick={() => void deleteThread(thread)}
                        disabled={deletingThreadId === thread.id}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50 group-hover:opacity-100 group-focus-within:opacity-100"
                        title="Delete chat"
                        aria-label={`Delete ${thread.title || "chat"}`}
                      >
                        {deletingThreadId === thread.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-3 py-6 text-center text-xs text-zinc-500">
              Chats you start will appear here.
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-zinc-100 bg-white px-4 py-3 md:px-5">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-950">Workspace chat</h1>
              <p className="text-xs text-zinc-500">
                {selectedDeal ? `Focused on ${selectedDeal.name}` : activeThreadId ? "Saved chat" : "New workspace-wide chat"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startNewChat}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50 md:hidden"
              >
                <Plus className="h-4 w-4" />
                New
              </button>
              <SelectBox
                value={dealId}
                onChange={(e) => setDealId(e.target.value)}
                wrapperClassName="w-56 md:w-72"
                className="h-10 max-w-full py-2"
              >
                <option value="">All companies</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </SelectBox>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((v) => !v)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                  title="Chat tool settings"
                >
                  <Settings2 className="h-4 w-4" />
                </button>
                {settingsOpen ? (
                  <div className="absolute right-0 z-20 mt-2 w-72 rounded-2xl border border-zinc-200 bg-white p-2 shadow-xl">
                    <div className="px-2 pb-2 pt-1">
                      <p className="text-xs font-semibold text-zinc-950">Chat tool permissions</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">Turn off anything chat should not run automatically.</p>
                    </div>
                    <div className="space-y-1">
                      {TOOL_PERMISSION_LABELS.map((item) => (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-2 text-xs text-zinc-700 hover:bg-zinc-50"
                        >
                          <span>{item.label}</span>
                          <input
                            type="checkbox"
                            checked={toolPermissions[item.key]}
                            onChange={(e) => setToolPermission(item.key, e.target.checked)}
                            className="h-4 w-4 rounded border-zinc-300 text-zinc-900"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {loadingThread ? (
              <div className="flex justify-center py-10 text-sm text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading chat
              </div>
            ) : null}
            {!loadingThread && messages.length === 0 ? (
              <div className="mx-auto flex min-h-[44svh] max-w-xl flex-col items-center justify-center text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-100">
                  <MessageSquare className="h-5 w-5 text-zinc-600" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-zinc-950">Start a workspace chat</h2>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                  Ask about companies, documents, diligence facts, or request a tool action. The conversation will be saved automatically.
                </p>
              </div>
            ) : null}
            {messages.map((m) => (
            <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[88%] px-4 py-3 text-sm leading-relaxed",
                  m.role === "user"
                    ? "rounded-3xl bg-zinc-100 text-zinc-950"
                    : "text-zinc-900",
                )}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
                {m.actions?.length ? (
                  <div className="mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3">
                    {m.actions.map((a, i) => {
                      const key = `${m.id}-${a.type}-${i}`;
                      if (a.type === "open_document" || a.type === "open_link") {
                        return (
                        <a
                          key={key}
                          href={a.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
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
                            className="inline-flex items-center gap-2 rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
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
                            className="inline-flex items-center gap-2 rounded-full border border-blue-700 bg-blue-700 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyAction === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                            {a.label}
                          </button>
                        );
                      }
                      if (a.type === "propose_custom_workflow") {
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                            className="inline-flex items-center gap-2 rounded-full border border-violet-700 bg-violet-700 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyAction === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Workflow className="h-3.5 w-3.5" />}
                            {a.label}
                            {a.dealName ? <span className="font-normal text-violet-100">{a.dealName}</span> : null}
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
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-700 bg-emerald-700 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {busyAction === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            {a.label}
                            <span className="font-normal text-emerald-100">{a.dealName}</span>
                          </button>
                        );
                      }
                      return (
                        <div key={key} className="rounded-2xl bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
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
                        <div key={`${c.label}-${i}`} className="rounded-2xl bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
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
                <div className="inline-flex items-center gap-2 rounded-3xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Thinking
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 bg-white px-4 pb-4 pt-3 md:px-6">
          <div className="mx-auto max-w-3xl rounded-[28px] border border-zinc-200 bg-white p-2 shadow-sm">
            <div className="flex items-end gap-2">
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
                className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
                rows={2}
              />
              <button
                type="button"
                onClick={send}
                disabled={busy || !input.trim()}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                title="Send"
              >
                {busy ? <Sparkles className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
