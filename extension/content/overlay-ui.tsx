import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveDealResponse,
  ExtensionRequest,
  FinalizeResponse,
  ObserveResponse,
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
import { suggestionRepeatKey } from "@shared/repeat-key";

const APP_HOSTNAME_RE = /^chrome-extension:|^moz-extension:/;
const PREFS_KEY = "vcapp_overlay_prefs";
const FINGERPRINT_SUPPRESSION_MS = 5000;
const MAX_VISIBLE_SUGGESTIONS = 6;
const FIRST_ANALYZE_DEBOUNCE_MS = 800;
const ANALYZE_DEBOUNCE_MS = 1500;

function isAppContext(): boolean {
  return APP_HOSTNAME_RE.test(location.protocol);
}

function suggestionKey(s: Pick<Suggestion, "summary" | "snippet">): string {
  return suggestionRepeatKey(s.summary ?? "", s.snippet ?? "");
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

type Tab = "suggestions" | "saved" | "ask";

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
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [scope, setScopeState] = useState<SnapshotScope>("viewport");
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 16, right: 16 });
  const [promptText, setPromptText] = useState("");
  const lastSnapshotRef = useRef<{ fingerprint: string; at: number } | null>(null);
  const analyzeAbortRef = useRef<AbortController | null>(null);

  const sessionId = session?.id ?? null;

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
        }
      });
    } catch {
      // chrome.storage may not exist in some test contexts; default state stands.
    }
  }, []);

  const persistPrefs = useCallback((nextPaused: boolean, nextScope: SnapshotScope) => {
    try {
      chrome.storage?.local?.set({ [PREFS_KEY]: { paused: nextPaused, scope: nextScope } });
    } catch {
      // best-effort; UI still flips
    }
  }, []);

  const setPaused = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setPausedState((prev) => {
      const value = typeof next === "function" ? (next as (p: boolean) => boolean)(prev) : next;
      persistPrefs(value, scope);
      return value;
    });
  }, [persistPrefs, scope]);

  const setScope = useCallback((next: SnapshotScope) => {
    setScopeState(next);
    persistPrefs(paused, next);
  }, [persistPrefs, paused]);

  // Listen for SESSION_STARTED broadcasts from popup → service worker → tabs.
  useEffect(() => {
    const handler = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; session?: CopilotSession };
      if (m.type === "SESSION_STARTED" && m.session) {
        setSession(m.session);
        setSnippets((m.session.metadata?.acceptedSnippets ?? []) as AcceptedSnippet[]);
        setSuggestions([]);
        setError(null);
        setInfo("Session started — watching this page.");
      }
      if (m.type === "SESSION_ENDED") {
        setSession(null);
        setSuggestions([]);
        setSnippets([]);
        setInfo("Session ended.");
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const res = await send<SessionResponse>({ type: "GET_ACTIVE_SESSION" });
      if (res.session) {
        setSession(res.session);
        setSnippets((res.session.metadata?.acceptedSnippets ?? []) as AcceptedSnippet[]);
      } else {
        setSession(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const startSessionForActiveDeal = useCallback(async () => {
    if (!activeDeal) {
      setError("Open a deal in the VCApp tab to start a session.");
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
        setSuggestions([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [activeDeal]);

  const analyzePage = useCallback(async () => {
    if (!sessionId) return;
    const snapshot = extractDomSnapshot({ scope });
    if (snapshot.visible_text.length < 80) return;
    const fp = fingerprintSnapshot(snapshot, scope);
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
    setBusy("Analyzing…");
    setError(null);
    try {
      const res = await send<ObserveResponse>({ type: "OBSERVE", snapshot });
      if (controller.signal.aborted) return;
      lastSnapshotRef.current = { fingerprint: fp, at: Date.now() };
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
    } catch (e) {
      if (controller.signal.aborted) return;
      const msg = (e as Error)?.message || "";
      if (/abort/i.test(msg)) return;
      setError(msg);
    } finally {
      if (analyzeAbortRef.current === controller) {
        analyzeAbortRef.current = null;
        setBusy(null);
      }
    }
  }, [sessionId, scope]);

  // Auto-mode: run analyze on URL changes + significant DOM mutations.
  useEffect(() => {
    if (paused || !sessionId) return;
    let timer: number | null = null;
    let lastUrl = location.href;
    const debounced = () => {
      if (timer != null) window.clearTimeout(timer);
      const ms = lastSnapshotRef.current ? ANALYZE_DEBOUNCE_MS : FIRST_ANALYZE_DEBOUNCE_MS;
      timer = window.setTimeout(() => {
        analyzePage();
      }, ms);
    };
    const onUrl = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // New page: clear stale cards, drop fingerprint so first analyze fires fast.
        setSuggestions([]);
        lastSnapshotRef.current = null;
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
  }, [paused, sessionId, analyzePage]);

  const decide = useCallback(
    async (suggestion: Suggestion, action: "accept" | "reject") => {
      if (!sessionId || !suggestion.event_id) return;
      setBusy(action === "accept" ? "Saving…" : "Skipping…");
      setError(null);
      try {
        await send({
          type: "DECISION",
          suggestionEventId: suggestion.event_id,
          action,
        });
        setSuggestions((prev) => prev.filter((s) => s.event_id !== suggestion.event_id));
        if (action === "accept") {
          setSnippets((prev) => [
            ...prev,
            {
              text: suggestion.snippet,
              source_label: suggestion.source_label,
              hostname: suggestion.hostname ?? null,
              source_url: location.href,
              accepted_at: new Date().toISOString(),
              suggestion_event_id: suggestion.event_id,
            },
          ]);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [sessionId],
  );

  const submitPrompt = useCallback(async () => {
    if (!sessionId || !promptText.trim()) return;
    const text = promptText.trim();
    setBusy("Asking…");
    setError(null);
    try {
      const snapshot = extractDomSnapshot({ scope });
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
  }, [sessionId, promptText, scope]);

  const finalize = useCallback(async () => {
    if (!sessionId) return;
    setBusy("Saving research…");
    setError(null);
    try {
      const res = await send<FinalizeResponse>({ type: "FINALIZE" });
      setSession(null);
      setSuggestions([]);
      setSnippets([]);
      setInfo(
        res.documentId
          ? `Saved ${snippets.length} snippet(s) to deal — facts updated; embeddings queued.`
          : "Session ended without saving (no accepted snippets).",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [sessionId, snippets.length]);

  const headerLabel = useMemo(() => {
    if (session && activeDeal) return `${activeDeal.name} • watching`;
    if (activeDeal) return `${activeDeal.name} • idle`;
    return "VCApp copilot";
  }, [session, activeDeal]);

  // Drag the header.
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startRight: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest(".icon-btn")) return;
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

  const showStartCta = !session;
  const showSnippetsBuffer = (snippets ?? []).length > 0;

  if (isAppContext()) return null;

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
        <div>
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
          <div className="tabs">
            <button
              className={`tab${tab === "suggestions" ? " active" : ""}`}
              onClick={() => setTab("suggestions")}
            >
              Suggestions ({suggestions.length})
            </button>
            <button
              className={`tab${tab === "saved" ? " active" : ""}`}
              onClick={() => setTab("saved")}
            >
              Saved ({snippets.length})
            </button>
            <button className={`tab${tab === "ask" ? " active" : ""}`} onClick={() => setTab("ask")}>
              Ask
            </button>
          </div>

          <div className="body">
            {showStartCta ? (
              <div className="card">
                <div className="summary">No active session</div>
                <div className="snippet">
                  {activeDeal ? (
                    <>
                      Start a session for <strong>{activeDeal.name}</strong>.
                    </>
                  ) : (
                    <>Open a deal in the VCApp tab, then click below.</>
                  )}
                </div>
                <div className="row">
                  <button
                    className="btn primary"
                    onClick={startSessionForActiveDeal}
                    disabled={!activeDeal || !!busy}
                  >
                    {busy ?? "Start session here"}
                  </button>
                  <button className="btn ghost" onClick={refreshSession}>
                    Refresh
                  </button>
                </div>
                <div className="deal-line" style={{ marginTop: 6 }}>
                  Sharing this page's text with VCApp copilot. Pause anytime.
                </div>
              </div>
            ) : null}

            {tab === "suggestions" && session ? (
              suggestions.length === 0 ? (
                <div className="notice">
                  Watching this page; suggestions will appear here.
                </div>
              ) : (
                suggestions.map((s) => (
                  <SuggestionCard key={s.event_id ?? s.client_id} suggestion={s} onDecide={decide} onOpenLink={(sg) => {
                    if (sg.link_url) window.open(sg.link_url, "_blank", "noopener,noreferrer");
                    setSuggestions((prev) => prev.filter((x) => (x.event_id ?? x.client_id) !== (sg.event_id ?? sg.client_id)));
                  }} disabled={!!busy} />
                ))
              )
            ) : null}

            {tab === "saved" && session ? (
              showSnippetsBuffer ? (
                snippets
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
                  ))
              ) : (
                <div className="notice">No snippets saved yet.</div>
              )
            ) : null}

            {tab === "ask" && session ? (
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
          </div>

          {session ? (
            <div className="toolbar">
              <button className="btn" onClick={() => setPaused((v) => !v)} disabled={!!busy}>
                {paused ? "Resume" : "Pause"}
              </button>
              <button className="btn" onClick={() => setScope(scope === "viewport" ? "full" : "viewport")} disabled={!!busy}>
                Scope: {scope}
              </button>
              <button className="btn danger" onClick={finalize} disabled={!!busy}>
                Save research to deal
              </button>
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
  return (
    <div className="card">
      <div className={kindClass}>{suggestion.kind}</div>
      <div className="summary">{suggestion.summary}</div>
      <div className="snippet">{suggestion.snippet}</div>
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
