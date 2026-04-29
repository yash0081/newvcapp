export type CopilotSessionStatus = "active" | "finalized" | "abandoned";

export type AcceptedSnippet = {
  text: string;
  source_label: string;
  hostname?: string | null;
  source_url?: string | null;
  accepted_at: string;
  /** id of the originating copilot_event(suggestion) row, when known. */
  suggestion_event_id?: string | null;
};

export type CopilotSession = {
  id: string;
  deal_id: string;
  user_id: string;
  status: CopilotSessionStatus;
  started_at: string;
  ended_at: string | null;
  finalized_document_id: string | null;
  metadata: {
    acceptedSnippets?: AcceptedSnippet[];
    tab_hint?: string | null;
    last_observed_hostname?: string | null;
    [k: string]: unknown;
  } | null;
};

export type ExtractedKeyValue = {
  key: string;
  value: string;
  confidence: number;
};

export type Extracted = {
  visible_text: string;
  page_title?: string;
  hostname?: string;
  key_value_claims: ExtractedKeyValue[];
  outbound_links?: Array<{ url: string; text: string }>;
};

export type SuggestionKind = "new" | "aligns" | "contradicts" | "explore";

export type Suggestion = {
  /** Stable client-side id; mirrored to the persisted suggestion event. */
  client_id: string;
  summary: string;
  snippet: string;
  kind: SuggestionKind;
  confidence: number;
  source_label: string;
  hostname?: string | null;
  link_url?: string | null;
};

export type CopilotEventKind =
  | "observation"
  | "suggestion"
  | "accepted"
  | "rejected"
  | "prompt"
  | "reply"
  | "error";

export type CopilotEvent = {
  id: string;
  session_id: string;
  kind: CopilotEventKind;
  payload: Record<string, unknown>;
  hostname: string | null;
  parent_event_id: string | null;
  created_at: string;
};
