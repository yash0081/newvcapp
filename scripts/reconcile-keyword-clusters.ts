/**
 * Run offline keyword cluster reconcile (dedupe near-identical medoids).
 * Usage: npx tsx scripts/reconcile-keyword-clusters.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { reconcileKeywordClustersMedoids } from "../lib/keyword-offline-reconcile";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const admin = createClient(url, key);
  const { merged } = await reconcileKeywordClustersMedoids(admin);
  console.log("Merged duplicate medoids removed:", merged);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
