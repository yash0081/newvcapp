"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CheckCircle2, Circle, ExternalLink, FileText, Loader2, MessageSquare, Plus, Settings2, Sparkles, Trash2, Workflow, StopCircle, Search, History, Library, UploadCloud, Square, X, Paperclip, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { SelectBox } from "@/components/ui/select-box";
import { stripMarkdownText } from "@/lib/plain-text";

const promptTemplates = [
  {
    category: "Due Diligence",
    prompts: [
      { title: "SaaS Diligence Analysis", text: "Conduct a deep analysis of the company's SaaS business model. Detail their churn patterns, logo retention rates, CAC payback periods, LTV/CAC, and growth efficiency based on the uploaded files." },
      { title: "Strategic Risk Evaluation", text: "Identify the top strategic, technological, and execution risks for this deal. Highlight critical diligence areas we must double-click on." }
    ]
  },
  {
    category: "Financials & Unit Economics",
    prompts: [
      { title: "Revenue & Margins Analysis", text: "Analyze their historical revenue growth, gross margins, EBITDA margins, and current net burn. Summarize key trends." },
      { title: "Cohort & Retention Study", text: "Perform a cohort analysis focusing on customer lifetime value, cohort dollar retention, and customer acquisition efficiency over time." }
    ]
  },
  {
    category: "Executive Synthesis",
    prompts: [
      { title: "Investment Memo Summary", text: "Draft a high-quality 2-page investment memo covering business overview, market size (TAM), competitive barriers, team quality, and our core investment thesis." },
      { title: "1-Page Deal Teaser", text: "Create a highly concise, structured 1-page executive summary outlining the core product innovation and target transaction metrics." }
    ]
  }
];

type DealOption = { id: string; name: string };

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
      researchProfile?: "fast" | "standard" | "deep";
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
    action.type === "propose_record_update" ||
    action.type === "propose_custom_workflow"
  );
}

function isRunnableAction(action: ChatAction, permissions: ChatToolPermissions): boolean {
  return (
    (action.type === "propose_generate_document" && permissions.generateDocuments) ||
    (action.type === "propose_research" && permissions.runResearch) ||
    (action.type === "propose_record_update" && permissions.editRecords) ||
    (action.type === "propose_custom_workflow" && permissions.runWorkflows)
  );
}

function isLegacyMatrixAction(action: { type?: unknown; href?: unknown }): boolean {
  return (
    action.type === "propose_matrix_fill" ||
    action.type === "matrix_preview" ||
    (action.type === "open_link" && typeof action.href === "string" && action.href.startsWith("/home/matrix"))
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

import { Check } from "lucide-react";

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
      <div className="mt-2 space-y-4 px-1 relative">
        <div className="absolute left-[13px] top-4 bottom-4 w-px bg-zinc-200" />
        {rows.map((step, index) => {
          const stepRunning = step.status === "running";
          const stepDone = step.status === "done";
          const stepFailed = step.status === "failed";
          const collapsed = stepDone && !step.expanded && (activeIndex < 0 || index < activeIndex);
          const allHosts = (step.sources ?? [])
            .map((source) => (source.url ? { host: sourceHost(source.url), url: source.url } : null))
            .filter((source): source is { host: string; url: string } => Boolean(source));
          const hosts = allHosts.slice(0, 3);
          const extraSourcesCount = allHosts.length - 3;
          
          return (
            <div
              key={step.key}
              className={cn(
                "flex w-full items-start gap-3 relative text-left text-sm text-zinc-950",
              )}
            >
              <div className="shrink-0 relative z-10 flex h-6 w-6 items-center justify-center bg-white mt-0.5">
                {stepRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-950" />
                ) : stepDone ? (
                  <div className="h-4 w-4 rounded-full bg-black flex items-center justify-center">
                    <Check className="h-2.5 w-2.5 text-white" />
                  </div>
                ) : stepFailed ? (
                  <div className="h-4 w-4 rounded-full bg-rose-600 flex items-center justify-center">
                    <X className="h-2.5 w-2.5 text-white" />
                  </div>
                ) : (
                  <div className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
                )}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <span className={cn("block text-zinc-900 font-medium", collapsed ? "truncate" : "")}>{plainChatText(step.task)}</span>
                {!collapsed ? (
                  <span className="mt-0.5 block text-xs text-zinc-500">
                    {step.dealName ? `${step.dealName}. ` : ""}
                    {plainChatText(step.detail || (step.kind === "internal_db" ? "Searching saved records and database signals" : step.website && step.website !== "web" ? `Opening ${step.website}` : "Searching the web"))}
                  </span>
                ) : (
                  <span className="mt-0.5 block text-[11px] text-zinc-400">Sources hidden</span>
                )}
                {hosts.length && !collapsed ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {hosts.map((source) => (
                      <a
                        key={`${step.key}:${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-lg bg-zinc-100 border border-zinc-200/50 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-200/50 transition-colors"
                      >
                        {source.host}
                      </a>
                    ))}
                    {extraSourcesCount > 0 ? (
                      <button className="rounded-lg bg-zinc-100 border border-zinc-200/50 px-2.5 py-1 text-xs text-zinc-600 font-medium hover:bg-zinc-200/50 transition-colors">
                        +{extraSourcesCount} extra sources
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {stepDone ? (
                  <button
                    type="button"
                    onClick={() => onToggleStep(actionKey, step.key)}
                    className="mt-2 text-[11px] font-semibold text-zinc-400 hover:text-zinc-600 uppercase tracking-wide"
                  >
                    {collapsed ? "Show sources" : "Hide sources"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
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

export function WorkspaceChat({
  deals,
  initialThreads,
  initialDealId = "",
  initialThreadId = null,
}: {
  deals: DealOption[];
  initialThreads: SavedThread[];
  initialDealId?: string;
  initialThreadId?: string | null;
}) {
  const [mounted, setMounted] = useState(false);
  const [dealId, setDealId] = useState<string>(initialDealId);
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
  const [deepThink, setDeepThink] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const selectedDeal = useMemo(() => deals.find((d) => d.id === dealId) ?? null, [deals, dealId]);
  const historyDealScope = initialDealId ? dealId || initialDealId : null;
  const sessionActive = useMemo(
    () =>
      busy ||
      Boolean(busyAction) ||
      Object.values(researchTraces).some((trace) => trace.status === "running"),
    [busy, busyAction, researchTraces],
  );
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
    const scope = historyDealScope;
    const url = scope ? `/api/chat/threads?dealId=${encodeURIComponent(scope)}` : "/api/chat/threads";
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as { threads?: SavedThread[] };
    if (res.ok && Array.isArray(data.threads)) setThreads(data.threads);
  }

  function stopSession() {
    cancelRequestedRef.current = true;
    sessionAbortRef.current?.abort();
    setAbortController(null);
    sessionAbortRef.current = null;
    setBusy(false);
    setBusyAction(null);
    setResearchTraces((prev) => {
      const next: Record<string, ResearchTraceState> = { ...prev };
      for (const [key, trace] of Object.entries(next)) {
        if (trace.status !== "running") continue;
        next[key] = {
          ...trace,
          status: "failed",
          steps: trace.steps.map((step) =>
            step.status === "running" || step.status === "queued"
              ? { ...step, status: "failed", detail: "Stopped" }
              : step,
          ),
        };
      }
      return next;
    });
  }

  function beginSessionAbort(): AbortSignal | undefined {
    cancelRequestedRef.current = false;
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    setAbortController(controller);
    return controller.signal;
  }

  function endSessionAbort() {
    sessionAbortRef.current = null;
    setAbortController(null);
  }

  function isCancelled(): boolean {
    return cancelRequestedRef.current;
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
      if (!res.ok) {
        if (res.status === 404) {
          if (typeof window !== "undefined") window.localStorage.removeItem("workspace-chat-active-thread-id");
          setActiveThreadId(null);
          setMessages([]);
          setDealId(initialDealId);
          setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
          return;
        }
        throw new Error(data.error || "Failed to load chat");
      }
      setActiveThreadId(threadId);
      setMessages((data.messages ?? []).map((message) => ({
        ...message,
        content: plainChatText(message.content),
        actions: stripStaleProposalActions(message.actions),
      })));
      setDealId(data.thread?.dealId ?? initialDealId ?? "");
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
    const storedThreadId = initialThreadId || window.localStorage.getItem("workspace-chat-active-thread-id");
    if (storedThreadId) {
      const scope = initialDealId || null;
      const allowed =
        !scope || initialThreads.some((thread) => thread.id === storedThreadId && thread.dealId === scope);
      if (allowed) void loadThread(storedThreadId);
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
    setDealId(initialDealId);
    setInput("");
    setToolRuns({});
    setResearchTraces({});
    setAutoActionKeys(new Set());
    setChatHistoryOpen(false);
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
        setDealId(initialDealId);
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

  const [attachedFiles, setAttachedFiles] = useState<
    Array<{ id: string; name: string; status: "uploading" | "ready" | "failed"; fileObj: File; docId?: string }>
  >([]);

  function removeAttachedFile(id: string) {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  async function uploadChatFile(item: { id: string; name: string; status: "uploading" | "ready" | "failed"; fileObj: File }) {
    if (!dealId) {
      setAttachedFiles((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: "ready" as const } : f))
      );
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", item.fileObj);
      const res = await fetch(`/api/crm/companies/${dealId}/documents/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = (await res.json()) as { documentId?: string };
      setAttachedFiles((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: "ready" as const, docId: data.documentId } : f))
      );
    } catch {
      setAttachedFiles((prev) =>
        prev.map((f) => (f.id === item.id ? { ...f, status: "failed" as const } : f))
      );
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || !list.length) return;
    const newFiles = Array.from(list).map((file) => ({
      id: newId(),
      name: file.name,
      status: "uploading" as const,
      fileObj: file,
    }));
    setAttachedFiles((prev) => [...prev, ...newFiles]);
    for (const item of newFiles) {
      void uploadChatFile(item);
    }
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.type === "deal_document" && data.id && data.name) {
        setAttachedFiles((prev) => {
          if (prev.some((f) => f.id === data.id || f.name === data.name)) return prev;
          return [...prev, { id: data.id, name: data.name, status: "ready" as const, fileObj: new File([], data.name), docId: data.id }];
        });
      }
    } catch {
      // ignore
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  async function send() {
    const text = input.trim();
    if (!text || sessionActive) return;

    let finalPrompt = text;
    if (attachedFiles.length > 0) {
      const readyFiles = attachedFiles.filter((f) => f.status === "ready");
      if (readyFiles.length > 0) {
        finalPrompt = `${text}\n\n[Attached Documents: ${readyFiles.map((f) => f.name).join(" | ")}]`;
      }
    }

    setInput("");
    setAttachedFiles([]);
    const userMsg: ChatMessage = { id: newId(), role: "user", content: finalPrompt };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    const signal = beginSessionAbort();
    try {
      const history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        signal,
        body: JSON.stringify({
          message: finalPrompt,
          dealId: dealId || null,
          history,
          threadId: activeThreadId,
          permissions: deepThink ? { ...toolPermissions, runResearch: true } : toolPermissions,
          deepMode: deepThink,
        }),
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
        type PendingAutoActions = {
          actions: ChatAction[];
          assistantId: string;
          threadId: string | null;
        };
        const pendingAutoActionsHolder: { current: PendingAutoActions | null } = { current: null };
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
            if (!isCancelled()) {
              pendingAutoActionsHolder.current = {
                actions: assistantActions,
                assistantId,
                threadId: finalResult.threadId ?? activeThreadId,
              };
            }
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
        const deferredAutoActions = pendingAutoActionsHolder.current;
        if (deferredAutoActions !== null && !isCancelled()) {
          await runAutoActions(
            deferredAutoActions.actions,
            deferredAutoActions.assistantId,
            deferredAutoActions.threadId,
          );
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
      if (!isCancelled()) {
        await runAutoActions(assistantActions, assistantId, threadIdForSave);
      }
      void refreshThreads();
    } catch (e) {
      if (!isCancelled() && !(e instanceof DOMException && e.name === "AbortError")) {
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "assistant",
            content: e instanceof Error ? e.message : "Chat failed.",
          },
        ]);
      }
    } finally {
      endSessionAbort();
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
    if (busyAction || isCancelled()) return;
    const actionSignal = sessionAbortRef.current?.signal;
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
          signal: actionSignal,
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
          if (isCancelled()) break;
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
            signal: actionSignal,
            body: JSON.stringify({
              dealId: dealIdForRun,
              focus: action.focus,
              peerDealIds: action.dealIds.filter((id) => id !== dealIdForRun),
              peerDealNames: action.dealNames.filter((_, idx) => action.dealIds[idx] !== dealIdForRun),
              researchProfile: action.researchProfile ?? (deepThink ? "deep" : "standard"),
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
              if (isCancelled()) break;
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
              const execRes = await fetch(`/api/research/workflows/${workflowId}/execute/${step.id}`, {
                method: "POST",
                signal: actionSignal,
              });
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
        if (isCancelled()) {
          setResearchTrace(key, (trace) => ({
            title: trace?.title ?? `Researching ${listNames(action.dealNames)}`,
            status: "failed",
            steps: trace?.steps ?? [],
            links: trace?.links ?? [],
          }));
          markToolRun(runKey, { status: "error", label: action.label, detail: "Stopped" });
          return;
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
            signal: actionSignal,
            body: JSON.stringify({
              userPrompt: action.userPrompt || action.focus,
              researchFocus: action.userPrompt || action.focus,
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
    const hasDocument = runnable.some(({ action }) => action.type === "propose_generate_document");
    const ordered = runnable.slice().sort((a, b) => {
      const priority = (action: ChatAction) => {
        if (action.type === "propose_research") return 0;
        if (action.type === "propose_generate_document") return 1;
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
      if (isCancelled()) break;
      await runAction(action, `${messageId}-${action.type}-${index}`, threadIdForSave, true, {
        suppressResearchAnswer: action.type === "propose_research" && hasDocument,
      });
    }
  }

  function shouldRenderActionForMessage(action: ChatAction, key: string): boolean {
    if (action.type === "tool_call") return false;
    if (isLegacyMatrixAction(action)) return false;
    if (action.type === "document_preview") return true;
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

  const filteredThreads = threads.filter((t) => {
    if (historyDealScope && t.dealId !== historyDealScope) return false;
    if (!historyQuery) return true;
    const q = historyQuery.toLowerCase();
    return (t.title || "").toLowerCase().includes(q) || (t.preview || "").toLowerCase().includes(q);
  });

  return (
    <div className="flex h-full w-full bg-white relative overflow-hidden select-none">
      {/* Centered Chat History Modal */}
      {chatHistoryOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/20 backdrop-blur-md p-4 transition-all duration-300">
          <div className="w-full max-w-2xl bg-white rounded-3xl border border-zinc-200/80 shadow-[0_24px_64px_rgba(0,0,0,0.12)] flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-zinc-500" />
                <h2 className="text-sm font-bold text-zinc-950 tracking-tight">
                  {historyDealScope && selectedDeal ? `${selectedDeal.name} chats` : "Conversation History"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setChatHistoryOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-zinc-100 text-zinc-500 hover:text-zinc-950 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 border-b border-zinc-100 bg-zinc-50/50">
              <div className="relative">
                <Search className="absolute left-3.5 top-2.5 w-4 h-4 text-zinc-400" />
                <input
                  type="text"
                  className="w-full bg-white border border-zinc-200 rounded-xl pl-10 pr-4 py-2 text-xs outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 transition-all"
                  placeholder="Search previous conversations..."
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {filteredThreads.length > 0 ? (
                filteredThreads.map((thread) => {
                  const active = thread.id === activeThreadId;
                  return (
                    <div
                      key={thread.id}
                      className={cn(
                        "group flex w-full items-start gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all cursor-pointer active:scale-[0.99]",
                        active
                          ? "bg-zinc-950 border-zinc-950 text-white shadow-md shadow-zinc-950/10"
                          : "bg-white border-zinc-200/60 hover:border-zinc-300 hover:bg-zinc-50"
                      )}
                      onClick={() => {
                        loadThread(thread.id);
                        setChatHistoryOpen(false);
                      }}
                    >
                      <MessageSquare className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-white" : "text-zinc-400")} />
                      <div className="min-w-0 flex-1">
                        <span className={cn("block truncate text-xs font-bold uppercase tracking-wider", active ? "text-white" : "text-zinc-950")}>
                          {thread.title || "Untitled Conversation"}
                        </span>
                        <span className={cn("mt-1 block truncate text-[11px] font-medium leading-relaxed", active ? "text-zinc-300" : "text-zinc-500")}>
                          {thread.preview || "No messages yet"}
                        </span>
                      </div>
                      <span className={cn("text-[9px] font-semibold uppercase tracking-wider shrink-0", active ? "text-zinc-400" : "text-zinc-400")}>
                        {mounted ? relativeTime(thread.updated_at) : ""}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-12 text-zinc-400 text-xs font-medium">{historyDealScope ? "No conversations for this company yet." : "No conversations found."}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Chat Interface Panel */}
      <div className="flex h-full w-full min-w-0 flex-col bg-white">
        {/* Workspace Top Header Bar */}
        <div className="shrink-0 border-b border-zinc-200/80 bg-white px-5 py-4">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-sm font-extrabold uppercase tracking-widest text-zinc-950">Workspace Chat</h1>
              <p className="mt-0.5 text-[11px] font-medium text-zinc-500">
                {selectedDeal ? `Context focused on ${selectedDeal.name}` : activeThreadId ? "Viewing saved conversation" : "New workspace-wide assistant session"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startNewChat}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 active:scale-95 transition-all shadow-sm"
                title="Start a new chat session"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setChatHistoryOpen(true)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 active:scale-95 transition-all shadow-sm"
              >
                <History className="h-3.5 w-3.5 text-zinc-500" />
                <span>History</span>
              </button>
              <SelectBox
                value={dealId}
                onChange={(e) => setDealId(e.target.value)}
                wrapperClassName="w-52 sm:w-64"
                className="h-9 max-w-full py-1 text-xs"
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
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 active:scale-95 transition-all shadow-sm"
                  title="Configure chat tools and parameters"
                >
                  <Settings2 className="h-4 w-4" />
                </button>
                {settingsOpen && (
                  <div className="absolute right-0 z-20 mt-2 w-72 rounded-2xl border border-zinc-200 bg-white p-3 shadow-xl animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="px-1 pb-2">
                      <p className="text-xs font-bold text-zinc-950 uppercase tracking-wide">Workspace Permissions</p>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">Toggle assistant automation permissions.</p>
                    </div>
                    <div className="space-y-1">
                      {TOOL_PERMISSION_LABELS.map((item) => (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 transition-colors"
                        >
                          <span className="font-medium text-zinc-600">{item.label}</span>
                          <input
                            type="checkbox"
                            checked={toolPermissions[item.key]}
                            onChange={(e) => setToolPermission(item.key, e.target.checked)}
                            className="h-4 w-4 rounded border-zinc-300 text-zinc-950 focus:ring-0 focus:ring-offset-0"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Chat Message List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 bg-zinc-50/30">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {loadingThread && (
              <div className="flex justify-center items-center py-16 text-xs font-semibold text-zinc-500 gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-zinc-800" />
                <span>Syncing message database...</span>
              </div>
            )}
            {!loadingThread && messages.length === 0 && (
              <div className="mx-auto flex min-h-[48svh] max-w-lg flex-col items-center justify-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-950 text-white shadow-md shadow-zinc-950/10 animate-bounce">
                  <Sparkles className="h-5 w-5" />
                </div>
                <h2 className="mt-5 text-sm font-extrabold uppercase tracking-widest text-zinc-950">Workspace Assistant</h2>
                <p className="mt-2 text-xs leading-relaxed text-zinc-500 font-medium max-w-xs">
                  Ask me about SaaS diligence criteria, financial statement runs, executive summaries, or run custom research playbooks automatically.
                </p>
              </div>
            )}
            {!loadingThread &&
              messages.map((m) => {
                const contentText = plainChatText(m.content);
                const hasVisibleActions = Boolean(
                  m.actions?.some((action, actionIndex) => shouldRenderActionForMessage(action, `${m.id}-${action.type}-${actionIndex}`))
                );
                if (!contentText && !hasVisibleActions && !m.citations?.length) return null;

                if (m.role === "user") {
                  let displayContent = contentText;
                  let attachedSnippetFiles: string[] = [];
                  const attachMatch = contentText.match(/\n\n\[Attached Documents:\s*(.*?)\]$/);
                  if (attachMatch) {
                    displayContent = contentText.slice(0, attachMatch.index);
                    attachedSnippetFiles = attachMatch[1].split(" | ").filter(Boolean);
                  }

                  return (
                    <div key={m.id} className="flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200 mt-1">
                      <div className="max-w-[78%] rounded-2xl border border-zinc-200/80 bg-white px-4 py-3 text-sm font-medium text-zinc-950 shadow-[0_2px_8px_rgba(0,0,0,0.03)] leading-relaxed">
                        <div className="whitespace-pre-wrap">{displayContent}</div>
                      </div>
                      {attachedSnippetFiles.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-2 max-w-[78%]">
                          {attachedSnippetFiles.map((fname, i) => (
                            <div key={i} className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 shadow-sm select-none">
                              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100">
                                <FileText className="h-3 w-3 text-zinc-600" />
                              </div>
                              <span className="text-xs font-medium text-zinc-950 max-w-[180px] truncate">{fname}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={m.id} className="flex justify-start items-start gap-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-800 shadow-sm">
                      <Sparkles className="h-4 w-4 text-zinc-700" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-3 pt-0.5">
                      {contentText && (
                        <div className="whitespace-pre-wrap text-zinc-800 leading-relaxed text-sm">
                          {contentText}
                        </div>
                      )}
                      {hasVisibleActions && (
                        <div className="flex w-full flex-col gap-2 pt-1">
                          {(m.actions ?? []).map((a, i) => {
                            const key = `${m.id}-${a.type}-${i}`;
                            const runState = toolRuns[key];
                            const isRunning = busyAction === key || runState?.status === "running";
                            const runDone = runState?.status === "done";
                            const runError = runState?.status === "error";

                            if (!shouldRenderActionForMessage(a, key)) return null;
                            if (a.type === "tool_call") return null;

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
                                  className="flex w-full max-w-full items-center justify-between gap-3 border border-zinc-200 bg-white px-4 py-3 rounded-2xl text-left text-xs font-semibold text-zinc-950 hover:bg-zinc-50/50 shadow-sm transition-all md:w-[760px] active:scale-[0.99]"
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate">{a.label}</span>
                                    {"detail" in a && a.detail ? (
                                      <span className="mt-0.5 block truncate font-medium text-zinc-500">{a.detail}</span>
                                    ) : null}
                                  </span>
                                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
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
                              <div key={key} className="w-full max-w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-700 shadow-sm md:w-[760px]">
                                <span className="font-semibold">{a.label}:</span> {a.detail}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {m.citations?.length ? (
                        <details className="mt-3 border border-zinc-200/60 bg-white/50 rounded-2xl overflow-hidden transition-all shadow-sm">
                          <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-zinc-500 hover:text-zinc-950 px-4 py-2 border-b border-transparent open:border-zinc-200/60 transition-all select-none">
                            Context Citations used
                          </summary>
                          <div className="p-3 space-y-2 max-h-56 overflow-y-auto bg-zinc-50/50">
                            {m.citations.slice(0, 6).map((c, i) => (
                              <div key={`${c.label}-${i}`} className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[11px] text-zinc-600 shadow-sm">
                                <div className="font-bold text-zinc-950">
                                  {c.href ? (
                                    <a className="hover:underline" href={c.href} target="_blank" rel="noreferrer">
                                      {c.label}
                                    </a>
                                  ) : (
                                    c.label
                                  )}
                                </div>
                                <div className="mt-1 line-clamp-3 text-zinc-500 leading-normal font-medium">{c.snippet}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            {busy && (
              <div className="flex justify-start items-center gap-4 animate-pulse">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-white">
                  <Sparkles className="h-4 w-4 text-zinc-700" />
                </div>
                <div className="inline-flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-600 shadow-sm">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-800" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Locked Workspace Bottom Input Bar */}
        <div className="shrink-0 border-t border-zinc-200 bg-gradient-to-b from-white to-zinc-50/30 px-4 pb-5 pt-3 md:px-6 relative">
          <div className="mx-auto max-w-3xl flex flex-col gap-2">
            {/* Input Box Container */}
            <div
              className="rounded-xl border border-zinc-200 bg-white p-2.5 shadow-[0_2px_12px_rgba(0,0,0,0.03)] focus-within:border-zinc-400 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.05)] transition-all"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2.5 pb-2 border-b border-zinc-100">
                  {attachedFiles.map((file) => (
                    <div
                      key={file.id}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border transition-all select-none",
                        file.status === "uploading"
                          ? "bg-zinc-50 border-zinc-200 text-zinc-400 animate-pulse"
                          : file.status === "failed"
                          ? "bg-rose-50 border-rose-200 text-rose-600 font-semibold"
                          : "bg-white border-zinc-200 text-zinc-950 shadow-sm font-medium"
                      )}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[140px] truncate">{file.name}</span>
                      {file.status === "uploading" ? (
                        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                      ) : (
                        <button
                          type="button"
                          onClick={() => removeAttachedFile(file.id)}
                          className="hover:scale-110 active:scale-95 transition-all text-zinc-400 hover:text-rose-400 p-0.5 shrink-0"
                          title="Remove attachment"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <label className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-50 hover:text-zinc-950 transition-all active:scale-95 shadow-none border border-transparent hover:border-zinc-200/60">
                  <Paperclip className="h-4.5 w-4.5" />
                  <input type="file" className="hidden" multiple onChange={handleFileChange} />
                </label>
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
                  placeholder="Message copilot or attach diligence documents..."
                  className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-1 py-2 text-sm text-zinc-800 outline-none placeholder:text-zinc-400/80 leading-relaxed font-medium"
                  rows={2}
                />
                {sessionActive ? (
                  <button
                    type="button"
                    onClick={stopSession}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-white shadow-sm hover:bg-zinc-900 active:scale-95 transition-all"
                    title="Stop response and research"
                  >
                    <Square className="h-3.5 w-3.5 fill-white text-white" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={send}
                    disabled={!input.trim() || sessionActive}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-white shadow-sm hover:bg-zinc-900 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100"
                    title="Send query"
                  >
                    <Send className="h-4 w-4 ml-0.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Deep Think Selector */}
            <div className="flex justify-end items-center gap-3 px-2 pt-1.5 select-none">
              <label className="flex items-center gap-2 cursor-pointer text-[11px] font-bold uppercase tracking-wider text-zinc-500 hover:text-zinc-950 transition-colors">
                <div
                  className={cn(
                    "flex h-4 w-8 items-center rounded-full p-0.5 transition-colors duration-200 ease-in-out border border-transparent",
                    deepThink ? "bg-zinc-950" : "bg-zinc-200 hover:bg-zinc-300"
                  )}
                  onClick={() => setDeepThink(!deepThink)}
                >
                  <div
                    className={cn(
                      "h-3 w-3 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out",
                      deepThink ? "translate-x-4" : "translate-x-0"
                    )}
                  />
                </div>
                <span>Deep Research</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
