import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { embedMeetingQuestionText } from "@/lib/live-assistant/meeting-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { createMeetingAssistantEvent } from "@/lib/live-assistant/tools";

export type QuestionProvenance =
  | "assumption_inversion"
  | "similar_company"
  | "low_evidence"
  | "contradiction"
  | "coverage_prompt"
  | "manual";

export type QuestionState = "unanswered" | "partially_answered" | "answered" | "contradicted" | "needs_followup";

export async function upsertMeetingTrackedQuestion(
  admin: SupabaseClient,
  row: {
    meetingId: string;
    text: string;
    section: string;
    importanceWeight: number;
    state: QuestionState;
    provenance: QuestionProvenance;
    venue?: "in_meeting" | "memo_prep";
    similarDealId?: string | null;
    templateId?: string | null;
    dedupeKey: string;
    metadata?: Record<string, unknown>;
    syncEvent?: { title: string; lane?: "attention" | "context" | "memo"; severity?: "low" | "med" | "high" };
  },
): Promise<{ id: string | null }> {
  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
  let qEmb: string | null = null;
  try {
    const v = await embedMeetingQuestionText(row.text);
    qEmb = vectorParam(v);
  } catch {
    qEmb = null;
  }

  const insertRow = {
    meeting_id: row.meetingId,
    text: row.text.slice(0, 2000),
    section: row.section,
    question_embedding: qEmb,
    question_embedding_model: model,
    importance_weight: row.importanceWeight,
    state: row.state,
    provenance: row.provenance,
    venue: row.venue ?? "in_meeting",
    similar_deal_id: row.similarDealId ?? null,
    template_id: row.templateId ?? null,
    dedupe_key: row.dedupeKey,
    metadata: row.metadata ?? {},
  };

  const res = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .upsert(insertRow, { onConflict: "meeting_id,dedupe_key" })
    .select("id")
    .maybeSingle();

  if (res.error && !String(res.error.message || "").includes("does not exist")) {
    console.error("upsertMeetingTrackedQuestion", res.error.message || res.error);
  }

  const id = res.data?.id ? String(res.data.id) : null;

  if (row.syncEvent && id) {
    await createMeetingAssistantEvent(admin, {
      meeting_id: row.meetingId,
      kind: "suggested_question",
      severity: row.syncEvent.severity ?? "low",
      title: row.syncEvent.title,
      body: row.text,
      source_map: {
        lane: row.syncEvent.lane ?? "memo",
        tracked_question_id: id,
        provenance: row.provenance,
        dedupe_key: `tq_evt:${row.dedupeKey}`,
      },
    });
  }

  return { id };
}

export function stableKeyAssumption(claimId: string, assumptionText: string): string {
  return createHash("sha256")
    .update(`${claimId}|${assumptionText.toLowerCase().slice(0, 400)}`)
    .digest("hex")
    .slice(0, 20);
}

export function deterministicInversionQuestion(args: {
  assumptionText: string;
  dependencyType: string;
  section: string;
}): string {
  const a = args.assumptionText.trim().slice(0, 320);
  const dt = args.dependencyType.toLowerCase();
  if (dt.includes("market") || dt.includes("external")) {
    return `What evidence would invalidate the external dependency behind: “${a}”?`;
  }
  if (dt.includes("team") || dt.includes("talent")) {
    return `If the team capability assumption is wrong (“${a}”), what breaks first in execution?`;
  }
  return `What breaks if this assumption is false: “${a}”? (section: ${args.section})`;
}
