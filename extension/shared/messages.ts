// All cross-context messages flow through chrome.runtime.sendMessage, so they
// share one tagged-union type. Keep this file dependency-free.

import type { ActiveDealHint, CopilotSession, DealListItem, DomSnapshot, Suggestion } from "@shared/types";

export type ExtensionRequest =
  | { type: "GET_ACTIVE_DEAL" }
  | { type: "LIST_DEALS" }
  | { type: "START_SESSION"; dealId: string; tabHint?: string }
  | { type: "GET_ACTIVE_SESSION" }
  | { type: "OBSERVE"; snapshot: DomSnapshot }
  | {
      type: "PLAN_NEXT";
      snapshot: DomSnapshot;
      currentUrl: string;
      /** Copilot "explore" cards — URLs the planner should prefer for navigation. */
      copilotExploreLinks?: Array<{ url: string; text: string }>;
      /** Signals so the server avoids leaving the page before extraction catches up. */
      plan_page_context?: {
        visible_text_chars: number;
        scroll_depth_ratio: number;
        draft_items_this_url: number;
        pending_suggestions_count: number;
      };
    }
  | {
      type: "AUTO_DRAFT_OP";
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
    }
  | { type: "PROMPT"; text: string; snapshot?: DomSnapshot }
  /** Save natural-language focus for auto mode (observe + plan-next read from session metadata). */
  | { type: "SET_AUTO_STEERING"; note: string }
  | { type: "DECISION"; suggestionEventId: string; action: "accept" | "reject" }
  /** Ends the research session (sync runs in background). Prefer over FINALIZE. */
  | { type: "END_SESSION" }
  /** @deprecated Use END_SESSION — same handler */
  | { type: "FINALIZE" }
  | { type: "OPEN_APP"; path?: string };

export type ExternalExtensionRequest = { type: "OPEN_COPILOT_UI" };

export type ExtensionResponse =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string; status?: number };

export type ActiveDealResponse = { activeDeal: ActiveDealHint | null };
export type ListDealsResponse = { deals: DealListItem[] };
export type SessionResponse = { session: CopilotSession | null };
export type ObserveResponse = { suggestions: Suggestion[]; observationEventId?: string };
export type PlanNextResponse = {
  next: { action: "navigate" | "scroll" | "stop"; url?: string; rationale?: string };
};
export type AutoDraftSnippet = {
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
};
export type AutoDraftResponse = {
  draft: {
    status: "open" | "approved" | "discarded";
    started_at?: string;
    last_added_at?: string;
    snippets: AutoDraftSnippet[];
  };
};
export type PromptResponse = { suggestions: Suggestion[]; reply?: string };
export type FinalizeResponse = { documentId: string | null };
