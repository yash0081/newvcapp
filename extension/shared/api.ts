import { APP_ORIGIN } from "@shared/config";
import type {
  AcceptedSnippet,
  CopilotSession,
  DealListItem,
  DomSnapshot,
  Suggestion,
} from "@shared/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`${APP_ORIGIN}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw err;
    }
    throw new ApiError(`Network error: ${(err as Error).message}`, 0);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
        detail = (body as { error: string }).error;
      }
    } catch {
      // body wasn't JSON; keep statusText
    }
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export async function listDeals(): Promise<DealListItem[]> {
  const data = await apiFetch<{ deals: DealListItem[] }>("/api/copilot/deals");
  return data.deals ?? [];
}

export async function getSessionByDeal(dealId: string): Promise<{
  session: CopilotSession | null;
}> {
  return apiFetch<{ session: CopilotSession | null }>(`/api/copilot/sessions/by-deal/${encodeURIComponent(dealId)}`);
}

export async function getSessionById(sessionId: string): Promise<{
  session: CopilotSession | null;
}> {
  return apiFetch<{ session: CopilotSession | null }>(`/api/copilot/sessions/${encodeURIComponent(sessionId)}`);
}

export async function startSession(dealId: string, tabHint?: string): Promise<CopilotSession> {
  const data = await apiFetch<{ session: CopilotSession }>(`/api/copilot/sessions`, {
    method: "POST",
    body: JSON.stringify({ dealId, tabHint }),
  });
  return data.session;
}

export async function setCopilotSteering(
  sessionId: string,
  note: string,
): Promise<{ ok: boolean; session: CopilotSession | null }> {
  return apiFetch(`/api/copilot/sessions/${encodeURIComponent(sessionId)}/steering`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export async function observeText(
  sessionId: string,
  snapshot: DomSnapshot,
  options?: {
    clientMode?: "manual" | "auto";
    signal?: AbortSignal;
    /** Overrides session-stored steering for this request (extension Focus field). */
    steeringHint?: string;
  },
): Promise<{ suggestions: Suggestion[]; observationEventId?: string }> {
  const clientMode = options?.clientMode;
  const signal = options?.signal;
  const hint = options?.steeringHint?.trim();
  return apiFetch(`/api/copilot/sessions/${sessionId}/observe`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      extracted: {
        visible_text: snapshot.visible_text,
        page_title: snapshot.page_title,
        hostname: snapshot.hostname,
        key_value_claims: snapshot.key_value_claims,
        outbound_links: snapshot.outbound_links ?? [],
      },
      urlHint: snapshot.url,
      hostnameHint: snapshot.hostname,
      clientMode,
      ...(hint ? { steering_hint: hint.slice(0, 2000) } : {}),
    }),
  });
}

export async function planNext(
  sessionId: string,
  snapshot: DomSnapshot,
  currentUrl: string,
  copilotExploreLinks?: Array<{ url: string; text: string }>,
  planPageContext?: {
    visible_text_chars: number;
    scroll_depth_ratio: number;
    draft_items_this_url: number;
    pending_suggestions_count: number;
    consecutive_plan_scrolls?: number;
  },
  steeringHint?: string,
): Promise<{ next: { action: "navigate" | "scroll" | "stop"; url?: string; rationale?: string } }> {
  const hint = steeringHint?.trim();
  return apiFetch(`/api/copilot/sessions/${sessionId}/plan-next`, {
    method: "POST",
    body: JSON.stringify({
      snapshot: {
        visible_text: snapshot.visible_text,
        page_title: snapshot.page_title,
        hostname: snapshot.hostname,
        key_value_claims: snapshot.key_value_claims,
        outbound_links: snapshot.outbound_links ?? [],
      },
      currentUrl,
      ...(copilotExploreLinks?.length ? { copilot_explore_links: copilotExploreLinks } : {}),
      ...(planPageContext ? { plan_page_context: planPageContext } : {}),
      ...(hint ? { steering_hint: hint.slice(0, 2000) } : {}),
    }),
  });
}

export async function autoDraftOp(
  sessionId: string,
  body: {
    op: "append" | "edit" | "remove" | "approve" | "discard";
    snippet?: {
      id?: string;
      text?: string;
      source_label?: string;
      hostname?: string | null;
      source_url?: string | null;
      accepted_at?: string;
      suggestion_event_id?: string | null;
      confidence?: number | null;
      kind?: string | null;
      from_suggestion_event_id?: string | null;
    };
    id?: string;
    text?: string;
    snippetIds?: string[];
  },
): Promise<{
  draft: {
    status: "open" | "approved" | "discarded";
    started_at?: string;
    last_added_at?: string;
    snippets: Array<{
      id: string;
      text: string;
      source_label: string;
      hostname?: string | null;
      source_url?: string | null;
      accepted_at: string;
      suggestion_event_id?: string | null;
      confidence?: number | null;
      kind?: string | null;
      from_suggestion_event_id?: string | null;
    }>;
  };
}> {
  return apiFetch(`/api/copilot/sessions/${sessionId}/auto-draft`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function promptCopilot(
  sessionId: string,
  text: string,
  snapshot?: DomSnapshot,
  signal?: AbortSignal,
): Promise<{ suggestions: Suggestion[]; reply?: string }> {
  return apiFetch(`/api/copilot/sessions/${sessionId}/prompt`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      text,
      ...(snapshot
        ? {
            extracted: {
              visible_text: snapshot.visible_text,
              page_title: snapshot.page_title,
              hostname: snapshot.hostname,
              key_value_claims: snapshot.key_value_claims,
              outbound_links: snapshot.outbound_links ?? [],
            },
            urlHint: snapshot.url,
            hostnameHint: snapshot.hostname,
          }
        : {}),
    }),
  });
}

export async function decide(
  sessionId: string,
  suggestionEventId: string,
  action: "accept" | "reject",
  sourceUrl?: string,
  snippet?: Omit<AcceptedSnippet, "accepted_at">,
): Promise<void> {
  await apiFetch(`/api/copilot/sessions/${sessionId}/decision`, {
    method: "POST",
    body: JSON.stringify({ suggestionEventId, action, sourceUrl, snippet }),
  });
}

export async function recordPreferenceSignal(
  sessionId: string,
  body: {
    action: "manual_visit" | "open_link";
    url?: string;
    domain?: string;
    task?: string;
    summary?: string;
    snippet?: string;
  },
): Promise<void> {
  await apiFetch(`/api/copilot/sessions/${sessionId}/preference`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Ends the active copilot session; document + facts sync run via background jobs. */
export async function endCopilotSession(sessionId: string): Promise<{ ok: boolean; ended?: string }> {
  return apiFetch(`/api/copilot/sessions/${sessionId}/end`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
