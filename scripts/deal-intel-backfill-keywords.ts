import "dotenv/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { backfillDealIntelKeywordGraph } from "@/lib/deal-intel/keywords";

function parseDealIdArg(): string | null {
  const idx = process.argv.indexOf("--deal-id");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

async function main() {
  const admin = createAdminClient();
  const targetDealId = parseDealIdArg();
  const { data, error } = await admin.rpc("deal_intel_list_deal_ids", {
    p_deal_id: targetDealId,
    p_limit: 5000,
  });
  if (error) throw error;
  const dealIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  for (const dealId of dealIds) {
    await backfillDealIntelKeywordGraph(admin, dealId);
    console.log("done keyword graph:", dealId);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

