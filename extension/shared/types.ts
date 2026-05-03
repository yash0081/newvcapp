// A subset of /lib/copilot/types.ts shapes; the extension never imports
// server code so these stay in sync by review.

export type SuggestionKind = "new" | "aligns" | "contradicts" | "explore";

export type Suggestion = {
  client_id: string;
  summary: string;
  snippet: string;
  kind: SuggestionKind;
  confidence: number;
  source_label: string;
  hostname?: string | null;
  event_id?: string;
  link_url?: string | null;
};

export type AcceptedSnippet = {
  text: string;
  source_label: string;
  hostname?: string | null;
  source_url?: string | null;
  accepted_at: string;
  suggestion_event_id?: string | null;
};

export type CopilotSession = {
  id: string;
  deal_id: string;
  user_id: string;
  status: "active" | "finalized" | "abandoned";
  started_at: string;
  ended_at: string | null;
  finalized_document_id: string | null;
  metadata: {
    acceptedSnippets?: AcceptedSnippet[];
    company_name?: string | null;
    tab_hint?: string | null;
    [k: string]: unknown;
  } | null;
};

export type DealListItem = {
  id: string;
  company_name: string;
  updated_at: string;
};

export type DomKeyValue = { key: string; value: string; confidence: number };

export type DomSnapshot = {
  visible_text: string;
  page_title: string;
  hostname: string;
  url: string;
  key_value_claims: DomKeyValue[];
  outbound_links?: Array<{ url: string; text: string }>;
};

export type ActiveDealHint = {
  id: string;
  name: string;
};
