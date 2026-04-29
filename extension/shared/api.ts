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

export async function startSession(dealId: string, tabHint?: string): Promise<CopilotSession> {
  const data = await apiFetch<{ session: CopilotSession }>(`/api/copilot/sessions`, {
    method: "POST",
    body: JSON.stringify({ dealId, tabHint }),
  });
  return data.session;
}

export async function observeText(
  sessionId: string,
  snapshot: DomSnapshot,
  signal?: AbortSignal,
): Promise<{ suggestions: Suggestion[]; observationEventId?: string }> {
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
    }),
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
  snippet?: Omit<AcceptedSnippet, "accepted_at">,
): Promise<void> {
  await apiFetch(`/api/copilot/sessions/${sessionId}/decision`, {
    method: "POST",
    body: JSON.stringify({ suggestionEventId, action, snippet }),
  });
}

export async function finalize(sessionId: string): Promise<{ documentId: string | null }> {
  return apiFetch<{ documentId: string | null }>(`/api/copilot/sessions/${sessionId}/finalize`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
