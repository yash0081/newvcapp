import { ACTIVE_DEAL_COOKIE, APP_ORIGIN, MIN_OBSERVE_SPACING_MS } from "@shared/config";
import {
  autoDraftOp,
  decide,
  endCopilotSession,
  getSessionById,
  getSessionByDeal,
  listDeals,
  observeText,
  planNext,
  promptCopilot,
  setCopilotSteering,
  startSession,
} from "@shared/api";
import type {
  ActiveDealResponse,
  ExtensionRequest,
  ExtensionResponse,
  FinalizeResponse,
  ListDealsResponse,
  ObserveResponse,
  AutoDraftResponse,
  PlanNextResponse,
  PromptResponse,
  SessionResponse,
} from "@shared/messages";
import type { ActiveDealHint, CopilotSession } from "@shared/types";

type ExtensionState = {
  activeSessionId: string | null;
  activeSession: CopilotSession | null;
  lastObserveAt: number;
};

const SESSION_KEY = "active_session_v1";

// Module-scoped per-SW abort handle. The SW is single-threaded, so when a new
// OBSERVE arrives we abort the previous in-flight fetch instead of blocking.
let pendingObserveAbort: AbortController | null = null;

async function loadState(): Promise<ExtensionState> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const raw = stored[SESSION_KEY];
  if (raw && typeof raw === "object" && "activeSessionId" in raw) {
    return raw as ExtensionState;
  }
  return { activeSessionId: null, activeSession: null, lastObserveAt: 0 };
}

async function saveState(state: ExtensionState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: state });
}

async function readActiveDealCookie(): Promise<ActiveDealHint | null> {
  try {
    const cookie = await chrome.cookies.get({ url: APP_ORIGIN, name: ACTIVE_DEAL_COOKIE });
    if (!cookie?.value) return null;
    const decoded = decodeURIComponent(cookie.value);
    const parsed = JSON.parse(decoded) as Partial<ActiveDealHint> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    const name = typeof parsed.name === "string" ? parsed.name : "Deal";
    return { id: parsed.id, name };
  } catch {
    return null;
  }
}

async function broadcastToTabs(msg: { type: "SESSION_STARTED"; session: CopilotSession } | { type: "SESSION_ENDED" }) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {
        // tab may not have a content script; ignore
      });
    }
  } catch {
    // best-effort
  }
}

async function handle(req: ExtensionRequest): Promise<ExtensionResponse> {
  if (!req || typeof req !== "object" || typeof (req as { type?: string }).type !== "string") {
    return { ok: false, error: "Invalid request" };
  }
  try {
    switch (req.type) {
      case "GET_ACTIVE_DEAL": {
        const activeDeal = await readActiveDealCookie();
        const payload: ActiveDealResponse = { activeDeal };
        return { ok: true, payload };
      }
      case "LIST_DEALS": {
        const deals = await listDeals();
        const payload: ListDealsResponse = { deals };
        return { ok: true, payload };
      }
      case "GET_ACTIVE_SESSION": {
        const state = await loadState();
        // Prefer refresh by known active session id. This survives navigation to
        // non-VC pages where active-deal cookie may be unavailable.
        if (state.activeSessionId) {
          try {
            const fresh = await getSessionById(state.activeSessionId);
            const session = fresh.session;
            if (session && session.status === "active") {
              await saveState({
                ...state,
                activeSessionId: session.id,
                activeSession: session,
              });
              const payload: SessionResponse = { session };
              return { ok: true, payload };
            }
            await saveState({ ...state, activeSessionId: null, activeSession: null });
          } catch {
            // fall through
          }
        }
        // Fallback refresh from active deal cookie.
        const activeDeal = await readActiveDealCookie();
        if (activeDeal) {
          try {
            const fresh = await getSessionByDeal(activeDeal.id);
            const session = fresh.session;
            if (session && session.status === "active") {
              await saveState({
                ...state,
                activeSessionId: session.id,
                activeSession: session,
              });
              const payload: SessionResponse = { session };
              return { ok: true, payload };
            }
            await saveState({ ...state, activeSessionId: null, activeSession: null });
            const payload: SessionResponse = { session: null };
            return { ok: true, payload };
          } catch {
            // fall through to cached
          }
        }
        const payload: SessionResponse = { session: state.activeSession };
        return { ok: true, payload };
      }
      case "START_SESSION": {
        const session = await startSession(req.dealId, req.tabHint);
        const state = await loadState();
        await saveState({
          ...state,
          activeSessionId: session.id,
          activeSession: session,
          lastObserveAt: 0,
        });
        await broadcastToTabs({ type: "SESSION_STARTED", session });
        const payload: SessionResponse = { session };
        return { ok: true, payload };
      }
      case "OBSERVE": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        const since = Date.now() - state.lastObserveAt;
        if (since < MIN_OBSERVE_SPACING_MS) {
          return { ok: false, error: `Slow down (wait ${Math.ceil((MIN_OBSERVE_SPACING_MS - since) / 1000)}s)` };
        }
        if (pendingObserveAbort) pendingObserveAbort.abort();
        const controller = new AbortController();
        pendingObserveAbort = controller;
        try {
          const res = await observeText(state.activeSessionId, req.snapshot, controller.signal);
          if (pendingObserveAbort === controller) pendingObserveAbort = null;
          const payload: ObserveResponse = res;
          await saveState({ ...(await loadState()), lastObserveAt: Date.now() });
          return { ok: true, payload };
        } catch (e) {
          if (pendingObserveAbort === controller) pendingObserveAbort = null;
          if ((e as { name?: string })?.name === "AbortError") {
            return { ok: false, error: "aborted" };
          }
          throw e;
        }
      }
      case "PROMPT": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        const res = await promptCopilot(state.activeSessionId, req.text, req.snapshot);
        const payload: PromptResponse = res;
        return { ok: true, payload };
      }
      case "SET_AUTO_STEERING": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        const res = await setCopilotSteering(state.activeSessionId, req.note);
        const fresh = res.session;
        if (fresh) {
          await saveState({
            ...(await loadState()),
            activeSessionId: fresh.id,
            activeSession: fresh,
          });
        }
        const payload: SessionResponse = { session: fresh ?? null };
        return { ok: true, payload };
      }
      case "PLAN_NEXT": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        const res = await planNext(
          state.activeSessionId,
          req.snapshot,
          req.currentUrl,
          req.copilotExploreLinks,
          req.plan_page_context,
        );
        const payload: PlanNextResponse = res;
        return { ok: true, payload };
      }
      case "AUTO_DRAFT_OP": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        const res = await autoDraftOp(state.activeSessionId, {
          op: req.op,
          snippet: req.snippet,
          id: req.id,
          text: req.text,
          snippetIds: req.snippetIds,
        });
        const payload: AutoDraftResponse = res;
        return { ok: true, payload };
      }
      case "DECISION": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        await decide(state.activeSessionId, req.suggestionEventId, req.action);
        const activeDeal = await readActiveDealCookie();
        if (activeDeal) {
          try {
            const fresh = await getSessionByDeal(activeDeal.id);
            if (fresh.session?.status === "active") {
              await saveState({
                ...(await loadState()),
                activeSessionId: fresh.session.id,
                activeSession: fresh.session,
              });
            }
          } catch {
            // ignore
          }
        }
        return { ok: true };
      }
      case "END_SESSION":
      case "FINALIZE": {
        const state = await loadState();
        if (!state.activeSessionId) return { ok: false, error: "No active session" };
        try {
          await endCopilotSession(state.activeSessionId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, error: msg };
        }
        await saveState({ ...state, activeSessionId: null, activeSession: null });
        await broadcastToTabs({ type: "SESSION_ENDED" });
        const payload: FinalizeResponse = { documentId: null };
        return { ok: true, payload };
      }
      case "OPEN_APP": {
        const path = typeof req.path === "string" ? req.path : "/";
        await chrome.tabs.create({ url: `${APP_ORIGIN}${path}` });
        return { ok: true };
      }
      default: {
        return { ok: false, error: `Unknown request: ${(req as { type: string }).type}` };
      }
    }
  } catch (e) {
    const err = e as { message?: string; status?: number };
    return { ok: false, error: err?.message || "Unexpected error", status: err?.status };
  }
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  handle(req as ExtensionRequest).then(sendResponse);
  return true; // async response
});
