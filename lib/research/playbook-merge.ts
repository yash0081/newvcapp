import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";

export async function mergePlaybookRulesInBackground(args: {
  admin: SupabaseClient;
  userId: string;
}) {
  console.log(`[Playbook Merge] Background job triggered for user ${args.userId}.`);

  const { data: events, error } = await args.admin
    .schema("deal_intel")
    .from("copilot_event")
    .select(`
      id, session_id, kind, hostname, payload, parent_event_id, created_at,
      copilot_session!inner(deal_id, user_id)
    `)
    .eq("copilot_session.user_id", args.userId)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error || !events || events.length === 0) {
    console.error("[Playbook Merge] Failed to fetch events or no events found:", error);
    return;
  }

  // Map events for quick lookup
  const eventMap = new Map<string, any>();
  for (const e of events) {
    eventMap.set(e.id, e);
  }

  // 1. Correlate decisions to observations
  const decisions = events.filter((e) => e.kind === "accepted" || e.kind === "rejected");
  const stats: Record<string, {
    domain: string;
    taskType: string;
    accepts: number;
    rejects: number;
    dwellTimes: number[];
    skims: number; // actions where mainly headings were viewed
    reads: number; // actions where full text was viewed
  }> = {};

  for (const dec of decisions) {
    const payload = dec.payload as any;
    const taskType = payload?.summary?.split(":")[0] || "general"; // rough proxy for task type if no specific field
    const domain = dec.hostname || "unknown";
    const key = `${taskType}::${domain}`;

    if (!stats[key]) {
      stats[key] = { domain, taskType, accepts: 0, rejects: 0, dwellTimes: [], skims: 0, reads: 0 };
    }

    if (dec.kind === "accepted") stats[key].accepts++;
    else stats[key].rejects++;

    if (payload?.dwell_time) {
      stats[key].dwellTimes.push(Number(payload.dwell_time));
    }

    // Traverse up to observation to get viewed_elements
    let suggestion = dec.parent_event_id ? eventMap.get(dec.parent_event_id) : null;
    let observation = suggestion?.parent_event_id ? eventMap.get(suggestion.parent_event_id) : null;

    if (observation && observation.payload?.viewed_elements) {
      const elements = observation.payload.viewed_elements as string[];
      const headings = elements.filter(el => el.toLowerCase().startsWith("h")).length;
      const paragraphs = elements.filter(el => el.toLowerCase().startsWith("p")).length;
      
      // Simple structural heuristic
      if (headings > 0 && paragraphs === 0) {
        stats[key].skims++;
      } else if (paragraphs > 0) {
        stats[key].reads++;
      }
    }
  }

  // 2. Layer B: Extract Numeric Policy Knobs
  for (const [key, s] of Object.entries(stats)) {
    if (s.accepts + s.rejects < 3) continue; // Not enough data

    const avgDwell = s.dwellTimes.length > 0 ? s.dwellTimes.reduce((a, b) => a + b, 0) / s.dwellTimes.length : 0;
    const strategy = s.skims > s.reads ? "skim_headings" : (s.reads > s.skims ? "deep_read" : "auto");

    const policy = {
      min_dwell_threshold: avgDwell > 0 ? avgDwell * 0.5 : 0, // Require at least half of average dwell
      strategy,
      accept_rate: s.accepts / (s.accepts + s.rejects)
    };

    await args.admin.schema("deal_intel").from("copilot_policy").upsert({
      user_id: args.userId,
      task_type: s.taskType,
      domain: s.domain,
      policy
    }, { onConflict: "user_id, task_type, domain" });
  }

  // 3. Layer C: Extract Prose Rules via LLM
  // We feed the aggregated stats to the LLM to generate plain text rules.
  const prompt = `You are an AI analyzing a user's research copilot telemetry to generate strategic playbook rules.

Here are the aggregated statistics for this user's interactions:
${JSON.stringify(stats, null, 2)}

Your task is to distill these metrics into clear, human-readable "if-then" rules or strategic guardrails for the Copilot. 
Focus on rules like "On Crunchbase for Sourcing tasks, prefer skimming headings before proposing saves" or "Deprioritize LinkedIn if dwell time is very low."

Return strict JSON:
{
  "rules": [
    {
      "task_type": "sourcing",
      "domain": "crunchbase.com",
      "rule_text": "Do not explore this host if...",
      "confidence": 0.8
    }
  ]
}`;

  const model = getResearchModel("flash");
  const rawResponse = await vertexRunWithTextMulti(model, prompt, [], false);
  const json = parseJsonFromResponseOrNull(rawResponse) as { rules: Array<{ task_type: string; domain?: string; rule_text: string; confidence: number }> } | null;

  if (json && json.rules && Array.isArray(json.rules)) {
    for (const rule of json.rules) {
      await args.admin.schema("deal_intel").from("user_playbook_rule").insert({
        user_id: args.userId,
        task_type: rule.task_type || "general",
        domain: rule.domain || null,
        rule_text: rule.rule_text,
        confidence: rule.confidence || 0.5
      });
    }
    console.log(`[Playbook Merge] Inserted ${json.rules.length} prose rules for user ${args.userId}.`);
  } else {
    console.log(`[Playbook Merge] No prose rules generated by LLM.`);
  }
}
