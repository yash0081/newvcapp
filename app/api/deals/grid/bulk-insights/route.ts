import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveContextNodesForQuery, classifyQueryType } from "@/lib/retrieval-orchestrator";
import { loadAggregatedRulesForUser } from "@/lib/investment-rules";
import {
  buildAgenticSystemPrompt,
  formatFundThesisForPrompt,
  formatInvestmentRulesForSystemPrompt,
  formatRetrievedChunksForPrompt,
} from "@/lib/agentic-chat-context";
import { vertexRunWithText } from "@/lib/vertex";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { dealIds?: string[]; question?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealIds = Array.isArray(body.dealIds) ? body.dealIds.filter((x) => typeof x === "string") : [];
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!dealIds.length || !question) {
    return NextResponse.json({ error: "dealIds and question required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: owned } = await admin.from("deals").select("id").eq("user_id", user.id).in("id", dealIds);
  const allowed = new Set((owned ?? []).map((r) => r.id as string));
  if (allowed.size === 0) {
    return NextResponse.json({ error: "No valid deals" }, { status: 400 });
  }

  const queryType = classifyQueryType(question);
  const chunks = await retrieveContextNodesForQuery(admin, {
    userId: user.id,
    queryText: question,
    queryType,
    limit: 30,
  });
  const filtered = chunks.filter((c) => allowed.has(c.deal_id));

  const rules = await loadAggregatedRulesForUser(admin, user.id);
  const { data: thesisRow } = await admin
    .from("fund_thesis")
    .select("thesis_text")
    .eq("user_id", user.id)
    .maybeSingle();
  const thesisText =
    thesisRow && typeof (thesisRow as { thesis_text?: string }).thesis_text === "string"
      ? (thesisRow as { thesis_text: string }).thesis_text
      : null;
  const system = buildAgenticSystemPrompt({
    taskLabel: "bulk_insights",
    dealName: null,
    rulesBlock: formatInvestmentRulesForSystemPrompt(rules),
    institutionalBlock: formatFundThesisForPrompt(thesisText),
    contextBlock: formatRetrievedChunksForPrompt(filtered.length ? filtered : chunks),
  });

  const model =
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    process.env.GEMINI_MODEL_FLASH_LITE ||
    "gemini-2.5-flash-lite";

  const userPrompt = `Selected deal IDs: ${[...allowed].join(", ")}\n\nQuestion: ${question}\n\nSynthesize across these deals. Reference deal_id when comparing.`;

  try {
    const answer = await vertexRunWithText(model, `${system}\n\n---\n\n${userPrompt}`, false);
    return NextResponse.json({ answer, dealIds: [...allowed] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
