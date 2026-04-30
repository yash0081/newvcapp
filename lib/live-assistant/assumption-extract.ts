import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import {
  deterministicInversionQuestion,
  stableKeyAssumption,
  upsertMeetingTrackedQuestion,
} from "@/lib/live-assistant/tracked-questions";

const MODEL = getLiveAssistantModel("fast");

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export async function runMeetingAssumptionExtract(admin: SupabaseClient, meetingId: string): Promise<void> {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_assumption_run_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const lastMs = st?.last_assumption_run_at ? new Date(String(st.last_assumption_run_at)).getTime() : 0;
  if (lastMs && Date.now() - lastMs < 55_000) return;

  const watermark = new Date(Math.max(0, lastMs - 120_000)).toISOString();
  const claimsRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, section_labels, updated_at")
    .eq("meeting_id", meetingId)
    .gte("updated_at", watermark)
    .order("updated_at", { ascending: false })
    .limit(40);

  if (claimsRes.error) {
    if (!String(claimsRes.error.message || "").includes("does not exist")) {
      console.error("runMeetingAssumptionExtract claims", claimsRes.error);
    }
    return;
  }

  const claims = (claimsRes.data ?? []) as Array<{ id: string; text: string; section_labels: string[] }>;
  if (!claims.length) {
    await admin
      .schema("deal_intel")
      .from("meeting_question_engine_state")
      .upsert(
        { meeting_id: meetingId, last_assumption_run_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "meeting_id" },
      );
    return;
  }

  const payload = claims.map((c) => ({
    claim_id: c.id,
    text: c.text.slice(0, 500),
    sections: (c.section_labels ?? []).slice(0, 6),
  }));

  const prompt = `From each claim, extract 0-2 implicit assumptions or dependencies material to diligence.
Return JSON only:
{"assumptions":[{"claim_id":"uuid","assumption_text":"...","dependency_type":"market|team|product|customer|financial|other","confidence":0.0}]}
Rules: short assumption_text; confidence 0..1; skip trivial restatements.

Claims:
${JSON.stringify(payload).slice(0, 12000)}`;

  let raw: string;
  try {
    raw = await vertexRunWithText(MODEL, prompt, false);
  } catch (e) {
    console.error("assumption extract LLM", e);
    return;
  }

  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
    assumptions?: unknown;
  };
  const arr = Array.isArray(parsed?.assumptions) ? parsed.assumptions : [];

  for (const item of arr) {
    const r = (item && typeof item === "object" ? (item as Record<string, unknown>) : {}) as Record<string, unknown>;
    const claimId = String(r.claim_id ?? "");
    const assumptionText = String(r.assumption_text ?? "").trim().slice(0, 600);
    const dependencyType = String(r.dependency_type ?? "other").slice(0, 64);
    const confidence = clamp01(typeof r.confidence === "number" ? r.confidence : 0.55);
    if (!claimId || !assumptionText) continue;

    const stableKey = stableKeyAssumption(claimId, assumptionText);
    await admin.schema("deal_intel").from("meeting_claim_assumption").upsert(
      {
        meeting_id: meetingId,
        claim_id: claimId,
        assumption_text: assumptionText,
        dependency_type: dependencyType,
        confidence,
        stable_key: stableKey,
      },
      { onConflict: "claim_id,stable_key" },
    );

    const claimRow = claims.find((c) => c.id === claimId);
    const section = (claimRow?.section_labels?.[0] as string) || "other";
    const qText = deterministicInversionQuestion({
      assumptionText,
      dependencyType,
      section,
    });
    const dedupeKey = `inv:${stableKey}`;
    await upsertMeetingTrackedQuestion(admin, {
      meetingId,
      text: qText,
      section,
      importanceWeight: 0.55 + confidence * 0.35,
      state: "unanswered",
      provenance: "assumption_inversion",
      venue: "in_meeting",
      dedupeKey,
      metadata: { assumption_stable_key: stableKey, claim_id: claimId, dependency_type: dependencyType },
      syncEvent: { title: "Assumption check", lane: "memo", severity: "low" },
    });
  }

  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      { meeting_id: meetingId, last_assumption_run_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
}
