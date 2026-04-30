import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function GET(req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const url = new URL(req.url);
  const guestToken = url.searchParams.get("guest")?.trim() || "";
  const includeAnswered = url.searchParams.get("includeAnswered") === "1";

  const admin = createAdminClient();
  const { data: meeting, error: mErr } = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id, metadata")
    .eq("id", meetingId)
    .maybeSingle();
  if (mErr) return NextResponse.json({ error: mErr.message || "Failed to load meeting" }, { status: 500 });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isHost = Boolean(user && user.id === meeting.host_user_id);

  if (!isHost) {
    const meta =
      meeting.metadata && typeof meeting.metadata === "object"
        ? (meeting.metadata as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const expected = typeof meta.guest_token_sha256 === "string" ? meta.guest_token_sha256 : "";
    const got = guestToken ? sha256Hex(guestToken) : "";
    if (!expected || !got || got !== expected) {
      return NextResponse.json({ error: "Invalid guest token" }, { status: 401 });
    }
  }

  const limit = includeAnswered ? 300 : 80;
  const res = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text, section, importance_weight, state, provenance, venue, metadata, created_at, updated_at")
    .eq("meeting_id", meetingId)
    .order("importance_weight", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (res.error) return NextResponse.json({ error: res.error.message || "Failed to load questions" }, { status: 500 });

  const questions = (res.data ?? []) as Array<{ id: string; state: string } & Record<string, unknown>>;
  const answeredIds = questions
    .filter((q) => String(q.state || "").trim().toLowerCase() === "answered")
    .map((q) => String(q.id));

  // For answered questions: attach the most recent \"answers\" or \"partial\" match + the claim text.
  const evidenceByQuestionId: Record<string, { relation: string; claim_text: string; scores: unknown; created_at: string }[]> = {};
  if (includeAnswered && answeredIds.length) {
    const matchRes = await admin
      .schema("deal_intel")
      .from("meeting_question_claim_match")
      .select("question_id, claim_id, relation, scores, created_at")
      .in("question_id", answeredIds)
      .order("created_at", { ascending: false })
      .limit(300);
    if (!matchRes.error) {
      const matches = (matchRes.data ?? []) as Array<{
        question_id: string;
        claim_id: string;
        relation: string;
        scores: unknown;
        created_at: string;
      }>;
      const claimIds = [...new Set(matches.map((m) => String(m.claim_id)))].slice(0, 250);
      const claimRes = claimIds.length
        ? await admin.schema("deal_intel").from("meeting_claim").select("id, text").in("id", claimIds)
        : { data: [], error: null };
      const claimById = new Map((claimRes.data ?? []).map((r) => [String((r as { id: string }).id), String((r as { text: string }).text)]));

      for (const m of matches) {
        const rel = String(m.relation);
        if (rel !== "answers" && rel !== "partial") continue;
        const qid = String(m.question_id);
        const arr = evidenceByQuestionId[qid] ?? [];
        if (arr.length >= 2) continue;
        arr.push({
          relation: rel,
          claim_text: claimById.get(String(m.claim_id)) ?? "",
          scores: m.scores,
          created_at: String(m.created_at),
        });
        evidenceByQuestionId[qid] = arr;
      }
    }
  }

  return NextResponse.json({ questions, evidenceByQuestionId });
}
