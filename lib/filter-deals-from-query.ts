import type { SupabaseClient } from "@supabase/supabase-js";

function decisionStr(meta: Record<string, unknown>): string {
  return String(meta.decision ?? meta.decision_state ?? "")
    .trim()
    .toLowerCase();
}

function nameStr(meta: Record<string, unknown>): string {
  return String(meta.company_name ?? meta.display_name ?? "").toLowerCase();
}

/**
 * Tabular prefilter: map natural-language hints to `deal_intel.deal` id[] using JSON metadata
 * (company name, decision, stage, sector) when present.
 */
export async function resolveDealIdsFromTabularFilter(
  admin: SupabaseClient,
  userId: string,
  message: string
): Promise<string[]> {
  const t = message.toLowerCase();
  const { data: all, error } = await admin.rpc("deal_intel_list_deals_for_user", {
    p_user_id: userId,
    p_exclude_deal_id: null,
    p_limit: 2000,
  });
  if (error || !all?.length) return [];

  const stagePatterns: { re: RegExp; hints: string[] }[] = [
    { re: /\bpre[- ]?seed\b/, hints: ["pre-seed", "preseed", "pre seed"] },
    { re: /\bseed\b(?!\s*series)/, hints: ["seed"] },
    { re: /\bseries\s*a\b|\bseriesa\b/, hints: ["series a", "seriesa", "a"] },
    { re: /\bseries\s*b\b|\bseriesb\b/, hints: ["series b", "seriesb", "b"] },
    { re: /\bseries\s*c\b|\bseriesc\b/, hints: ["series c", "seriesc", "c"] },
  ];

  const activeStageHints: string[] = [];
  for (const { re, hints } of stagePatterns) {
    if (re.test(t)) activeStageHints.push(...hints);
  }

  const decisionPass = /\bpassed\b|\bpass\b|\bdeclin/.test(t);
  const decisionInvest = /\binvested\b|\bportfolio\b|\bwin\b|\baccepted\b/.test(t);

  const extraTokens = t
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 3);

  const ids = new Set<string>();

  for (const row of all) {
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    const stage = String(meta.stage ?? "").toLowerCase();
    const sector = String(meta.sector ?? "").toLowerCase();
    const decision = decisionStr(meta);
    const name = nameStr(meta);

    let hit = false;

    if (activeStageHints.length) {
      for (const h of activeStageHints) {
        if (stage.includes(h)) {
          hit = true;
          break;
        }
      }
    }

    if (!hit && extraTokens.length) {
      for (const w of extraTokens) {
        if (sector.includes(w) || name.includes(w)) {
          hit = true;
          break;
        }
      }
    }

    if (decisionPass && (decision.includes("no") || decision === "pass" || decision.includes("declin"))) hit = true;
    if (decisionInvest && (decision.includes("yes") || decision === "open" || decision.includes("accept"))) hit = true;

    if (hit) ids.add(row.id as string);
  }

  return [...ids];
}
