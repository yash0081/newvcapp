import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";
import { embedText } from "../lib/vertex-embeddings";

function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

function toKeyRisks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function riskText(parts: Array<string | null | undefined>): string {
  return parts
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim())
    .join(" | ");
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const admin = createClient(url, key);

  const { data: rows, error } = await admin
    .from("deal_retrieval_index")
    .select("deal_id, risk_normalized")
    .limit(5000);
  if (error) throw error;

  console.log(`Found ${(rows ?? []).length} retrieval rows`);
  for (const row of rows ?? []) {
    const dealId = row.deal_id as string;
    try {
      const { data: deal, error: dErr } = await admin
        .from("deals")
        .select("company_name, pass_reason, pass_reason_detail, key_risks")
        .eq("id", dealId)
        .maybeSingle();
      if (dErr || !deal) continue;

      const keyRisks = toKeyRisks(deal.key_risks);
      const composed = riskText([
        typeof deal.pass_reason_detail === "string" ? deal.pass_reason_detail : null,
        keyRisks.length ? `key_risks: ${keyRisks.join(" | ")}` : null,
        typeof deal.pass_reason === "string" ? `pass_reason: ${deal.pass_reason}` : null,
      ]);
      if (!composed) continue;

      const vec = await embedText(composed);
      const normalized = composed.slice(0, 1200);

      const { error: upErr } = await admin
        .from("deal_retrieval_index")
        .update({
          risk_embedding: vectorParam(vec),
          risk_normalized: normalized,
          updated_at: new Date().toISOString(),
        })
        .eq("deal_id", dealId);
      if (upErr) throw upErr;

      const company = typeof deal.company_name === "string" && deal.company_name.trim() ? deal.company_name : dealId;
      console.log("✓", company);
    } catch (e) {
      console.error("✗", dealId, e);
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

