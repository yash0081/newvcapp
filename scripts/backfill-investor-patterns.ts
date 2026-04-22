import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";

type PatternRow = {
  investor_id: string;
  pattern_type: string;
  evidence_deal_ids: string[];
  confidence_score: number;
  updated_at: string;
};

function normalizeDecision(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase();
}

function isPassedDecision(v: unknown): boolean {
  const d = normalizeDecision(v);
  return d === "pass" || d === "passed" || d === "reject" || d === "rejected";
}

function canonicalInvestorName(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const admin = createClient(url, key);

  const { data: rows, error } = await admin
    .from("deal_investors")
    .select("investor_id, deal_id, deals!inner(id, decision)")
    .limit(100000);
  if (error) throw error;

  const passedByInvestor = new Map<string, string[]>();
  let totalJoinRows = 0;
  let passedJoinRows = 0;
  for (const r of rows ?? []) {
    totalJoinRows++;
    const investorId = r.investor_id as string | null;
    const deal = r.deals as { id?: string; decision?: string | null } | null;
    if (!investorId || !deal?.id) continue;
    if (!isPassedDecision(deal.decision)) continue;
    passedJoinRows++;
    const arr = passedByInvestor.get(investorId) ?? [];
    arr.push(deal.id);
    passedByInvestor.set(investorId, arr);
  }

  const investorIds = Array.from(passedByInvestor.keys());
  const { data: investorRows, error: invErr } = await admin
    .from("investors")
    .select("id, name")
    .in("id", investorIds.length ? investorIds : ["00000000-0000-0000-0000-000000000000"]);
  if (invErr) throw invErr;

  const idsByCanonicalName = new Map<string, string[]>();
  for (const row of investorRows ?? []) {
    const name = canonicalInvestorName((row as { name?: string }).name);
    const id = (row as { id: string }).id;
    if (!name) continue;
    const arr = idsByCanonicalName.get(name) ?? [];
    arr.push(id);
    idsByCanonicalName.set(name, arr);
  }
  const duplicateNameGroups = Array.from(idsByCanonicalName.entries()).filter(([, ids]) => ids.length > 1);

  const payload: PatternRow[] = Array.from(passedByInvestor.entries())
    .filter(([, ids]) => ids.length > 0)
    .map(([investorId, ids]) => ({
      investor_id: investorId,
      pattern_type: "passed_deal_overlap_profile",
      evidence_deal_ids: Array.from(new Set(ids)).slice(0, 100),
      confidence_score: Math.min(1, ids.length / 5),
      updated_at: new Date().toISOString(),
    }));

  console.log(`Joined investor-deal rows: ${totalJoinRows}`);
  console.log(`Rows with passed-like decisions: ${passedJoinRows}`);
  console.log(`Unique investors with passed-like deals: ${passedByInvestor.size}`);
  if (duplicateNameGroups.length > 0) {
    console.log(`Potential duplicate investor-name groups (case/spacing variants): ${duplicateNameGroups.length}`);
    for (const [name, ids] of duplicateNameGroups.slice(0, 20)) {
      console.log(`  - ${name}: ${ids.join(", ")}`);
    }
  }

  console.log(`Writing ${payload.length} investor pattern rows`);
  for (const p of payload) {
    const { error: delErr } = await admin
      .from("investor_patterns")
      .delete()
      .eq("investor_id", p.investor_id)
      .eq("pattern_type", p.pattern_type);
    if (delErr) {
      console.error("delete failed:", p.investor_id, delErr);
      continue;
    }
    const { error: insErr } = await admin.from("investor_patterns").insert(p);
    if (insErr) {
      console.error("insert failed:", p.investor_id, insErr);
      continue;
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

