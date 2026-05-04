"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, Circle, ExternalLink, FileText, Loader2, MessageSquare, Plus, Settings2, Sparkles, Trash2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectBox } from "@/components/ui/select-box";
import { stripMarkdownText } from "@/lib/plain-text";

type DealOption = { id: string; name: string };

type MatrixColumnDraft = {
  label: string;
  description?: string;
  dataType?: "text" | "number" | "percent" | "currency" | "boolean" | "json";
  prompt: string;
  researchEnabled?: boolean;
};

type ChatAction =
  | {
      type: "tool_call";
      label: string;
      tool:
        | "task_router"
        | "workspace_retrieval"
        | "quick_lookup"
        | "similar_company_search"
        | "criteria_analysis"
        | "research"
        | "document_generation"
        | "workflow"
        | "record_update";
      status: "queued" | "running" | "completed" | "failed";
      detail?: string;
      href?: string;
    }
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
      typeId: string | null;
      typeName: string;
      outputFormat: string;
      skipResearch?: boolean;
    }
  | {
      type: "propose_research";
      label: string;
      focus: string;
      userPrompt?: string;
      dealIds: string[];
      dealNames: string[];
    }
  | {
      type: "propose_matrix_fill";
      label: string;
      dealIds: string[];
      dealNames: string[];
      columnIds: string[];
      columnLabels: string[];
      columnsToCreate?: MatrixColumnDraft[];
    }
  | {
      type: "matrix_preview";
      label: string;
      href: string;
      detail?: string;
      columns: Array<{ id: string; label: string }>;
      rows: Array<{
        dealId: string;
        dealName: string;
        values: Array<{ columnId: string; columnLabel: string; value: string; status?: string }>;
      }>;
    }
  | {
      type: "document_preview";
      label: string;
      title: string;
      href: string;
      downloadHref?: string;
	      format?: string;
	      dealName?: string | null;
	      excerpt?: string;
	      content?: string;
	      streaming?: boolean;
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
  useMatrix: boolean;
};

const DEFAULT_TOOL_PERMISSIONS: ChatToolPermissions = {
  generateDocuments: true,
  runResearch: true,
  editRecords: true,
  createCompanies: true,
  useSimilarCompanySearch: true,
  useCriteriaAnalysis: true,
  runWorkflows: true,
  useMatrix: true,
};

const TOOL_PERMISSION_LABELS: Array<{ key: keyof ChatToolPermissions; label: string }> = [
  { key: "generateDocuments", label: "Generate documents" },
  { key: "runResearch", label: "Run research" },
  { key: "editRecords", label: "Edit company records" },
  { key: "createCompanies", label: "Create companies" },
  { key: "useSimilarCompanySearch", label: "Use similar-company search" },
  { key: "useCriteriaAnalysis", label: "Use criteria analysis" },
  { key: "runWorkflows", label: "Run saved workflows" },
  { key: "useMatrix", label: "Use matrix" },
];

type PreflightResearchStep = {
  task?: string;
  sourceHint?: string;
  reason?: string;
};

type ResearchWorkflowResponse = {
  workflow?: { id: string; deal_id?: string; metadata?: Record<string, unknown> | null };
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
  run?: ResearchRun;
  runs?: ResearchRun[];
  createdFollowUpSteps?: Array<{ id: string; task?: string; website?: string; status?: string }>;
  message?: string;
  error?: string;
};

type WorkflowRunResponse = {
  run?: {
    id: string;
    status: string;
    workflowName?: string | null;
    dealName?: string | null;
    summary?: string;
  };
  result?: {
    runId: string;
    summary: string;
    artifacts: Array<{ kind: string; label: string; href?: string; detail?: string }>;
    stepResults: Array<{ title: string; type: string; status: string; detail: string }>;
  };
  error?: string;
};

type MatrixFillResponse = {
  cells?: Array<{ id?: string; deal_id?: string; column_id?: string; status?: string; value_text?: string | null }>;
  errors?: Array<{ error?: string }>;
  error?: string;
};

type MatrixColumnResponse = {
  column?: { id: string; label: string };
  error?: string;
};

type DocumentDraftResponse = {
  draft?: {
    id: string;
    title?: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  preflight?: { researchSteps?: PreflightResearchStep[]; missingInfo?: unknown[]; rationale?: string };
  needsResearch?: boolean;
  error?: string;
};

type DocumentStreamEvent =
  | { type: "start"; title?: string }
  | { type: "delta"; text?: string }
  | { type: "needs_research"; preflight?: { researchSteps?: PreflightResearchStep[]; missingInfo?: unknown[]; rationale?: string } }
  | {
      type: "done";
      draft?: {
        id: string;
        title?: string;
        content?: string | null;
        metadata?: Record<string, unknown> | null;
      };
    }
  | { type: "error"; error?: string };

type TextStreamEvent =
  | { type: "start" }
  | { type: "delta"; text?: string }
  | { type: "done"; answer?: string }
  | { type: "error"; error?: string };

type ChatStreamEvent =
  | { type: "start"; threadId?: string }
  | { type: "delta"; text?: string }
  | {
      type: "done";
      result?: {
        message?: string;
        actions?: ChatAction[];
        citations?: ChatCitation[];
        dealId?: string | null;
        threadId?: string;
      };
    }
  | { type: "error"; error?: string };

type ToolRunState = {
  status: "running" | "done" | "error";
  label: string;
  detail?: string;
};

type ResearchTraceStep = {
  key: string;
  dealName: string;
  task: string;
  website?: string;
  status: "queued" | "running" | "done" | "failed";
  sources?: Array<{ url?: string; title?: string; snippet?: string }>;
  detail?: string;
  expanded?: boolean;
  kind?: "internal_db" | "web";
};

type ResearchTraceState = {
  title: string;
  status: "queued" | "running" | "done" | "failed";
  steps: ResearchTraceStep[];
  links: Array<{ label: string; href: string }>;
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
  return plainChatText(text)
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function plainChatText(text: string): string {
  return stripMarkdownText(String(text || ""))
    .replace(/^I could not produce a response\.\s*/i, "")
    .replace(/\bI am creating research plans for ([^.\n,]+), ([^.\n]+)\./g, "I'm starting research for $1 and $2.")
    .replace(/\bI am creating a research plan for ([^.\n]+)\./g, "I'm starting research for $1.")
    .trim();
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "company";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function summarizeResearchRuns(runs: ResearchRun[]): string {
  const completed = runs.filter((run) => run.run_status === "done");
  const failed = runs.filter((run) => run.run_status === "failed");
  const summaries = completed
    .map((run) => plainChatText(run.output_notes ?? "").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .slice(0, 6);

  if (summaries.length) return summaries.join("\n\n");
  if (failed.length) return "Some research could not be completed. The available evidence was saved to the research page.";
  return "The research is complete. The available evidence was saved to the research page.";
}

function composeResearchAnswer(created: Array<{ dealName: string; summary: string }>): string {
  const sections = created
    .map((item) => {
      const summary = plainChatText(item.summary)
        .replace(/^I (?:ran|tried to run|created)[^\n]*(?:\n\n)?/i, "")
        .replace(/^Summary:\s*/i, "")
        .replace(/\n{1,2}Steps run:[\s\S]*$/i, "")
        .replace(/^Steps run:[\s\S]*$/i, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!summary) return "";
      return created.length > 1 ? `${item.dealName}\n${summary}` : summary;
    })
    .filter(Boolean);
  return sections.length ? sections.join("\n\n") : "The research is complete. I saved the evidence to the company research page.";
}

function toolCallTone(status: "queued" | "running" | "completed" | "failed" | "done" | "error"): string {
  if (status === "failed" || status === "error") return "border-rose-200 bg-white text-zinc-900";
  return "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50";
}

function toolStatusTextTone(status?: ToolRunState["status"] | "queued"): string {
  if (status === "error") return "text-rose-600";
  if (status === "running") return "text-zinc-950";
  return "text-zinc-950";
}

function isProposalAction(action: ChatAction): boolean {
  return (
    action.type === "propose_generate_document" ||
    action.type === "propose_research" ||
    action.type === "propose_matrix_fill" ||
    action.type === "propose_record_update" ||
    action.type === "propose_custom_workflow"
  );
}

function isRunnableAction(action: ChatAction, permissions: ChatToolPermissions): boolean {
  return (
    (action.type === "propose_generate_document" && permissions.generateDocuments) ||
    (action.type === "propose_research" && permissions.runResearch) ||
    (action.type === "propose_record_update" && permissions.editRecords) ||
    (action.type === "propose_custom_workflow" && permissions.runWorkflows) ||
    (action.type === "propose_matrix_fill" && permissions.useMatrix)
  );
}

function ToolActionButton({
  label,
  detail,
  status,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  detail?: string | null;
  status: "queued" | "running" | "done" | "error";
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  const isRunning = status === "running";
  const isDone = status === "done";
  const isError = status === "error";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full max-w-full items-start gap-2 px-1 py-1.5 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 md:w-[760px]",
        toolCallTone(isError ? "error" : isRunning ? "running" : "queued"),
      )}
    >
      {isRunning ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-zinc-950" />
      ) : isDone ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-zinc-950" />
      ) : (
        icon
      )}
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {detail ? <span className={cn("mt-0.5 block truncate text-xs font-normal", toolStatusTextTone(status))}>{detail}</span> : null}
      </span>
    </button>
  );
}

function stripStaleProposalActions(actions?: ChatAction[]): ChatAction[] | undefined {
  const kept = (actions ?? []).filter((action) => !isProposalAction(action));
  return kept.length ? kept : undefined;
}

function documentFormatFromMetadata(metadata: Record<string, unknown> | null | undefined, fallback: string): string {
  const value = metadata && typeof metadata.output_format === "string" ? metadata.output_format : fallback;
  return value || "document";
}

function ResearchTracePanel({
  action,
  trace,
  actionKey,
  busyAction,
  onRun,
  onToggleStep,
}: {
  action: Extract<ChatAction, { type: "propose_research" }>;
  trace?: ResearchTraceState;
  actionKey: string;
  busyAction: string | null;
  onRun: (action: Extract<ChatAction, { type: "propose_research" }>, key: string) => void;
  onToggleStep: (key: string, stepKey: string) => void;
}) {
  const running = busyAction === actionKey || trace?.status === "running";
  const failed = trace?.status === "failed";
  const done = trace?.status === "done";
  if (done) return null;
  const rows = trace?.steps.length
    ? trace.steps
    : [
        {
          key: `${actionKey}:planning`,
          dealName: listNames(action.dealNames),
          task: "Preparing focused research plan",
          status: running ? "running" : "queued",
          detail: `${action.dealNames.length} compan${action.dealNames.length === 1 ? "y" : "ies"}`,
        } satisfies ResearchTraceStep,
      ];
  const activeIndex = rows.findIndex((step) => step.status === "running");
  return (
    <div className="w-full max-w-full min-w-0 md:w-[760px]">
      <button
        type="button"
        onClick={() => {
          if (!done) onRun(action, actionKey);
        }}
        disabled={Boolean(busyAction) || done}
        className="flex w-full items-center justify-between gap-3 px-1 py-1.5 text-left disabled:cursor-not-allowed"
      >
        <span className="flex min-w-0 items-center">
          <span className="truncate text-sm font-medium text-zinc-900">{trace?.title ?? `Researching ${listNames(action.dealNames)}`}</span>
        </span>
        <span className="shrink-0 text-xs text-zinc-950">{failed ? "Needs attention" : running ? "Working" : "Ready"}</span>
      </button>
      <div className="mt-1 space-y-2 px-1">
        {rows.map((step, index) => {
          const stepRunning = step.status === "running";
          const stepDone = step.status === "done";
          const stepFailed = step.status === "failed";
          const collapsed = stepDone && !step.expanded && (activeIndex < 0 || index < activeIndex);
          const hosts = (step.sources ?? [])
            .map((source) => (source.url ? { host: sourceHost(source.url), url: source.url } : null))
            .filter((source): source is { host: string; url: string } => Boolean(source))
            .slice(0, 3);
          return (
            <div
              key={step.key}
              className={cn(
                "flex w-full items-start gap-2 py-1.5 text-left text-sm text-zinc-950",
              )}
            >
              <span className="mt-0.5 shrink-0">
                {stepRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-950" />
                ) : stepDone ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-zinc-950" />
                ) : stepFailed ? (
                  <Sparkles className="h-3.5 w-3.5 text-rose-600" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-zinc-950" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-zinc-900", collapsed ? "truncate" : "")}>{plainChatText(step.task)}</span>
                {!collapsed ? (
                  <span className="mt-0.5 block text-xs text-zinc-950">
                    {step.dealName ? `${step.dealName}. ` : ""}
                    {plainChatText(step.detail || (step.kind === "internal_db" ? "Searching saved records and database signals" : step.website && step.website !== "web" ? `Opening ${step.website}` : "Searching the web"))}
                  </span>
                ) : (
	                  <span className="mt-0.5 block text-xs text-zinc-950">Sources hidden</span>
                )}
                {hosts.length && !collapsed ? (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {hosts.map((source) => (
                      <a
                        key={`${step.key}:${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
	                        className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-950 hover:bg-white"
                      >
                        {source.host}
                      </a>
                    ))}
                  </span>
                ) : null}
                {stepDone ? (
                  <button
                    type="button"
                    onClick={() => onToggleStep(actionKey, step.key)}
	                    className="mt-1 text-xs font-medium text-zinc-950 hover:text-zinc-700"
                  >
                    {collapsed ? "Show sources" : "Hide sources"}
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatrixPreviewCard({ action }: { action: Extract<ChatAction, { type: "matrix_preview" }> }) {
  const columns = action.columns.length ? action.columns : [];
  const gridTemplateColumns = `minmax(132px, 0.9fr) repeat(${Math.max(columns.length, 1)}, minmax(140px, 1fr))`;
  return (
    <a
      href={action.href}
      target="_blank"
      rel="noreferrer"
      className="block w-full max-w-full rounded-2xl border border-zinc-200 bg-white p-3 text-left shadow-sm transition hover:border-zinc-300 hover:shadow-md md:w-[760px]"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-zinc-950">{action.label || "Matrix output"}</div>
          {action.detail ? <div className="mt-0.5 text-[11px] text-zinc-950">{plainChatText(action.detail)}</div> : null}
        </div>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-950" />
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-100">
        <div className="min-w-[520px] text-xs" style={{ display: "grid", gridTemplateColumns }}>
          <div className="border-b border-r border-zinc-100 bg-zinc-50 px-3 py-2 font-medium text-zinc-950">Company</div>
          {columns.map((column) => (
            <div key={column.id} className="border-b border-r border-zinc-100 bg-zinc-50 px-3 py-2 font-medium text-zinc-700 last:border-r-0">
              {column.label}
            </div>
          ))}
          {action.rows.map((row) => (
            <div key={row.dealId} className="contents">
              <div className="border-r border-t border-zinc-100 px-3 py-2 font-medium text-zinc-900">{row.dealName}</div>
              {columns.map((column) => {
                const value = row.values.find((item) => item.columnId === column.id);
                return (
                  <div key={`${row.dealId}:${column.id}`} className="border-r border-t border-zinc-100 px-3 py-2 text-zinc-700 last:border-r-0">
                    {value?.value || "Not found"}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </a>
  );
}

function DocumentPreviewCard({ action }: { action: Extract<ChatAction, { type: "document_preview" }> }) {
  const content = plainChatText(action.content || action.excerpt || "");
  const body = (
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
	            <div className="min-w-0">
	              <div className="truncate text-sm font-semibold text-zinc-950">{action.title || action.label}</div>
	              <div className="mt-0.5 text-xs text-zinc-950">
	                {[action.format ? action.format.toUpperCase() : "", action.dealName || ""].filter(Boolean).join(" / ") || "Generated document"}
	                {action.streaming ? " / Generating" : ""}
	              </div>
	            </div>
	            {action.href && action.href !== "#" ? <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-950" /> : null}
	          </div>
	          {content ? <div className="mt-3 max-h-[72vh] overflow-y-auto whitespace-pre-wrap rounded-xl border border-zinc-100 bg-white p-3 text-xs leading-relaxed text-zinc-950">{content}</div> : null}
	        </div>
	      </div>
  );
  if (action.href && action.href !== "#") {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noreferrer"
        className="block w-full max-w-full rounded-2xl border border-zinc-200 bg-white p-3 text-left shadow-sm transition hover:border-zinc-300 hover:shadow-md md:w-[760px]"
      >
        {body}
      </a>
    );
  }
  return (
    <div className="block w-full max-w-full rounded-2xl border border-zinc-200 bg-white p-3 text-left shadow-sm md:w-[760px]">
      {body}
    </div>
  );
}

export function WorkspaceChat({ deals, initialThreads }: { deals: DealOption[]; initialThreads: SavedThread[] }) {
  const [mounted, setMounted] = useState(false);
  const [dealId, setDealId] = useState<string>("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<SavedThread[]>(initialThreads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);
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
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRunState>>({});
  const [researchTraces, setResearchTraces] = useState<Record<string, ResearchTraceState>>({});
  const [autoActionKeys, setAutoActionKeys] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const restoredThreadRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const selectedDeal = useMemo(() => deals.find((d) => d.id === dealId) ?? null, [deals, dealId]);
  const savedResearchLinksByDeal = useMemo(() => {
    const links = new Map<string, { label: string; href: string }>();
    for (const message of messages) {
      for (const action of message.actions ?? []) {
        if (action.type !== "open_link") continue;
        const match = action.href.match(/^\/home\/deal-intel\/([^/]+)\/research$/);
        if (!match?.[1]) continue;
        links.set(match[1], { label: action.label, href: action.href });
      }
    }
    return links;
  }, [messages]);

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
      setMessages((data.messages ?? []).map((message) => ({
        ...message,
        content: plainChatText(message.content),
        actions: stripStaleProposalActions(message.actions),
      })));
      setDealId(data.thread?.dealId ?? "");
      setToolRuns({});
      setResearchTraces({});
      setAutoActionKeys(new Set());
    } finally {
      setLoadingThread(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  useEffect(() => {
    if (restoredThreadRef.current || typeof window === "undefined") return;
    restoredThreadRef.current = true;
    const storedThreadId = window.localStorage.getItem("workspace-chat-active-thread-id");
    if (storedThreadId) {
      void loadThread(storedThreadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThreads]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeThreadId) {
      window.localStorage.setItem("workspace-chat-active-thread-id", activeThreadId);
    }
  }, [activeThreadId]);

  function startNewChat() {
    if (typeof window !== "undefined") window.localStorage.removeItem("workspace-chat-active-thread-id");
    setActiveThreadId(null);
    setMessages([]);
    setDealId("");
    setInput("");
    setToolRuns({});
    setResearchTraces({});
    setAutoActionKeys(new Set());
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function deleteThread(thread: SavedThread) {
    if (deletingThreadId) return;
    setDeletingThreadId(thread.id);
    try {
      const res = await fetch(`/api/chat/threads/${thread.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to delete chat");
      setThreads((prev) => prev.filter((item) => item.id !== thread.id));
      if (activeThreadId === thread.id) {
        if (typeof window !== "undefined") window.localStorage.removeItem("workspace-chat-active-thread-id");
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
      setPendingDeleteThreadId(null);
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
        content: plainChatText(message.content),
        dealId: dealId || null,
        actions: message.actions ?? [],
        citations: message.citations ?? [],
      }),
    }).catch(() => null);
    void refreshThreads();
  }

  function markToolRun(key: string, state: ToolRunState) {
    setToolRuns((prev) => ({ ...prev, [key]: state }));
  }

  function setResearchTrace(key: string, updater: (trace: ResearchTraceState | null) => ResearchTraceState) {
    setResearchTraces((prev) => ({ ...prev, [key]: updater(prev[key] ?? null) }));
  }

  function updateResearchTraceStep(traceKey: string, stepKey: string, patch: Partial<ResearchTraceStep>) {
    setResearchTrace(traceKey, (trace) => {
      const current = trace ?? { title: "Researching", status: "running", steps: [], links: [] };
      return {
        ...current,
        steps: current.steps.map((step) => (step.key === stepKey ? { ...step, ...patch } : step)),
      };
    });
  }

  function toggleResearchTraceStep(traceKey: string, stepKey: string) {
    setResearchTrace(traceKey, (trace) => {
      const current = trace ?? { title: "Researching", status: "running", steps: [], links: [] };
      return {
        ...current,
        steps: current.steps.map((step) => (step.key === stepKey ? { ...step, expanded: !step.expanded } : step)),
      };
    });
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
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: text, dealId: dealId || null, history, threadId: activeThreadId, permissions: toolPermissions }),
      });
      if (res.headers.get("content-type")?.includes("text/event-stream") && res.body) {
        const assistantId = newId();
        let assistantInserted = false;
        let streamedContent = "";
        let finalResult: {
          message?: string;
          actions?: ChatAction[];
          citations?: ChatCitation[];
          dealId?: string | null;
          threadId?: string;
        } | null = null;
        const ensureAssistantMessage = () => {
          if (assistantInserted) return;
          assistantInserted = true;
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: "",
              actions: [],
              citations: [],
            },
          ]);
        };
        const updateAssistantMessage = (patch: Partial<ChatMessage>) => {
          ensureAssistantMessage();
          setMessages((prev) => prev.map((item) => (item.id === assistantId ? { ...item, ...patch } : item)));
        };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const handleEvent = (event: ChatStreamEvent) => {
          if (event.type === "start") {
            if (event.threadId) setActiveThreadId(event.threadId);
            void refreshThreads();
            return;
          }
          if (event.type === "delta") {
            streamedContent += event.text || "";
            updateAssistantMessage({ content: plainChatText(streamedContent) });
            return;
          }
          if (event.type === "done") {
            finalResult = event.result ?? {};
            if (finalResult.dealId && !dealId) setDealId(finalResult.dealId);
            if (finalResult.threadId) setActiveThreadId(finalResult.threadId);
            const assistantActions = finalResult.actions ?? [];
            const assistantContent = plainChatText(
              typeof finalResult.message === "string" && finalResult.message.trim()
                ? finalResult.message
                : streamedContent,
            );
            updateAssistantMessage({
              content: assistantContent,
              actions: assistantActions,
              citations: finalResult.citations ?? [],
            });
            const autoKeys = assistantActions
              .map((action, index) => (isRunnableAction(action, toolPermissions) ? `${assistantId}-${action.type}-${index}` : ""))
              .filter(Boolean);
            if (autoKeys.length) {
              setAutoActionKeys((prev) => {
                const next = new Set(prev);
                for (const key of autoKeys) next.add(key);
                return next;
              });
            }
            void runAutoActions(assistantActions, assistantId, finalResult.threadId ?? activeThreadId);
            return;
          }
          if (event.type === "error") throw new Error(event.error || "Chat failed");
        };
        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.split("\n").find((item) => item.startsWith("data:"));
              if (!line) continue;
              handleEvent(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
            }
          }
          if (done) break;
        }
        if (!finalResult && streamedContent) {
          updateAssistantMessage({ content: plainChatText(streamedContent) });
        }
        void refreshThreads();
        return;
      }
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
      const assistantContent = plainChatText(
        typeof data.message === "string" && data.message.trim()
          ? data.message
          : assistantActions.length || data.citations?.length
            ? ""
            : "I could not produce a response.",
      );
      const autoKeys = assistantActions
        .map((action, index) => (isRunnableAction(action, toolPermissions) ? `${assistantId}-${action.type}-${index}` : ""))
        .filter(Boolean);
      if (autoKeys.length) {
        setAutoActionKeys((prev) => {
          const next = new Set(prev);
          for (const key of autoKeys) next.add(key);
          return next;
        });
      }
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: assistantContent,
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

  async function runAction(
    action: ChatAction,
    key: string,
    threadIdForSave = activeThreadId,
    autoStarted = autoActionKeys.has(key),
    options: { suppressResearchAnswer?: boolean } = {},
  ) {
    if (busyAction) return;
    let runKey = key;
    let transientMessageId: string | null = null;
    if (autoStarted && action.type !== "propose_research") {
      transientMessageId = newId();
      runKey = `${transientMessageId}-${action.type}-0`;
      setAutoActionKeys((prev) => new Set(prev).add(runKey));
      setMessages((prev) => [
        ...prev,
        {
          id: transientMessageId!,
          role: "assistant",
          content: "",
          actions: [action],
        },
      ]);
    }
    const clearTransientMessage = () => {
      if (!transientMessageId) return;
      const id = transientMessageId;
      transientMessageId = null;
      setMessages((prev) => prev.filter((message) => message.id !== id));
    };
    setBusyAction(runKey);
    markToolRun(runKey, { status: "running", label: action.label, detail: "Running" });
    try {
      if (action.type === "propose_generate_document") {
        const previewMessageId = transientMessageId ?? newId();
        let previewAction: Extract<ChatAction, { type: "document_preview" }> = {
          type: "document_preview",
          label: "Generating document",
          title: `${action.typeName} draft`,
          href: "#",
          format: action.outputFormat,
          dealName: action.dealName,
          content: "",
          streaming: true,
        };
        const replacePreviewMessage = (nextAction: Extract<ChatAction, { type: "document_preview" }>) => {
          previewAction = nextAction;
          const nextMessage: ChatMessage = {
            id: previewMessageId,
            role: "assistant",
            content: "",
            actions: [nextAction],
          };
          setMessages((prev) => {
            const existing = prev.findIndex((message) => message.id === previewMessageId);
            if (existing >= 0) return prev.map((message) => (message.id === previewMessageId ? nextMessage : message));
            return [...prev, nextMessage];
          });
        };
        replacePreviewMessage(previewAction);

        const res = await fetch("/api/document-generation/drafts/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dealId: action.dealId,
            typeId: action.typeId,
            typeName: action.typeName,
            outputFormat: action.outputFormat,
            prompt: action.prompt,
            skipResearch: Boolean(action.skipResearch),
          }),
        });
        if (!res.ok || !res.body) {
          const json = (await res.json().catch(() => null)) as DocumentDraftResponse | null;
          throw new Error(json?.error || `Failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamedContent = "";
        const streamState: {
          preflightNeedsResearch?: Extract<DocumentStreamEvent, { type: "needs_research" }>;
          doneDraft?: NonNullable<Extract<DocumentStreamEvent, { type: "done" }>["draft"]>;
        } = {};
        const applyStreamEvent = (event: DocumentStreamEvent) => {
          if (event.type === "start") {
            replacePreviewMessage({ ...previewAction, title: event.title || previewAction.title });
          } else if (event.type === "delta") {
            streamedContent += event.text || "";
            replacePreviewMessage({ ...previewAction, content: streamedContent, streaming: true });
          } else if (event.type === "needs_research") {
            streamState.preflightNeedsResearch = event;
          } else if (event.type === "done") {
            if (event.draft) streamState.doneDraft = event.draft;
          } else if (event.type === "error") {
            throw new Error(event.error || "Document generation failed.");
          }
        };
        const consumeEventBlock = (block: string) => {
          const payload = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!payload) return;
          applyStreamEvent(JSON.parse(payload) as DocumentStreamEvent);
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) consumeEventBlock(block);
        }
        buffer += decoder.decode();
        if (buffer.trim()) consumeEventBlock(buffer);

        if (streamState.preflightNeedsResearch) {
          const steps = streamState.preflightNeedsResearch.preflight?.researchSteps ?? [];
          const stepLines = steps
            .map((s) => {
              const task = typeof s.task === "string" ? s.task : "";
              const source = typeof s.sourceHint === "string" && s.sourceHint ? ` (${s.sourceHint})` : "";
              const reason = typeof s.reason === "string" && s.reason ? ` - ${s.reason}` : "";
              return task ? `${task}${source}${reason}` : "";
            })
            .filter(Boolean);
          const message: ChatMessage = {
	            id: previewMessageId,
	            role: "assistant",
	            content:
	              `This document may need more research first.${streamState.preflightNeedsResearch.preflight?.rationale ? `\n\n${streamState.preflightNeedsResearch.preflight.rationale}` : ""}` +
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
          };
          setMessages((prev) => prev.map((item) => (item.id === previewMessageId ? message : item)));
          void saveAssistantMessage(message, threadIdForSave);
          markToolRun(runKey, { status: "done", label: action.label, detail: "Research recommended before generation" });
          transientMessageId = null;
          return;
        }
        const draft = streamState.doneDraft;
        if (!draft?.id) throw new Error("The document stream finished without saving a draft.");
        const format = documentFormatFromMetadata(draft?.metadata, action.outputFormat);
        const message: ChatMessage = {
          id: previewMessageId,
          role: "assistant",
          content: "",
          actions: [
            {
              type: "document_preview",
              label: "Generated document",
              title: draft.title || action.typeName,
              href: `/home/generated-documents/${draft.id}`,
              downloadHref: `/api/document-generation/drafts/${draft.id}/download`,
              format,
              dealName: action.dealName,
              content: plainChatText(draft.content || streamedContent),
              excerpt: plainChatText(draft.content || streamedContent).slice(0, 700),
              streaming: false,
            },
          ],
        };
        setMessages((prev) => prev.map((item) => (item.id === previewMessageId ? message : item)));
        await saveAssistantMessage(message, threadIdForSave);
        markToolRun(runKey, { status: "done", label: action.label, detail: draft?.title ? `Generated ${draft.title}` : "Document generated" });
        transientMessageId = null;
      } else if (action.type === "propose_research") {
        const created: Array<{
          dealName: string;
          href: string;
          summary: string;
          runs: Array<{ dealName: string; task: string; notes: string; sources: ResearchRun["sources"] }>;
        }> = [];
        setResearchTrace(key, () => ({
          title: `Researching ${listNames(action.dealNames)}`,
          status: "running",
          steps: [],
          links: [],
        }));
        const sharedInternalStepKey = action.dealIds.length > 1 ? "internal-db:all" : null;
        if (sharedInternalStepKey) {
          setResearchTrace(key, (trace) => {
            const current = trace ?? { title: `Researching ${listNames(action.dealNames)}`, status: "running", steps: [], links: [] };
            return {
              ...current,
              steps: [
                ...current.steps.map((item) => ({ ...item, expanded: false })),
                {
                  key: sharedInternalStepKey,
                  dealName: listNames(action.dealNames),
                  task: "Internal database search",
                  status: "running",
                  kind: "internal_db",
                  detail: "Searching saved records, documents, and related-company database signals",
                  expanded: true,
                },
              ],
            };
          });
        }
        let sharedInternalStepCompleted = false;
        for (let i = 0; i < action.dealIds.length; i++) {
          const dealIdForRun = action.dealIds[i]!;
          const dealNameForRun = action.dealNames[i] ?? "Company";
          const internalStepKey = sharedInternalStepKey ?? `${dealIdForRun}:internal-db`;
          if (!sharedInternalStepKey) {
            setResearchTrace(key, (trace) => {
              const current = trace ?? { title: `Researching ${listNames(action.dealNames)}`, status: "running", steps: [], links: [] };
              const nextStep: ResearchTraceStep = {
                key: internalStepKey,
                dealName: dealNameForRun,
                task: "Internal database search",
                status: "running",
                kind: "internal_db",
                detail: "Searching saved records, documents, and database signals",
                expanded: true,
              };
              const existing = current.steps.find((item) => item.key === internalStepKey);
              return {
                ...current,
                steps: existing
                  ? current.steps.map((item) => (item.key === internalStepKey ? { ...item, ...nextStep } : item))
                  : [...current.steps.map((item) => ({ ...item, expanded: false })), nextStep],
              };
            });
          }
          const res = await fetch("/api/research/workflows/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dealId: dealIdForRun,
              focus: action.focus,
              peerDealIds: action.dealIds.filter((id) => id !== dealIdForRun),
              peerDealNames: action.dealNames.filter((_, idx) => action.dealIds[idx] !== dealIdForRun),
            }),
          });
          const json = (await res.json().catch(() => null)) as ResearchWorkflowResponse | null;
          if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
          const workflowId = json?.workflow?.id;
          const usedInternalContext = Boolean(json?.workflow?.metadata?.internal_context_used);
          if (!sharedInternalStepKey || !sharedInternalStepCompleted) {
            updateResearchTraceStep(key, internalStepKey, {
              status: "done",
              detail: usedInternalContext ? "Used saved workspace context and database signals" : "Checked saved workspace context and database signals",
              expanded: false,
            });
            sharedInternalStepCompleted = Boolean(sharedInternalStepKey);
          }
          const workflowSteps = [...(json?.steps ?? [])];
          const allRuns: ResearchRun[] = [];
          if (workflowId && workflowSteps.length) {
            for (let stepIndex = 0; stepIndex < workflowSteps.length; stepIndex++) {
              const step = workflowSteps[stepIndex]!;
              const stepKey = `${dealIdForRun}:${step.id}`;
              setResearchTrace(key, (trace) => {
                const current = trace ?? { title: `Researching ${listNames(action.dealNames)}`, status: "running", steps: [], links: [] };
                const existing = current.steps.find((item) => item.key === stepKey);
                const nextStep: ResearchTraceStep = {
                  key: stepKey,
                  dealName: dealNameForRun,
                  task: plainChatText(step.task || "Research step"),
                  website: step.website,
                  status: "running",
                  detail: step.website && step.website !== "web" ? `Opening ${step.website}` : "Searching the web",
                  expanded: true,
                };
                return {
                  ...current,
                  steps: existing
                    ? current.steps.map((item) => (item.key === stepKey ? { ...item, ...nextStep } : item))
                    : [...current.steps.map((item) => ({ ...item, expanded: false })), nextStep],
                };
              });
              const execRes = await fetch(`/api/research/workflows/${workflowId}/execute/${step.id}`, { method: "POST" });
              const execJson = (await execRes.json().catch(() => null)) as ResearchExecuteResponse | null;
              if (!execRes.ok) {
                updateResearchTraceStep(key, stepKey, {
                  status: "failed",
                  detail: execJson?.error || `Failed to run this step (${execRes.status})`,
                });
                throw new Error(execJson?.error || `Failed to run research (${execRes.status})`);
              }
              const run = execJson?.run;
              if (run) allRuns.push(run);
              for (const followUp of execJson?.createdFollowUpSteps ?? []) {
                if (!followUp.id || workflowSteps.some((existingStep) => existingStep.id === followUp.id)) continue;
                if (workflowSteps.length >= 8) break;
                workflowSteps.push(followUp);
              }
              const sources = run?.sources ?? [];
              updateResearchTraceStep(key, stepKey, {
                status: run?.run_status === "failed" ? "failed" : "done",
                sources,
                expanded: false,
                detail:
                  run?.run_status === "failed"
                    ? run.error_message || "This step failed"
                    : sources.length
                      ? `Opened ${sources.map((source) => (source.url ? sourceHost(source.url) : "")).filter(Boolean).slice(0, 3).join(", ")}`
                      : "Completed",
              });
            }
          }
          created.push({
            dealName: dealNameForRun,
            href: `/home/deal-intel/${dealIdForRun}/research`,
            summary: summarizeResearchRuns(allRuns),
            runs: allRuns
              .filter((run) => run.run_status === "done" && run.output_notes)
              .map((run) => ({
                dealName: dealNameForRun,
                task: plainChatText(run.metadata?.task || "Research step"),
                notes: plainChatText(run.output_notes || ""),
                sources: run.sources ?? [],
              })),
          });
        }
        setResearchTrace(key, (trace) => ({
          title: `Research for ${listNames(action.dealNames)}`,
          status: "done",
          steps: trace?.steps ?? [],
          links: created.map((c) => ({ label: `Open ${c.dealName} research`, href: c.href })),
        }));
        if (options.suppressResearchAnswer) {
          markToolRun(runKey, { status: "done", label: action.label, detail: created.length === 1 ? "Research finished" : `${created.length} research runs finished` });
          return;
        }
        const fallback = composeResearchAnswer(created);
        const runs = created.flatMap((item) => item.runs);
        const message: ChatMessage = {
          id: newId(),
          role: "assistant",
          content: "",
          actions: created.map((c) => ({
            type: "open_link",
            label: `Open ${c.dealName} research results`,
            href: c.href,
          })),
        };
        setMessages((prev) => [...prev, message]);
        const setStreamedMessageContent = (content: string) => {
          setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, content } : item)));
        };
        let finalContent = "";
        if (!runs.length) {
          finalContent = fallback;
          setStreamedMessageContent(finalContent);
        } else {
          const res = await fetch("/api/research/workflows/synthesize", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({
              userPrompt: action.userPrompt || action.focus,
              researchFocus: action.focus,
              companies: created.map((item) => item.dealName),
              runs,
            }),
          }).catch(() => null);
          if (!res?.ok || !res.body) {
            finalContent = fallback;
            setStreamedMessageContent(finalContent);
          } else {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let streamed = "";
            const handleStreamEvent = (event: TextStreamEvent) => {
              if (event.type === "delta") {
                streamed += event.text || "";
                setStreamedMessageContent(plainChatText(streamed));
              } else if (event.type === "done") {
                finalContent = plainChatText(event.answer || streamed || fallback);
                setStreamedMessageContent(finalContent);
              } else if (event.type === "error" && !streamed) {
                finalContent = fallback;
                setStreamedMessageContent(finalContent);
              }
            };
            while (true) {
              const { done, value } = await reader.read();
              if (value) {
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";
                for (const part of parts) {
                  const line = part.split("\n").find((item) => item.startsWith("data:"));
                  if (!line) continue;
                  const event = JSON.parse(line.slice(5).trim()) as TextStreamEvent;
                  handleStreamEvent(event);
                }
              }
              if (done) break;
            }
            if (!finalContent) {
              finalContent = plainChatText(streamed || fallback);
              setStreamedMessageContent(finalContent);
            }
          }
        }
        void saveAssistantMessage({ ...message, content: finalContent }, threadIdForSave);
        markToolRun(runKey, { status: "done", label: action.label, detail: created.length === 1 ? "Research finished" : `${created.length} research runs finished` });
      } else if (action.type === "propose_matrix_fill") {
        const columnIds = [...action.columnIds];
        const columnLabelById = new Map<string, string>();
        action.columnIds.forEach((columnId, index) => {
          columnLabelById.set(columnId, action.columnLabels[index] || columnId);
        });
        const dealLabelById = new Map(action.dealIds.map((dealId, index) => [dealId, action.dealNames[index] || dealId]));
        let createdColumns = 0;
        for (const draft of action.columnsToCreate ?? []) {
          const createRes = await fetch("/api/diligence-matrix/columns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              label: draft.label,
              description: draft.description || "",
              dataType: draft.dataType || "text",
              prompt: draft.prompt,
              researchEnabled: draft.researchEnabled !== false,
            }),
          });
          const createJson = (await createRes.json().catch(() => null)) as MatrixColumnResponse | null;
          if (!createRes.ok || !createJson?.column?.id) {
            throw new Error(createJson?.error || `Failed to create matrix column (${createRes.status})`);
          }
          columnIds.push(createJson.column.id);
          columnLabelById.set(createJson.column.id, createJson.column.label || draft.label);
          createdColumns += 1;
        }
        if (!columnIds.length) throw new Error("No matrix columns were available for this request.");
        const res = await fetch("/api/diligence-matrix/fill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealIds: action.dealIds, columnIds, allowResearch: true }),
        });
        const json = (await res.json().catch(() => null)) as MatrixFillResponse | null;
        if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
        const cells = json?.cells ?? [];
        const filled = cells.filter((cell) => cell.status === "filled").length;
        const errors = json?.errors?.length ?? 0;
        const cellByPair = new Map(cells.map((cell) => [`${cell.deal_id || ""}:${cell.column_id || ""}`, cell]));
        const matrixRows = action.dealIds
          .map((dealId) => {
            const values: Array<{ columnId: string; columnLabel: string; value: string; status?: string }> = [];
            for (const columnId of columnIds) {
              const cell = cellByPair.get(`${dealId}:${columnId}`);
              const label = columnLabelById.get(columnId) || "Matrix field";
              const value = plainChatText(cell?.value_text || (cell?.status === "needs_research" ? "Needs more evidence" : ""));
              if (value) values.push({ columnId, columnLabel: label, value, status: cell?.status });
            }
            return {
              dealId,
              dealName: dealLabelById.get(dealId) || dealId,
              values,
            };
          })
          .filter((row) => row.values.length);
	        const message: ChatMessage = {
	          id: newId(),
	          role: "assistant",
	          content: matrixRows.length
	            ? ""
	            : [
	                createdColumns ? `Created ${createdColumns} matrix column${createdColumns === 1 ? "" : "s"} for this request.` : "",
	                filled ? `Updated ${filled} matrix cell${filled === 1 ? "" : "s"}.` : "I checked the matrix cells, but nothing was filled.",
	                errors ? `${errors} cell${errors === 1 ? "" : "s"} need attention.` : "",
	              ].filter(Boolean).join("\n\n"),
          actions: matrixRows.length
            ? [
                {
                  type: "matrix_preview",
                  label: "Matrix output",
                  href: "/home/matrix",
                  detail: filled ? `${filled} cells updated` : "Open the full matrix",
                  columns: columnIds.map((columnId) => ({ id: columnId, label: columnLabelById.get(columnId) || "Matrix field" })),
                  rows: matrixRows,
                },
              ]
            : [],
        };
        clearTransientMessage();
        setMessages((prev) => [...prev, message]);
        await saveAssistantMessage(message, threadIdForSave);
        markToolRun(runKey, { status: "done", label: action.label, detail: filled ? `${filled} cells updated` : "Matrix checked" });
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
        clearTransientMessage();
        setMessages((prev) => [...prev, message]);
        void saveAssistantMessage(message, threadIdForSave);
        markToolRun(runKey, { status: "done", label: action.label, detail: `${action.updates.length} update${action.updates.length === 1 ? "" : "s"} applied` });
      } else if (action.type === "propose_custom_workflow") {
        const res = await fetch(`/api/workflows/${action.workflowId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealId: action.dealId, input: action.input }),
        });
        const json = (await res.json().catch(() => null)) as WorkflowRunResponse | null;
        if (!res.ok || (!json?.run && !json?.result)) throw new Error(json?.error || `Failed (${res.status})`);
        if (json.run) {
          const message: ChatMessage = {
            id: newId(),
            role: "assistant",
            content: `Started ${action.workflowName}${action.dealName ? ` for ${action.dealName}` : ""}. It will keep running if you leave this page, and you can monitor it from Workflows.`,
            actions: [
              {
                type: "open_link",
                label: "Open workflow runs",
                href: "/home/workflows",
                detail: json.run.summary || "Running",
              },
            ],
          };
          clearTransientMessage();
          setMessages((prev) => [...prev, message]);
          void saveAssistantMessage(message, threadIdForSave);
          markToolRun(runKey, { status: "done", label: action.label, detail: "Workflow started" });
          return;
        }
        const result = json.result;
        if (!result) throw new Error("Workflow did not return a run result.");
        const stepLines = result.stepResults
          .map((step) => `${step.title} (${step.status}): ${compactResearchNotes(step.detail)}`)
          .join("\n");
        const message: ChatMessage = {
          id: newId(),
          role: "assistant",
          content: [
            `Finished ${action.workflowName}${action.dealName ? ` for ${action.dealName}` : ""}.`,
            result.summary ? `Summary:\n${result.summary}` : "",
            stepLines ? `Details:\n${stepLines}` : "",
          ].filter(Boolean).join("\n\n"),
          actions: result.artifacts
            .filter((artifact) => artifact.href)
            .map((artifact) => ({
              type: "open_link",
              label: artifact.label,
              href: artifact.href!,
              detail: artifact.detail,
            })),
        };
        clearTransientMessage();
        setMessages((prev) => [...prev, message]);
        void saveAssistantMessage(message, threadIdForSave);
        markToolRun(runKey, { status: "done", label: action.label, detail: "Workflow finished" });
      }
    } catch (e) {
      if (action.type === "propose_research") {
        setResearchTrace(key, (trace) => ({
          title: trace?.title ?? `Researching ${listNames(action.dealNames)}`,
          status: "failed",
          steps: trace?.steps ?? [],
          links: trace?.links ?? [],
        }));
      }
      markToolRun(runKey, { status: "error", label: action.label, detail: e instanceof Error ? e.message : "The action failed" });
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
    const runnable = actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => isRunnableAction(action, toolPermissions));
    const hasDocumentOrMatrix = runnable.some(({ action }) => action.type === "propose_generate_document" || action.type === "propose_matrix_fill");
    const ordered = runnable.slice().sort((a, b) => {
      const priority = (action: ChatAction) => {
        if (action.type === "propose_research") return 0;
        if (action.type === "propose_generate_document") return 1;
        if (action.type === "propose_matrix_fill") return 2;
        return 3;
      };
      return priority(a.action) - priority(b.action) || a.index - b.index;
    });
    if (runnable.length) {
      setAutoActionKeys((prev) => {
        const next = new Set(prev);
        for (const { action, index } of runnable) next.add(`${messageId}-${action.type}-${index}`);
        return next;
      });
    }
    for (const { action, index } of ordered) {
      await runAction(action, `${messageId}-${action.type}-${index}`, threadIdForSave, true, {
        suppressResearchAnswer: action.type === "propose_research" && hasDocumentOrMatrix,
      });
    }
  }

  function shouldRenderActionForMessage(action: ChatAction, key: string): boolean {
    if (action.type === "tool_call") return false;
    if (action.type === "matrix_preview" || action.type === "document_preview") return true;
    if (action.type === "open_document" || action.type === "open_link" || action.type === "record_update") return true;
    const runState = toolRuns[key];
    if (runState?.status === "done") return false;
    if (action.type === "propose_research") {
      const trace = researchTraces[key];
      if (trace?.status === "done") return false;
      const savedLinks = action.dealIds
        .map((id) => savedResearchLinksByDeal.get(id))
        .filter(Boolean);
      if (autoActionKeys.has(key)) return Boolean(trace) || busyAction === key || runState?.status === "error";
      return Boolean(trace) || savedLinks.length !== action.dealIds.length || savedLinks.length === 0;
    }
    if (autoActionKeys.has(key)) return busyAction === key || runState?.status === "running" || runState?.status === "error";
    return true;
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
                    <span className="relative mt-0.5 flex shrink-0 items-center gap-1">
                      <span className="text-[10px] text-zinc-400" suppressHydrationWarning>
                        {mounted ? relativeTime(thread.updated_at) : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteThreadId((current) => (current === thread.id ? null : thread.id))}
                        disabled={deletingThreadId === thread.id}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50 group-hover:opacity-100 group-focus-within:opacity-100"
                        title="Delete chat"
                        aria-label={`Delete ${thread.title || "chat"}`}
                      >
                        {deletingThreadId === thread.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                      {pendingDeleteThreadId === thread.id ? (
                        <div className="absolute right-0 top-8 z-30 w-52 rounded-2xl border border-zinc-200 bg-white p-2 text-left shadow-xl">
                          <p className="px-1 text-xs font-semibold text-zinc-950">Delete this chat?</p>
                          <p className="mt-0.5 px-1 text-[11px] leading-snug text-zinc-500">This removes the saved thread.</p>
                          <div className="mt-2 flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPendingDeleteThreadId(null)}
                              className="inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteThread(thread)}
                              disabled={deletingThreadId === thread.id}
                              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-rose-600 px-2.5 text-xs font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {deletingThreadId === thread.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              Delete
                            </button>
                          </div>
                        </div>
                      ) : null}
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
	            {messages.map((m) => {
	              const contentText = plainChatText(m.content);
	              const hasVisibleActions = Boolean(
	                m.actions?.some((action, actionIndex) => shouldRenderActionForMessage(action, `${m.id}-${action.type}-${actionIndex}`)),
	              );
	              if (!contentText && !hasVisibleActions && !m.citations?.length) return null;
	              return (
	            <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[88%] px-4 py-3 text-sm leading-relaxed",
                  m.role === "assistant" &&
                    m.actions?.some((a) =>
                      a.type === "propose_research" ||
                      a.type === "propose_matrix_fill" ||
                      a.type === "propose_generate_document" ||
                      a.type === "propose_custom_workflow" ||
                      a.type === "matrix_preview" ||
                      a.type === "document_preview",
                    )
                    ? "w-full max-w-full"
                    : "",
                  m.role === "user"
                    ? "rounded-3xl bg-zinc-100 text-zinc-950"
                    : "text-zinc-900",
                )}
              >
	                {contentText ? <div className="whitespace-pre-wrap">{contentText}</div> : null}
	                {hasVisibleActions ? (
                  <div className="mt-3 flex w-full flex-col gap-2 border-t border-zinc-100 pt-3">
	                    {(m.actions ?? []).map((a, i) => {
                      const key = `${m.id}-${a.type}-${i}`;
                      const runState = toolRuns[key];
                      const isRunning = busyAction === key || runState?.status === "running";
                      const runDone = runState?.status === "done";
                      const runError = runState?.status === "error";
                      if (!shouldRenderActionForMessage(a, key)) return null;
                      if (a.type === "tool_call") {
                        return null;
                      }
                      if (a.type === "matrix_preview") {
                        return <MatrixPreviewCard key={key} action={a} />;
                      }
                      if (a.type === "document_preview") {
                        return <DocumentPreviewCard key={key} action={a} />;
                      }
	                      if (a.type === "open_document" || a.type === "open_link") {
	                        return (
	                          <a
	                            key={key}
	                            href={a.href}
	                            target="_blank"
	                            rel="noreferrer"
	                            className="flex w-full max-w-full items-center justify-between gap-3 border-t border-zinc-200 px-1 py-2 text-left text-xs font-medium text-zinc-950 hover:bg-zinc-50 md:w-[760px]"
	                          >
	                            <span className="min-w-0">
	                              <span className="block truncate">{a.label}</span>
	                              {"detail" in a && a.detail ? <span className="mt-0.5 block truncate font-normal text-zinc-950">{a.detail}</span> : null}
	                            </span>
	                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
	                          </a>
	                        );
	                      }
                      if (a.type === "propose_generate_document") {
                        return (
                          <ToolActionButton
                            key={key}
                            label={a.label}
                            detail={runState?.detail || `${a.outputFormat.toUpperCase()}${a.dealName ? ` - ${a.dealName}` : ""}`}
                            status={runError ? "error" : isRunning ? "running" : runDone ? "done" : "queued"}
                            icon={<FileText className="mt-0.5 h-3.5 w-3.5 text-zinc-950" />}
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                          />
                        );
                      }
                      if (a.type === "propose_research") {
                        const savedLinks = a.dealIds
                          .map((id) => savedResearchLinksByDeal.get(id))
                          .filter((link): link is { label: string; href: string } => Boolean(link));
                        if (!researchTraces[key] && savedLinks.length === a.dealIds.length && savedLinks.length) {
                          return null;
                        }
                        return (
                          <ResearchTracePanel
                            key={key}
                            action={a}
                            trace={researchTraces[key]}
                            actionKey={key}
                            busyAction={busyAction}
                            onRun={(nextAction, nextKey) => void runAction(nextAction, nextKey)}
                            onToggleStep={toggleResearchTraceStep}
                          />
                        );
                      }
                      if (a.type === "propose_custom_workflow") {
                        return (
                          <ToolActionButton
                            key={key}
                            label={a.label}
                            detail={runState?.detail || a.dealName || a.workflowName}
                            status={runError ? "error" : isRunning ? "running" : runDone ? "done" : "queued"}
                            icon={<Workflow className="mt-0.5 h-3.5 w-3.5 text-zinc-950" />}
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                          />
                        );
                      }
                      if (a.type === "propose_matrix_fill") {
                        return (
                          <ToolActionButton
                            key={key}
                            label={a.label}
                            detail={runState?.detail || `${a.dealNames.length} row${a.dealNames.length === 1 ? "" : "s"} / ${a.columnLabels.length} column${a.columnLabels.length === 1 ? "" : "s"}`}
                            status={runError ? "error" : isRunning ? "running" : runDone ? "done" : "queued"}
                            icon={<Workflow className="mt-0.5 h-3.5 w-3.5 text-zinc-950" />}
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                          />
                        );
                      }
                      if (a.type === "propose_record_update") {
                        return (
                          <ToolActionButton
                            key={key}
                            label={a.label}
                            detail={runState?.detail || a.dealName}
                            status={runError ? "error" : isRunning ? "running" : runDone ? "done" : "queued"}
                            icon={<CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-zinc-950" />}
                            onClick={() => runAction(a, key)}
                            disabled={Boolean(busyAction)}
                          />
                        );
                      }
                      return (
                        <div key={key} className="w-full max-w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700 shadow-sm md:w-[760px]">
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
	              );
	            })}
            {busy ? (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-3xl bg-zinc-50 px-4 py-3 text-sm text-zinc-950">
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
