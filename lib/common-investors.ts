import type { SupabaseClient } from "@supabase/supabase-js";
type CommonInvestorDeal = {
  deal_id: string;
  company_name: string | null;
  decision: string | null;
  pass_reason: string | null;
  pass_reason_detail: string | null;
};

export type CommonInvestorRow = {
  investor_id: string;
  investor_name: string | null;
  deals: CommonInvestorDeal[];
};

function canonicalInvestorName(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,]/g, "");
}

type CurrentInv = { displayName: string; investorId?: string };

function mergeCurrentInvestor(map: Map<string, CurrentInv>, rawName: string, investorId?: string | null) {
  const canon = canonicalInvestorName(rawName);
  if (!canon) return;
  const display = rawName.trim();
  const prev = map.get(canon);
  if (!prev) {
    map.set(canon, { displayName: display, investorId: investorId ?? undefined });
    return;
  }
  if (investorId && !prev.investorId) prev.investorId = investorId;
  if (display.length > prev.displayName.length) prev.displayName = display;
}

/**
 * Investors on the current deal who also appear on other deals in the same user corpus.
 * Matches by normalized investor name (UUIDs may differ for the same entity).
 */
export async function fetchCommonInvestorsForDeal(
  admin: SupabaseClient,
  dealId: string,
  userId: string
): Promise<CommonInvestorRow[]> {
  const currentByCanonical = new Map<string, CurrentInv>();
  const currentInvestorIds = new Set<string>();

  const { data: currentInvRows, error: currentErr } = await admin
    .from("deal_investors")
    .select("investor_id, investors ( name )")
    .eq("deal_id", dealId);

  if (currentErr) {
    console.error("fetchCommonInvestorsForDeal: current investors", currentErr);
  }

  for (const row of currentInvRows ?? []) {
    const investorId = row.investor_id as string | null;
    const investorName = (row.investors as { name?: string } | null)?.name ?? null;
    if (investorName?.trim()) mergeCurrentInvestor(currentByCanonical, investorName, investorId);
    if (investorId) currentInvestorIds.add(investorId);
  }

  if (currentByCanonical.size === 0) {
    if (process.env.NODE_ENV === "development") {
      console.debug("fetchCommonInvestorsForDeal: no current investor names from DB/traction/raw_output");
    }
    return [];
  }

  // Performance-critical: do NOT scan the full `deal_investors` table.
  // Prefer investor_id matching (fast IN query). Fallback to name-based scan only if needed.
  const preferIds = currentInvestorIds.size > 0;
  const overlapQuery = admin
    .from("deal_investors")
    .select(
      "investor_id, investors ( name ), deal_id, deals!inner(id, user_id, company_name, decision, pass_reason, pass_reason_detail)"
    )
    .neq("deal_id", dealId)
    .limit(5000);
  const { data: overlapRows, error: overlapErr } = preferIds
    ? await overlapQuery.in("investor_id", Array.from(currentInvestorIds))
    : await overlapQuery;

  if (overlapErr) {
    console.error("fetchCommonInvestorsForDeal: overlap deals", overlapErr);
    return [];
  }

  const byCanonical = new Map<string, CommonInvestorRow>();

  for (const row of overlapRows ?? []) {
    const invName = (row.investors as { name?: string } | null)?.name ?? null;
    const canon = canonicalInvestorName(invName);
    const current = currentByCanonical.get(canon);
    // If we used investor_id filtering, current may still be missing canonical (e.g. null name) — fall back to ID match.
    if (!current) {
      const invId = row.investor_id as string | null;
      if (!invId || !currentInvestorIds.has(invId)) continue;
      // Best-effort display name for ID-only match.
      mergeCurrentInvestor(currentByCanonical, invName ?? "", invId);
      const refreshed = currentByCanonical.get(canon);
      if (!refreshed) continue;
    }

    const deal = row.deals as {
      id?: string;
      user_id?: string;
      company_name?: string | null;
      decision?: string | null;
      pass_reason?: string | null;
      pass_reason_detail?: string | null;
    } | null;

    if (!deal?.id || deal.user_id !== userId) continue;

    const key = canon;
    const investorId =
      (currentByCanonical.get(canon)?.investorId as string | undefined) ?? `name:${canon}`;
    const existing =
      byCanonical.get(key) ??
      ({
        investor_id: investorId,
        investor_name: (currentByCanonical.get(canon)?.displayName as string | undefined) ?? invName,
        deals: [] as CommonInvestorDeal[],
      } satisfies CommonInvestorRow);

    if (!existing.deals.find((d) => d.deal_id === deal.id)) {
      existing.deals.push({
        deal_id: deal.id,
        company_name: deal.company_name ?? null,
        decision: deal.decision ?? null,
        pass_reason: deal.pass_reason ?? null,
        pass_reason_detail: deal.pass_reason_detail ?? null,
      });
    }

    byCanonical.set(key, existing);
  }

  const scoreDecision = (d: string | null): number => {
    if (!d) return 1;
    const v = d.trim().toLowerCase();
    if (v === "invest" || v === "invested" || v === "accept") return 0;
    return 1;
  };

  const rows: CommonInvestorRow[] = Array.from(byCanonical.values())
    .map((row) => ({
      ...row,
      deals: row.deals.sort((a, b) => scoreDecision(a.decision) - scoreDecision(b.decision)),
    }))
    .filter((row) => row.deals.length > 0);

  if (process.env.NODE_ENV === "development") {
    console.debug("fetchCommonInvestorsForDeal:", {
      dealId,
      currentCanonicalCount: currentByCanonical.size,
      overlapGroups: rows.length,
      totalOverlapDeals: rows.reduce((n, r) => n + r.deals.length, 0),
    });
  }

  return rows.slice(0, 25);
}
