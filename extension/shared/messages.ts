// All cross-context messages flow through chrome.runtime.sendMessage, so they
// share one tagged-union type. Keep this file dependency-free.

import type { ActiveDealHint, CopilotSession, DealListItem, DomSnapshot, Suggestion } from "@shared/types";

export type ExtensionRequest =
  | { type: "GET_ACTIVE_DEAL" }
  | { type: "LIST_DEALS" }
  | { type: "START_SESSION"; dealId: string; tabHint?: string }
  | { type: "GET_ACTIVE_SESSION" }
  | { type: "OBSERVE"; snapshot: DomSnapshot }
  | { type: "PROMPT"; text: string; snapshot?: DomSnapshot }
  | { type: "DECISION"; suggestionEventId: string; action: "accept" | "reject" }
  | { type: "FINALIZE" }
  | { type: "OPEN_APP"; path?: string };

export type ExtensionResponse =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string; status?: number };

export type ActiveDealResponse = { activeDeal: ActiveDealHint | null };
export type ListDealsResponse = { deals: DealListItem[] };
export type SessionResponse = { session: CopilotSession | null };
export type ObserveResponse = { suggestions: Suggestion[]; observationEventId?: string };
export type PromptResponse = { suggestions: Suggestion[]; reply?: string };
export type FinalizeResponse = { documentId: string | null };
