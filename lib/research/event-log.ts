import type { SupabaseClient } from "@supabase/supabase-js";

export type CopilotEventKind = 
  | "observation"
  | "suggestion"
  | "accepted"
  | "rejected"
  | "prompt"
  | "reply"
  | "error";

export interface CopilotEventPayload {
  domain?: string;
  task_type?: string;
  action?: "accept" | "reject";
  scroll_depth?: number;
  dwell_time?: number;
  gap_id?: string;
  [key: string]: unknown;
}

export async function logCopilotEvent(args: {
  admin: SupabaseClient;
  sessionId: string;
  kind: CopilotEventKind;
  payload: CopilotEventPayload;
  hostname?: string;
  parentEventId?: string;
}) {
  try {
    const res = await args.admin
      .schema("deal_intel")
      .from("copilot_event")
      .insert({
        session_id: args.sessionId,
        kind: args.kind,
        payload: args.payload,
        hostname: args.hostname || null,
        parent_event_id: args.parentEventId || null,
      });

    if (res.error) {
      console.error("logCopilotEvent error:", res.error);
    }
  } catch (err) {
    console.error("logCopilotEvent exception:", err);
  }
}
