import "dotenv/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileDealIntelKeywordClustersOffline } from "@/lib/deal-intel/keywords";

async function main() {
  const admin = createAdminClient();
  const out = await reconcileDealIntelKeywordClustersOffline(admin);
  console.log("deal_intel keyword offline reconcile merged:", out.merged);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

