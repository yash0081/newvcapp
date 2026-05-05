import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveDealResponse,
  AutoDraftResponse,
  AutoDraftSnippet,
  ExtensionRequest,
  ObserveResponse,
  PlanNextResponse,
  PromptResponse,
  SessionResponse,
} from "@shared/messages";
import type {
  AcceptedSnippet,
  ActiveDealHint,
  CopilotSession,
  Suggestion,
} from "@shared/types";
import { extractDomSnapshot, fingerprintSnapshot, type SnapshotScope } from "@content/extractor";
import { isNearDuplicateDraftSnippet } from "@shared/draft-dedupe";
import { suggestionRepeatKey } from "@shared/repeat-key";
import { AGENT_AUTO_ACCEPT_MIN_CONFIDENCE, AGENT_NAV_COUNTDOWN_MS } from "@shared/config";
import { highlightAcceptedSnippet } from "@content/highlighter";

const APP_HOSTNAME_RE = /^chrome-extension:|^moz-extension:/;
const PREFS_KEY = "vcapp_overlay_prefs";
/** Local echo of the steering textarea so an un-applied draft survives full page navigations. */
const STEERING_LOCAL_KEY = "vcapp_overlay_steering_draft_v1";

function steeringNoteFromSession(s: CopilotSession | null): string {
  const meta = s?.metadata as Record<string, unknown> | undefined;
  const v = meta?.auto_steering_note;
  return typeof v === "string" ? v : "";
}

function companyNameFromSession(s: CopilotSession | null): string | null {
  const meta = s?.metadata as Record<string, unknown> | undefined;
  const v = meta?.company_name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
const FINGERPRINT_SUPPRESSION_MS = 5000;
const MAX_VISIBLE_SUGGESTIONS = 8;
const FIRST_ANALYZE_DEBOUNCE_MS = 800;
const ANALYZE_DEBOUNCE_MS = 1500;
/** End session if automated observe succeeded this long ago (ms) while snippets exist. */
const OBSERVE_IDLE_END_MS = 30 * 60 * 1000;

function truncateWords(s: string, maxLen: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length <= maxLen) return t;
  const slice = t.slice(0, maxLen);
  const sp = slice.lastIndexOf(" ");
  return (sp > 20 ? slice.slice(0, sp) : slice).trim() + "…";
}

/** Cheap topic hints from visible text / suggestions — drives friendly status lines only. */
const RESEARCH_TOPIC_PATTERNS: ReadonlyArray<{ re: RegExp; phrase: string }> = [
  {
    re: /\b(stock price|share price|nasdaq|nyse|ticker|market cap|valuation|equity)\b|\bstock\b|\bshares?\b/i,
    phrase: "stock price and market signals",
  },
  { re: /\b(ceo|cfo|cto|coo|chief executive|founder|co-founder|leadership|management team|executives?|board of directors)\b/i, phrase: "leadership and executives" },
  { re: /\b(revenue|arr|mrr|annual recurring|booking|pipeline)\b/i, phrase: "revenue and growth metrics" },
  { re: /\b(funding|raised|series [a-e]|seed round|venture|investors?)\b/i, phrase: "funding and investors" },
  { re: /\b(customer|customers|logo|enterprise clients?|case stud)\b/i, phrase: "customers and traction" },
  { re: /\b(product|platform|solution|features?|technology stack)\b/i, phrase: "product and technology" },
  { re: /\b(headquartered|headquarters|hq\b|office|location|geograph|countries|regions?)\b/i, phrase: "geography and offices" },
  { re: /\b(employees?|headcount|team size|hiring)\b/i, phrase: "team size and hiring" },
  { re: /\b(competitor|competitive|landscape|versus|vs\.)\b/i, phrase: "competition" },
  { re: /\b(patents?|intellectual property)\b|\bip\b/i, phrase: "intellectual property" },
  { re: /\b(acquisition|m&a|merger|bought)\b/i, phrase: "M&A activity" },
];

function researchTopicPhrase(blob: string): string | null {
  const sample = blob.slice(0, 16000);
  for (const { re, phrase } of RESEARCH_TOPIC_PATTERNS) {
    if (re.test(sample)) return phrase;
  }
  return null;
}

function analyzingActivitySentence(
  snapshot: { visible_text: string; page_title: string },
  steeringNote: string,
): string {
  const blob = `${snapshot.page_title}\n${snapshot.visible_text}`;
  const topic = researchTopicPhrase(blob);
  const steer = steeringNote.trim();
  let core: string;
  if (topic) core = `Analyzing ${topic} on this page`;
  else core = `Analyzing “${truncateWords(snapshot.page_title, 44)}” for deal-relevant details`;
  if (steer) core += ` — prioritizing ${truncateWords(steer, 72)}`;
  return `${core}…`;
}

function suggestionPickSentence(s: Suggestion): string {
  const blob = `${s.summary}\n${s.snippet}`;
  const topic = researchTopicPhrase(blob);
  if (topic) return `Saving a note about ${topic}…`;
  const hint = truncateWords(s.summary || s.snippet, 64);
  if (hint) return `Pulling out “${hint}”…`;
  return "Saving a useful fact from this page…";
}

function observeFollowUpSentence(suggestions: Suggestion[]): string {
  const pick = suggestions.find((s) => s.kind !== "explore");
  if (!pick) return "Scan complete — planning the next move…";
  const blob = `${pick.summary}\n${pick.snippet}`;
  const topic = researchTopicPhrase(blob);
  if (topic) return `Digging into ${topic} from what we found…`;
  const hint = truncateWords(pick.summary || pick.snippet, 56);
  return hint ? `Reviewing “${hint}” from the model…` : "Reviewing highlights from this page…";
}

function isAppContext(): boolean {
  return APP_HOSTNAME_RE.test(location.protocol);
}

function suggestionKey(s: Pick<Suggestion, "summary" | "snippet">): string {
  return suggestionRepeatKey(s.summary ?? "", s.snippet ?? "");
}

/** 0–1 how far down the document the user has scrolled (for plan-next page-yield). */
function scrollDepthRatio(): number {
  const doc = document.documentElement;
  const body = document.body;
  const scrollTop = window.scrollY ?? doc.scrollTop ?? body.scrollTop ?? 0;
  const view = window.innerHeight;
  const total = Math.max(doc.scrollHeight, body.scrollHeight) - view;
  if (total <= 12) return 1;
  return Math.min(1, Math.max(0, scrollTop / total));
}

function send<T = unknown>(req: ExtensionRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res || typeof res !== "object") {
        reject(new Error("Empty response from background"));
        return;
      }
      if ((res as { ok?: boolean }).ok === false) {
        reject(new Error((res as { error?: string }).error || "Background error"));
        return;
      }
      resolve(((res as { payload?: T }).payload as T) ?? (undefined as unknown as T));
    });
  });
}

type Tab = "suggestions" | "ask";
type CopilotMode = "manual" | "auto";
type DraftReview = Record<string, { checked: boolean; text: string }>;

type Props = {
  activeDeal: ActiveDealHint | null;
  initialSession: CopilotSession | null;
};

export function Overlay({ activeDeal, initialSession }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>("suggestions");
  const [session, setSession] = useState<CopilotSession | null>(initialSession);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [snippets, setSnippets] = useState<AcceptedSnippet[]>(
    (initialSession?.metadata?.acceptedSnippets ?? []) as AcceptedSnippet[],
  );
  const [busy, setBusy] = useState<null | string>(null);
  /** Saving steering uses its own flag so Pause / navigation aren’t blocked by global `busy`. */
  const [steeringSaving, setSteeringSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [mode, setModeState] = useState<CopilotMode>("manual");
  const [scope, setScopeState] = useState<SnapshotScope>("viewport");
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 16, right: 16 });
  const [promptText, setPromptText] = useState("");
  const [pendingNav, setPendingNav] = useState<{ url: string; rationale?: string; at: number } | null>(null);
  const [autoDraft, setAutoDraft] = useState<AutoDraftSnippet[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [reviewState, setReviewState] = useState<DraftReview>({});
  /** Short responsive status sentence for long-running steps (aria-live). */
  const [researchActivity, setResearchActivity] = useState("Watching this page — updates will show here.");
  /** Re-runs auto planner after agent scroll (observe alone often doesn’t bump React deps). */
  const [postScrollPlannerKick, setPostScrollPlannerKick] = useState(0);
  const lastSnapshotRef = useRef<{ fingerprint: string; at: number } | null>(null);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const scrollKickTimerRef = useRef<number | null>(null);
  const pendingNavTimerRef = useRef<number | null>(null);
  /** Count consecutive PLAN_NEXT scroll actions to avoid infinite scroll loops. */
  const agentScrollStreakRef = useRef(0);
  /** Last time /observe returned OK (drives idle auto-end). */
  const lastObserveSuccessAtRef = useRef<number>(Date.now());
  /** Mirrors `paused` for async loops / callbacks that can’t close over fresh state. */
  const pausedRef = useRef(false);
  /** Mirrors `mode` for async loops / delayed navigation callbacks. */
  const modeRef = useRef<CopilotMode>("manual");
  /** Incremented whenever automation is interrupted so stale async work cannot mutate UI. */
  const automationGenerationRef = useRef(0);
  const sessionRef = useRef<CopilotSession | null>(session);
  const autoSteeringDirtyRef = useRef(false);
  /** Ensures we merge chrome.storage steering draft once per active session id. */
  const steeringStorageHydratedFor = useRef<string | null>(null);

  const sessionId = session?.id ?? null;
  const effectiveScope: SnapshotScope = mode === "auto" ? "full" : scope;

  useEffect(() => {
    setPostScrollPlannerKick(0);
    agentScrollStreakRef.current = 0;
    if (scrollKickTimerRef.current != null) {
      window.clearTimeout(scrollKickTimerRef.current);
      scrollKickTimerRef.current = null;
    }
    if (pendingNavTimerRef.current != null) {
      window.clearTimeout(pendingNavTimerRef.current);
      pendingNavTimerRef.current = null;
    }
  }, [sessionId]);

  const sessionMeta = session?.metadata as Record<string, unknown> | undefined;
  const lastSyncedAt =
    sessionMeta && typeof sessionMeta.last_synced_at === "string" ? sessionMeta.last_synced_at : null;

  const serverAutoSteering = useMemo(() => {
    const v = sessionMeta?.auto_steering_note;
    return typeof v === "string" ? v : "";
  }, [session?.id, sessionMeta?.auto_steering_note]);

  const [autoSteeringDraft, setAutoSteeringDraft] = useState(() => steeringNoteFromSession(initialSession));
  const [autoSteeringDirty, setAutoSteeringDirty] = useState(false);

  /** Draft wins when non-empty so analysis/planning follow the textarea before “Apply focus”. */
  const effectiveSteeringHint = useMemo(
    () => (autoSteeringDraft.trim() || serverAutoSteering.trim()) || undefined,
    [autoSteeringDraft, serverAutoSteering],
  );

  sessionRef.current = session;
  pausedRef.current = paused;
  modeRef.current = mode;
  autoSteeringDirtyRef.current = autoSteeringDirty;

  useEffect(() => {
    if (!session?.id) {
      setAutoSteeringDraft("");
      setAutoSteeringDirty(false);
      steeringStorageHydratedFor.current = null;
      return;
    }
    if (!autoSteeringDirty) setAutoSteeringDraft(serverAutoSteering);
  }, [session?.id, serverAutoSteering, autoSteeringDirty]);

  /** Echo steering draft locally so it survives reloads before “Apply focus”. */
  useEffect(() => {
    if (!sessionId) return;
    const id = window.setTimeout(() => {
      try {
        chrome.storage?.local?.set({
          [STEERING_LOCAL_KEY]: { sessionId, draft: autoSteeringDraft, updatedAt: Date.now() },
        });
      } catch {
        /* ignore */
      }
    }, 450);
    return () => window.clearTimeout(id);
  }, [sessionId, autoSteeringDraft]);

  /** After navigation/re-mount: restore draft from storage when server has no applied steering yet. */
  useEffect(() => {
    if (!sessionId) return;
    if (steeringStorageHydratedFor.current === sessionId) return;
    steeringStorageHydratedFor.current = sessionId;
    try {
      chrome.storage?.local?.get(STEERING_LOCAL_KEY, (got) => {
        if (chrome.runtime.lastError) return;
        const pack = got?.[STEERING_LOCAL_KEY] as { sessionId?: string; draft?: string } | undefined;
        if (!pack || pack.sessionId !== sessionId || typeof pack.draft !== "string") return;
        const storedDraft = pack.draft;
        setAutoSteeringDraft((prev) => {
          if (autoSteeringDirtyRef.current) return prev;
          const srv = steeringNoteFromSession(sessionRef.current);
          if (srv.trim()) return srv;
          if (prev.trim()) return prev;
          return storedDraft;
        });
      });
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  /** Pause immediately cancels in-flight analyze noise and pending scroll-kick without waiting on UI locks. */
  useEffect(() => {
    if (!paused) return;
    automationGenerationRef.current += 1;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    setBusy(null);
    setPendingNav(null);
    if (scrollKickTimerRef.current != null) {
      window.clearTimeout(scrollKickTimerRef.current);
      scrollKickTimerRef.current = null;
    }
    if (pendingNavTimerRef.current != null) {
      window.clearTimeout(pendingNavTimerRef.current);
      pendingNavTimerRef.current = null;
    }
    agentScrollStreakRef.current = 0;
    setResearchActivity("Paused — resume when you're ready to continue.");
  }, [paused]);

  // Hydrate persisted preferences (autoMode) once on mount.
  useEffect(() => {
    try {
      chrome.storage?.local?.get(PREFS_KEY, (got) => {
        if (chrome.runtime.lastError) return;
        const raw = got?.[PREFS_KEY];
        if (raw && typeof raw === "object") {
          if (typeof (raw as { paused?: unknown }).paused === "boolean") {
            setPausedState((raw as { paused: boolean }).paused);
          }
          if ((raw as { scope?: unknown }).scope === "viewport" || (raw as { scope?: unknown }).scope === "full") {
            setScopeState((raw as { scope: SnapshotScope }).scope);
          }
          if ((raw as { mode?: unknown }).mode === "manual" || (raw as { mode?: unknown }).mode === "auto") {
            setModeState((raw as { mode: CopilotMode }).mode);
          }
        }
      });
    } catch {
      // chrome.storage may not exist in some test contexts; default state stands.
    }
  }, []);

  const persistPrefs = useCallback((nextPaused: boolean, nextScope: SnapshotScope, nextMode: CopilotMode) => {
    try {
      chrome.storage?.local?.set({ [PREFS_KEY]: { paused: nextPaused, scope: nextScope, mode: nextMode } });
    } catch {
      // best-effort; UI still flips
    }
  }, []);

  const haltAutomation = useCallback((activity = "Paused — resume when you're ready to continue.", opts?: { pause?: boolean }) => {
    automationGenerationRef.current += 1;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    if (scrollKickTimerRef.current != null) {
      window.clearTimeout(scrollKickTimerRef.current);
      scrollKickTimerRef.current = null;
    }
    if (pendingNavTimerRef.current != null) {
      window.clearTimeout(pendingNavTimerRef.current);
      pendingNavTimerRef.current = null;
    }
    agentScrollStreakRef.current = 0;
    if (opts?.pause) {
      pausedRef.current = true;
      setPausedState(true);
    }
    setPendingNav(null);
    setBusy(null);
    setResearchActivity(activity);
  }, []);

  const setPaused = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === "function" ? (next as (p: boolean) => boolean)(pausedRef.current) : next;
    pausedRef.current = value;
    persistPrefs(value, scope, modeRef.current);
    if (value) {
      haltAutomation("Paused — queued navigation and page analysis were stopped.", { pause: true });
      return;
    }
    setPausedState(false);
    setResearchActivity("Resuming on this page…");
  }, [haltAutomation, persistPrefs, scope]);

  const setScope = useCallback((next: SnapshotScope) => {
    setScopeState(next);
    persistPrefs(pausedRef.current, next, modeRef.current);
  }, [persistPrefs]);

  const setMode = useCallback((next: CopilotMode) => {
    modeRef.current = next;
    if (next !== "auto") {
      haltAutomation("Manual mode — auto navigation stopped.");
    }
    setModeState(next);
    persistPrefs(pausedRef.current, scope, next);
  }, [haltAutomation, persistPrefs, scope]);

  // Listen for SESSION_STARTED broadcasts from popup → service worker → tabs.
  useEffect(() => {
    const handler = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; session?: CopilotSession };
      if (m.type === "SESSION_STARTED" && m.session) {
        setSession(m.session);
        setSnippets((m.session.metadata?.acceptedSnippets ?? []) as AcceptedSnippet[]);
        const d = (m.session.metadata as Record<string, unknown> | null)?.auto_draft as
          | { snippets?: AutoDraftSnippet[] }
          | undefined;
        setAutoDraft(Array.isArray(d?.snippets) ? d!.snippets! : []);
        setSuggestions([]);
        setError(null);
        setAutoSteeringDirty(false);
        lastObserveSuccessAtRef.current = Date.now();
        setResearchActivity("Getting oriented on this page…");
        setInfo("Session started — watching this page.");
      }
      if (m.type === "SESSION_ENDED") {
        haltAutomation("Session ended.");
        setSession(null);
        setSuggestions([]);
        setSnippets([]);
        setAutoDraft([]);
        setShowReview(false);
        setReviewState({});
        setResearchActivity("Watching this page — updates will show here.");
        setInfo("Session ended.");
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [haltAutomation]);

  const refreshSession = useCallback(async () => {
    try {
      const res = await send<SessionResponse>({ type: "GET_ACTIVE_SESSION" });
      if (res.session) {
        setSession(res.session);
        setSnippets((res.session.metadata?.acceptedSnippets ?? []) as AcceptedSnippet[]);
        const d = (res.session.metadata as Record<string, unknown> | null)?.auto_draft as
          | { snippets?: AutoDraftSnippet[] }
          | undefined;
        setAutoDraft(Array.isArray(d?.snippets) ? d!.snippets! : []);
      } else {
        setSession(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  /** After navigation, reload session from server so auto_draft survives tab reloads. */
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  /** If the page loaded before the service worker finished waking, retry active-session hydration briefly. */
  useEffect(() => {
    if (sessionId) return;
    let attempts = 0;
    const t = window.setInterval(() => {
      attempts += 1;
      void refreshSession();
      if (attempts >= 10) window.clearInterval(t);
    }, 1500);
    return () => window.clearInterval(t);
  }, [sessionId, refreshSession]);

  const startSessionForActiveDeal = useCallback(async () => {
    if (!activeDeal) {
      setError("Open a deal in the Investora Labs tab to start a session.");
      return;
    }
    setBusy("Starting session…");
    setError(null);
    try {
      const res = await send<SessionResponse>({
        type: "START_SESSION",
        dealId: activeDeal.id,
        tabHint: location.hostname,
      });
      if (res.session) {
        setSession(res.session);
        setSnippets((res.session.metadata?.acceptedSnippets ?? []) as AcceptedSnippet[]);
        const d = (res.session.metadata as Record<string, unknown> | null)?.auto_draft as
          | { snippets?: AutoDraftSnippet[] }
          | undefined;
        setAutoDraft(Array.isArray(d?.snippets) ? d!.snippets! : []);
        setSuggestions([]);
        lastObserveSuccessAtRef.current = Date.now();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [activeDeal]);

  const analyzePage = useCallback(async () => {
    if (!sessionId) return;
    if (pausedRef.current) return;
    const snapshot = extractDomSnapshot({ scope: effectiveScope });
    if (snapshot.visible_text.length < 80) return;
    const fp = fingerprintSnapshot(snapshot, effectiveScope);
    const prev = lastSnapshotRef.current;
    if (prev && prev.fingerprint === fp && Date.now() - prev.at < FINGERPRINT_SUPPRESSION_MS) {
      return;
    }
    // Cancel any in-flight analyze before kicking off a new one. The abort is
    // a UI-side cancellation token; the service worker also aborts its own
    // fetch when a newer OBSERVE arrives.
    analyzeAbortRef.current?.abort();
    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    setResearchActivity(analyzingActivitySentence(snapshot, effectiveSteeringHint ?? ""));
    setBusy("Analyzing…");
    setError(null);
    try {
      const res = await send<ObserveResponse>({
        type: "OBSERVE",
        snapshot,
        clientMode: modeRef.current,
        ...(effectiveSteeringHint ? { steeringHint: effectiveSteeringHint } : {}),
      });
      if (controller.signal.aborted || pausedRef.current) return;
      lastSnapshotRef.current = { fingerprint: fp, at: Date.now() };
      setResearchActivity(observeFollowUpSentence(res.suggestions ?? []));
      setSuggestions((prev) => {
        const seenIds = new Set(prev.map((s) => s.event_id ?? s.client_id));
        const seenKeys = new Set(prev.map((s) => suggestionKey(s)));
        const fresh = (res.suggestions ?? []).filter((s) => {
          const id = s.event_id ?? s.client_id;
          if (seenIds.has(id)) return false;
          const key = suggestionKey(s);
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
        return [...fresh, ...prev].slice(0, MAX_VISIBLE_SUGGESTIONS);
      });
      lastObserveSuccessAtRef.current = Date.now();
    } catch (e) {
      if (controller.signal.aborted) return;
      const msg = (e as Error)?.message || "";
      if (/abort/i.test(msg)) return;
      // Service worker rate-limits observes; not user-error.
      if (/slow down/i.test(msg)) return;
      setError(msg);
    } finally {
      if (analyzeAbortRef.current === controller) {
        analyzeAbortRef.current = null;
        setBusy(null);
      }
    }
  }, [sessionId, effectiveScope, effectiveSteeringHint]);

  useEffect(() => {
    if (mode !== "auto" || !session) return;
    if (paused) {
      setResearchActivity("Paused — resume when you're ready to continue.");
      return;
    }
    setResearchActivity((prev) => (/^Paused\b/i.test(prev) ? "Resuming on this page…" : prev));
  }, [mode, session?.id, paused]);

  // Auto-mode: run analyze on URL changes + significant DOM mutations.
  useEffect(() => {
    if (paused || !sessionId) return;
    let timer: number | null = null;
    let lastUrl = location.href;
    const debounced = () => {
      if (timer != null) window.clearTimeout(timer);
      const ms = lastSnapshotRef.current ? ANALYZE_DEBOUNCE_MS : FIRST_ANALYZE_DEBOUNCE_MS;
      timer = window.setTimeout(() => {
        if (pausedRef.current) return;
        analyzePage();
      }, ms);
    };
    const onUrl = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // New page: clear stale cards, drop fingerprint so first analyze fires fast.
        setSuggestions([]);
        lastSnapshotRef.current = null;
        setResearchActivity("Loading a new page — will analyze shortly…");
        void refreshSession();
        debounced();
      }
    };
    window.addEventListener("popstate", onUrl);
    const onScroll = () => debounced();
    window.addEventListener("scroll", onScroll, { passive: true });
    const origPush = history.pushState;
    history.pushState = function (...args: Parameters<History["pushState"]>) {
      origPush.apply(history, args);
      onUrl();
    };
    const obs = new MutationObserver((muts) => {
      const total = muts.reduce((acc, m) => acc + m.addedNodes.length + m.removedNodes.length, 0);
      if (total > 6) debounced();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    debounced();
    return () => {
      if (timer != null) window.clearTimeout(timer);
      obs.disconnect();
      window.removeEventListener("popstate", onUrl);
      window.removeEventListener("scroll", onScroll);
      history.pushState = origPush;
    };
  }, [paused, sessionId, analyzePage, refreshSession]);

  // Poll session metadata (e.g. last_synced_at) while researching.
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setInterval(() => void refreshSession(), 90_000);
    return () => window.clearInterval(t);
  }, [sessionId, refreshSession]);

  // Auto-end session after long idle (no successful observe) while snippets exist.
  useEffect(() => {
    if (!sessionId || paused) return;
    const t = window.setInterval(() => {
      if (snippets.length === 0) return;
      if (Date.now() - lastObserveSuccessAtRef.current < OBSERVE_IDLE_END_MS) return;
      void send({ type: "END_SESSION" }).catch(() => {});
    }, 60_000);
    return () => window.clearInterval(t);
  }, [sessionId, paused, snippets.length]);

  const decide = useCallback(async (
    suggestion: Suggestion,
    action: "accept" | "reject",
    opts?: { silent?: boolean; auto?: boolean },
  ) => {
    if (!sessionId || !suggestion.event_id) return;
    const sid = suggestion.event_id;
    setError(null);
    setSuggestions((prev) => prev.filter((s) => s.event_id !== sid));
    if (action === "accept") {
      if (opts?.auto) highlightAcceptedSnippet(suggestion.snippet);
      setSnippets((prev) => [
        ...prev,
        {
          text: suggestion.snippet,
          source_label: suggestion.source_label,
          hostname: suggestion.hostname ?? null,
          source_url: location.href,
          accepted_at: new Date().toISOString(),
          suggestion_event_id: sid,
        },
      ]);
    }
    try {
      await send({
        type: "DECISION",
        suggestionEventId: sid,
        action,
        sourceUrl: location.href,
      });
      void refreshSession();
      if (!opts?.silent) {
        setInfo(action === "accept" ? "Saved to deal." : null);
      }
    } catch (e) {
      setSuggestions((prev) => (prev.some((s) => s.event_id === sid) ? prev : [...prev, suggestion]));
      if (action === "accept") {
        setSnippets((prev) => prev.filter((sn) => sn.suggestion_event_id !== sid));
      }
      setError((e as Error).message);
    }
  }, [sessionId, refreshSession]);

  const autoDraftOp = useCallback(async (payload: ExtensionRequest & { type: "AUTO_DRAFT_OP" }) => {
    const res = await send<AutoDraftResponse>(payload);
    setAutoDraft(res.draft?.snippets ?? []);
    return res.draft?.snippets ?? [];
  }, []);

  const submitPrompt = useCallback(async () => {
    if (!sessionId || !promptText.trim() || mode === "auto") return;
    const text = promptText.trim();
    setBusy("Asking…");
    setError(null);
    try {
      const snapshot = extractDomSnapshot({ scope: effectiveScope });
      const res = await send<PromptResponse>({ type: "PROMPT", text, snapshot });
      setSuggestions((prev) => {
        const seenIds = new Set(prev.map((s) => s.event_id ?? s.client_id));
        const seenKeys = new Set(prev.map((s) => suggestionKey(s)));
        const fresh = (res.suggestions ?? []).filter((s) => {
          const id = s.event_id ?? s.client_id;
          if (seenIds.has(id)) return false;
          const key = suggestionKey(s);
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
        return [...fresh, ...prev].slice(0, MAX_VISIBLE_SUGGESTIONS);
      });
      setInfo(res.reply ?? null);
      setPromptText("");
      setTab("suggestions");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [sessionId, promptText, effectiveScope, mode]);

  const applyAutoSteering = useCallback(async () => {
    if (!sessionId) return;
    setResearchActivity("Saving your research focus…");
    setSteeringSaving(true);
    setError(null);
    try {
      const res = await send<SessionResponse>({ type: "SET_AUTO_STEERING", note: autoSteeringDraft.trim() });
      setAutoSteeringDirty(false);
      if (res.session) setSession(res.session);
      setInfo("Focus saved — analysis and link choices follow this.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSteeringSaving(false);
    }
  }, [sessionId, autoSteeringDraft]);

  const clearAutoSteering = useCallback(async () => {
    if (!sessionId) return;
    setResearchActivity("Clearing saved focus…");
    setSteeringSaving(true);
    setError(null);
    try {
      const res = await send<SessionResponse>({ type: "SET_AUTO_STEERING", note: "" });
      setAutoSteeringDraft("");
      setAutoSteeringDirty(false);
      try {
        chrome.storage?.local?.remove(STEERING_LOCAL_KEY);
      } catch {
        /* ignore */
      }
      if (res.session) setSession(res.session);
      setInfo("Steering cleared.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSteeringSaving(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || paused || mode !== "auto" || busy) return;
    if (pendingNav) return;
    const run = async () => {
      const runGeneration = automationGenerationRef.current;
      const stopped = () =>
        pausedRef.current || modeRef.current !== "auto" || automationGenerationRef.current !== runGeneration;
      if (stopped()) return;
      // Do not auto-reject contradict cards (felt arbitrary); skip them for accepts and let the planner run.
      const autoAccept = suggestions.filter(
        (s) =>
          !!s.event_id &&
          s.kind !== "contradicts" &&
          s.kind !== "explore" &&
          (s.confidence ?? 0) >= AGENT_AUTO_ACCEPT_MIN_CONFIDENCE,
      );
      const draftKeys = new Set(autoDraft.map((sn) => suggestionKey({ summary: "", snippet: sn.text })));
      const textsForDedupe = [...autoDraft.map((sn) => sn.text), ...snippets.map((sn) => sn.text)];
      for (const s of autoAccept) {
        if (stopped()) return;
        const key = suggestionKey(s);
        if (draftKeys.has(key)) continue;
        if (isNearDuplicateDraftSnippet(s.snippet, textsForDedupe)) continue;
        draftKeys.add(key);
        textsForDedupe.push(s.snippet);
        setResearchActivity(suggestionPickSentence(s));
        highlightAcceptedSnippet(s.snippet);
        await autoDraftOp({
          type: "AUTO_DRAFT_OP",
          op: "append",
          snippet: {
            id: s.event_id ?? s.client_id,
            text: s.snippet,
            source_label: s.source_label,
            hostname: s.hostname ?? null,
            source_url: location.href,
            accepted_at: new Date().toISOString(),
            suggestion_event_id: s.event_id ?? null,
            confidence: s.confidence ?? null,
            kind: s.kind,
            from_suggestion_event_id: s.event_id ?? null,
          },
        });
        if (stopped()) return;
        setSuggestions((prev) => prev.filter((x) => (x.event_id ?? x.client_id) !== (s.event_id ?? s.client_id)));
      }
      if (stopped()) return;
      const snapshot = extractDomSnapshot({ scope: effectiveScope });
      const copilotExploreLinks = suggestions
        .filter((s) => s.kind === "explore" && typeof s.link_url === "string" && s.link_url.trim())
        .map((s) => ({
          url: s.link_url!.trim(),
          text: (s.summary || s.snippet || "Explore").trim().slice(0, 160),
        }))
        .slice(0, 10);
      const href = location.href;
      const pendingSuggestionsCount = suggestions.filter(
        (s) => !!s.event_id && s.kind !== "explore" && s.kind !== "contradicts",
      ).length;
      const draftItemsThisUrl = autoDraft.filter((sn) => (sn.source_url || "") === href).length;
      const plan_page_context = {
        visible_text_chars: snapshot.visible_text.length,
        scroll_depth_ratio: scrollDepthRatio(),
        draft_items_this_url: draftItemsThisUrl,
        pending_suggestions_count: pendingSuggestionsCount,
        /** Lets server stop deferring navigate after repeated scroll-without-yield (e.g. Wikipedia citations). */
        consecutive_plan_scrolls: agentScrollStreakRef.current,
      };
      setResearchActivity("Thinking about what page to visit next…");
      const res = await send<PlanNextResponse>({
        type: "PLAN_NEXT",
        snapshot,
        currentUrl: href,
        plan_page_context,
        ...(copilotExploreLinks.length ? { copilotExploreLinks } : {}),
        ...(effectiveSteeringHint ? { steeringHint: effectiveSteeringHint } : {}),
      });
      if (stopped()) return;
      if (res.next.action === "scroll") {
        agentScrollStreakRef.current += 1;
        if (agentScrollStreakRef.current > 8) {
          agentScrollStreakRef.current = 0;
          lastSnapshotRef.current = null;
          setResearchActivity("Pausing auto-scroll — waiting for new content or your steering note.");
          window.setTimeout(() => setPostScrollPlannerKick((k) => k + 1), 400);
          return;
        }
        if (scrollKickTimerRef.current != null) {
          window.clearTimeout(scrollKickTimerRef.current);
          scrollKickTimerRef.current = null;
        }
        setResearchActivity("Scrolling to read more of this page…");
        lastSnapshotRef.current = null;
        window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: "smooth" });
        scrollKickTimerRef.current = window.setTimeout(() => {
          scrollKickTimerRef.current = null;
          if (stopped()) return;
          setResearchActivity("Re-reading the page after scrolling…");
          void analyzePage();
          setPostScrollPlannerKick((k) => k + 1);
        }, 1700);
        return;
      }
      agentScrollStreakRef.current = 0;
      if (res.next.action === "stop") {
        // Use the server's rationale — it explains real reasons (defer/wait, no candidates,
        // model asked for steering). A generic "wait for magic" line misleads users when
        // there is nothing to scroll or navigate to.
        const why = res.next.rationale?.trim();
        setResearchActivity(
          why
            ? truncateWords(why, 140)
            : "Stopped — nothing to scroll or open from here. Try a steering note or another source.",
        );
        setInfo(
          why
            ? `Auto: ${truncateWords(why, 180)}`
            : "Auto: open a page with useful links, accept explore suggestions, or add steering — idle waiting won't surface new options.",
        );
        return;
      }
      if (stopped()) return;
      if (res.next.action === "navigate" && res.next.url) {
        const rationale = res.next.rationale?.trim();
        let host = "the next page";
        try {
          host = new URL(res.next.url).hostname || host;
        } catch {
          /* ignore */
        }
        setResearchActivity(
          rationale
            ? `Preparing to follow a link: ${truncateWords(rationale, 96)}`
            : `Preparing to open ${truncateWords(host, 48)}…`,
        );
        setPendingNav({ url: res.next.url, rationale: res.next.rationale, at: Date.now() });
      }
    };
    void run().catch((e) => {
      setResearchActivity("Hit a snag while planning the next step — will retry when things update.");
      setError((e as Error).message);
    });
  }, [
    sessionId,
    paused,
    mode,
    busy,
    pendingNav,
    suggestions,
    autoDraft,
    autoDraftOp,
    effectiveScope,
    decide,
    analyzePage,
    postScrollPlannerKick,
    effectiveSteeringHint,
  ]);

  useEffect(() => {
    if (!pendingNav || mode !== "auto" || paused) return;
    if (pendingNavTimerRef.current != null) {
      window.clearTimeout(pendingNavTimerRef.current);
      pendingNavTimerRef.current = null;
    }
    const navGeneration = automationGenerationRef.current;
    pendingNavTimerRef.current = window.setTimeout(() => {
      pendingNavTimerRef.current = null;
      if (pausedRef.current || modeRef.current !== "auto" || automationGenerationRef.current !== navGeneration) return;
      window.location.assign(pendingNav.url);
    }, AGENT_NAV_COUNTDOWN_MS);
    return () => {
      if (pendingNavTimerRef.current != null) {
        window.clearTimeout(pendingNavTimerRef.current);
        pendingNavTimerRef.current = null;
      }
    };
  }, [pendingNav, mode, paused]);

  useEffect(() => {
    if (session && mode === "auto") return;
    setPendingNav(null);
    if (pendingNavTimerRef.current != null) {
      window.clearTimeout(pendingNavTimerRef.current);
      pendingNavTimerRef.current = null;
    }
  }, [session, mode]);

  const headerLabel = useMemo(() => {
    const sessionCompany = companyNameFromSession(session);
    if (session) return `${sessionCompany || activeDeal?.name || "Selected company"} • researching`;
    if (activeDeal) return `${activeDeal.name} • idle`;
    return "Investora Labs copilot";
  }, [session, activeDeal]);

  // Drag the header.
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startRight: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest("button")) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: pos.top,
      startRight: pos.right,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setPos({
      top: Math.max(0, d.startTop + dy),
      right: Math.max(0, d.startRight - dx),
    });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const showSnippetsBuffer = (snippets ?? []).length > 0;

  // Keep listeners/hooks active, but do not render any overlay chrome unless a
  // copilot session is actually active.
  if (isAppContext() || !session) return null;

  return (
    <div
      className={`root${collapsed ? " collapsed" : ""}`}
      style={{ top: `${pos.top}px`, right: `${pos.right}px` }}
    >
      <div
        className="header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="header-title">
          <span className={`dot${session ? " active" : ""}`} aria-hidden="true" />
          <span>{headerLabel}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button className={`mode-btn${mode === "manual" ? " active" : ""}`} onClick={() => setMode("manual")}>
            Manual
          </button>
          <button
            className={`mode-btn${mode === "auto" ? " active" : ""}`}
            onClick={() => setMode("auto")}
            disabled={!session}
            title={!session ? "Start a session first" : "Auto research this page and follow links"}
          >
            Auto
          </button>
          <button
            className="icon-btn"
            title={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? "▾" : "▴"}
          </button>
        </div>
      </div>

      {error ? <div className="banner">{error}</div> : null}
      {info && !error ? <div className="banner info">{info}</div> : null}

      {!collapsed ? (
        <>
          {mode !== "auto" ? (
            <div className="company-status">
              <span className="company-status-label">Researching</span>
              <span className="company-status-name">{companyNameFromSession(session) || activeDeal?.name || "Selected company"}</span>
            </div>
          ) : null}

          {mode !== "auto" && session ? (
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="label" style={{ marginTop: 0 }}>
                Focus
              </div>
              <p className="notice" style={{ marginBottom: 8, fontSize: 11 }}>
                Guides page analysis and suggestions. You can type here before clicking Apply — it is sent on each analyze without saving.
              </p>
              <textarea
                className="prompt-input"
                rows={2}
                placeholder="HQ, funding, team, competitors…"
                value={autoSteeringDraft}
                onChange={(e) => {
                  setAutoSteeringDraft(e.target.value);
                  setAutoSteeringDirty(true);
                }}
              />
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => void applyAutoSteering()}
                  disabled={
                    steeringSaving ||
                    (!autoSteeringDirty && autoSteeringDraft.trim() === serverAutoSteering.trim())
                  }
                >
                  {steeringSaving ? "Saving…" : "Apply focus"}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void clearAutoSteering()}
                  disabled={steeringSaving || (!serverAutoSteering && !autoSteeringDraft.trim())}
                >
                  Clear
                </button>
              </div>
            </div>
          ) : null}

          {mode !== "auto" ? (
            <div className="tabs">
              <button
                className={`tab${tab === "suggestions" ? " active" : ""}`}
                onClick={() => setTab("suggestions")}
              >
                Suggestions ({suggestions.length}
                {showSnippetsBuffer ? ` · ${snippets.length} accepted` : ""})
              </button>
              <button className={`tab${tab === "ask" ? " active" : ""}`} onClick={() => setTab("ask")}>
                Ask
              </button>
            </div>
          ) : null}

            <div className="body">
            {mode === "auto" && session ? (
              <>
                <div className="company-status in-body">
                  <span className="company-status-label">Researching</span>
                  <span className="company-status-name">{companyNameFromSession(session) || activeDeal?.name || "Selected company"}</span>
                </div>
                <div className="agent-banner agent-activity" role="status" aria-live="polite" aria-atomic="true">
                  {researchActivity}
                </div>
                <div className="card" style={{ marginBottom: 10 }}>
                  <div className="label" style={{ marginTop: 0 }}>
                    Focus
                  </div>
                  <p className="notice" style={{ marginBottom: 8, fontSize: 11 }}>
                    Typed focus is used on each step immediately; Apply saves it to the session for sync and tab reloads.
                  </p>
                  <textarea
                    className="prompt-input"
                    rows={2}
                    placeholder="HQ, funding, team, competitors…"
                    value={autoSteeringDraft}
                    onChange={(e) => {
                      setAutoSteeringDraft(e.target.value);
                      setAutoSteeringDirty(true);
                    }}
                  />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      className="btn primary"
                      type="button"
                      onClick={() => void applyAutoSteering()}
                      disabled={
                        steeringSaving ||
                        (!autoSteeringDirty && autoSteeringDraft.trim() === serverAutoSteering.trim())
                      }
                    >
                      {steeringSaving ? "Saving…" : "Apply focus"}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void clearAutoSteering()}
                      disabled={steeringSaving || (!serverAutoSteering && !autoSteeringDraft.trim())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                {pendingNav ? (
                  <div className="agent-banner warning">
                    <div>Opening {new URL(pendingNav.url).hostname} shortly…</div>
                    <div style={{ fontSize: 11, opacity: 0.85 }}>{pendingNav.rationale ?? "Following source link"}</div>
                    <div className="deal-line" style={{ marginTop: 6 }}>
                      Pause cancels this navigation.
                    </div>
                  </div>
                ) : null}
                <div className="card">
                  <div className="summary">Live Auto Draft ({autoDraft.length})</div>
                  {autoDraft.length === 0 ? (
                    <div className="notice">Facts the agent saves from each page show up here.</div>
                  ) : (
                    autoDraft
                      .slice()
                      .reverse()
                      .map((sn) => (
                        <div className="snippet-row" key={sn.id}>
                          <div className="meta">
                            <span>{sn.source_label || sn.hostname || "snippet"}</span>
                            <span>•</span>
                            <span>{new Date(sn.accepted_at).toLocaleTimeString()}</span>
                          </div>
                          <div>{sn.text}</div>
                        </div>
                      ))
                  )}
                </div>
              </>
            ) : null}

            {mode !== "auto" && tab === "suggestions" && session ? (
              <>
                {suggestions.length === 0 ? (
                  <div className="notice">
                    Watching this page; suggestions will appear here.
                  </div>
                ) : (
                  suggestions.map((s) => (
                    <SuggestionCard
                      key={s.event_id ?? s.client_id}
                      suggestion={s}
                      onDecide={decide}
                      onOpenLink={(sg) => {
                        void send({
                          type: "PREFERENCE_SIGNAL",
                          action: "open_link",
                          url: sg.link_url ?? undefined,
                          task: sg.summary,
                          summary: sg.summary,
                          snippet: sg.snippet,
                        }).catch(() => {});
                        if (sg.link_url) window.open(sg.link_url, "_blank", "noopener,noreferrer");
                        setSuggestions((prev) => prev.filter((x) => (x.event_id ?? x.client_id) !== (sg.event_id ?? sg.client_id)));
                      }}
                      disabled={busy === "Asking…"}
                    />
                  ))
                )}
                {showSnippetsBuffer ? (
                  <div style={{ marginTop: suggestions.length > 0 ? 12 : 0 }}>
                    <p className="label" style={{ margin: "0 0 6px" }}>
                      Accepted this session
                    </p>
                    {snippets
                      .slice()
                      .reverse()
                      .map((sn, i) => (
                        <div className="snippet-row" key={`${sn.suggestion_event_id ?? i}`}>
                          <div className="meta">
                            <span>{sn.source_label || sn.hostname || "snippet"}</span>
                            <span>•</span>
                            <span>{new Date(sn.accepted_at).toLocaleTimeString()}</span>
                          </div>
                          <div>{sn.text}</div>
                        </div>
                      ))}
                    <div className="deal-line" style={{ marginTop: 8 }}>
                      {lastSyncedAt
                        ? `Auto-saved · last sync ${new Date(lastSyncedAt).toLocaleString()}`
                        : "Accepted items sync to the deal in the background."}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {mode !== "auto" && tab === "ask" && session ? (
              <div>
                <label className="label" htmlFor="prompt">
                  Ask the copilot
                </label>
                <textarea
                  id="prompt"
                  className="prompt-input"
                  rows={3}
                  placeholder="e.g. add the 2025 revenue stats from this page"
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                />
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn primary" onClick={submitPrompt} disabled={!promptText.trim() || !!busy}>
                    {busy ?? "Send"}
                  </button>
                </div>
              </div>
            ) : null}

            {showReview ? (
              <div className="review-panel">
                <div className="label" style={{ marginTop: 0 }}>
                  Review auto draft before ending
                </div>
                {autoDraft.map((sn) => (
                  <div key={sn.id} style={{ marginBottom: 8 }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={reviewState[sn.id]?.checked ?? true}
                        onChange={(e) =>
                          setReviewState((prev) => ({
                            ...prev,
                            [sn.id]: { checked: e.target.checked, text: prev[sn.id]?.text ?? sn.text },
                          }))
                        }
                      />
                      <span style={{ fontSize: 11 }}>{sn.source_label || sn.hostname || "snippet"}</span>
                    </label>
                    <textarea
                      className="prompt-input"
                      rows={2}
                      value={reviewState[sn.id]?.text ?? sn.text}
                      onChange={(e) =>
                        setReviewState((prev) => ({
                          ...prev,
                          [sn.id]: { checked: prev[sn.id]?.checked ?? true, text: e.target.value },
                        }))
                      }
                    />
                  </div>
                ))}
                <div className="review-panel-actions">
                  <div className="row">
                    <button
                      className="btn primary"
                      disabled={busy === "Ending…"}
                      onClick={async () => {
                        haltAutomation("Ending session — saving reviewed facts first.", { pause: true });
                        setBusy("Ending…");
                        setError(null);
                        try {
                          for (const sn of autoDraft) {
                            const edited = reviewState[sn.id];
                            if (!edited) continue;
                            if (!edited.checked) {
                              await autoDraftOp({ type: "AUTO_DRAFT_OP", op: "remove", id: sn.id });
                              continue;
                            }
                            if (edited.text.trim() && edited.text.trim() !== sn.text) {
                              await autoDraftOp({ type: "AUTO_DRAFT_OP", op: "edit", id: sn.id, text: edited.text.trim() });
                            }
                          }
                          await autoDraftOp({ type: "AUTO_DRAFT_OP", op: "approve" });
                          await send({ type: "END_SESSION" });
                          setShowReview(false);
                          setReviewState({});
                          setSession(null);
                          setSuggestions([]);
                          setSnippets([]);
                          setAutoDraft([]);
                          pausedRef.current = false;
                          setPausedState(false);
                          setMode("manual");
                          setInfo("Approved auto draft and ended session.");
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === "Ending…" ? "Ending…" : "Approve & End"}
                    </button>
                    <button
                      className="btn ghost"
                      disabled={busy === "Ending…"}
                      onClick={async () => {
                        haltAutomation("Ending session — discarding draft.", { pause: true });
                        setBusy("Ending…");
                        setError(null);
                        try {
                          await autoDraftOp({ type: "AUTO_DRAFT_OP", op: "discard" });
                          await send({ type: "END_SESSION" });
                          setShowReview(false);
                          setReviewState({});
                          setSession(null);
                          setSuggestions([]);
                          setSnippets([]);
                          setAutoDraft([]);
                          pausedRef.current = false;
                          setPausedState(false);
                          setMode("manual");
                          setInfo("Discarded auto draft and ended session.");
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Discard & End
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {session ? (
            <div className="toolbar">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setPaused((v) => !v);
                }}
              >
                {paused ? "Resume" : "Pause"}
              </button>
              {mode !== "auto" ? (
                <button className="btn" onClick={() => setScope(scope === "viewport" ? "full" : "viewport")} disabled={!!busy}>
                  Scope: {scope}
                </button>
              ) : null}
              {mode === "auto" ? (
                <button
                  className="btn"
                  onClick={() => {
                    haltAutomation("Reviewing saved facts — auto navigation stopped.", { pause: true });
                    const next: DraftReview = {};
                    for (const sn of autoDraft) next[sn.id] = { checked: true, text: sn.text };
                    setReviewState(next);
                    setShowReview(true);
                  }}
                >
                  End & Review
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  onDecide,
  onOpenLink,
  disabled,
}: {
  suggestion: Suggestion;
  onDecide: (s: Suggestion, action: "accept" | "reject") => void;
  onOpenLink: (s: Suggestion) => void;
  disabled: boolean;
}) {
  const kindClass = `kind-pill kind-${suggestion.kind}`;
  const exploreUrl = suggestion.kind === "explore" && suggestion.link_url ? suggestion.link_url : null;
  const exploreUrlLabel = exploreUrl
    ? (() => {
        const disp = exploreUrl.replace(/^https?:\/\//i, "");
        return disp.length > 72 ? `${disp.slice(0, 72)}…` : disp;
      })()
    : null;
  return (
    <div className="card">
      <div className={kindClass}>{suggestion.kind}</div>
      <div className="summary">{suggestion.summary}</div>
      <div className="snippet">{suggestion.snippet}</div>
      {exploreUrl && exploreUrlLabel ? (
        <a
          className="link-hint"
          href={exploreUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {exploreUrlLabel}
        </a>
      ) : null}
      {suggestion.kind === "contradicts" ? (
        <div className="notice" style={{ marginTop: 8 }}>
          Contradiction detected. Which value should we keep?
        </div>
      ) : null}
      <div className="meta">
        <span>{suggestion.source_label || suggestion.hostname || "screen"}</span>
        <span>•</span>
        <span>{Math.round((suggestion.confidence ?? 0) * 100)}%</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {suggestion.kind === "explore" ? (
          <button className="btn primary" disabled={disabled || !suggestion.link_url} onClick={() => onOpenLink(suggestion)}>
            Open link
          </button>
        ) : suggestion.kind === "contradicts" ? (
          <button className="btn primary" disabled={disabled} onClick={() => onDecide(suggestion, "accept")}>
            Keep new value
          </button>
        ) : (
          <button className="btn primary" disabled={disabled} onClick={() => onDecide(suggestion, "accept")}>
            Save to deal
          </button>
        )}
        <button className="btn ghost" disabled={disabled} onClick={() => onDecide(suggestion, "reject")}>
          {suggestion.kind === "contradicts" ? "Keep current value" : "Skip"}
        </button>
      </div>
    </div>
  );
}
