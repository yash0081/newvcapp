/**
 * Ingests `Invested Companies_.md` into `deal_intel` (one deal per company JSON), then
 * optionally materializes the retrieval tree.
 *
 * Env: INVESTED_SEED_USER_ID, GOOGLE_CLOUD_PROJECT (if --materialize), SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
 *
 * Usage: npx tsx scripts/seed-invested-companies-deal-intel.ts [--materialize] [--file path]
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseInvestedCompaniesMarkdown } from "@/lib/deal-intel/parse-invested-markdown";
import { buildInvestedCompanyDealMetadata } from "@/lib/deal-intel/transform-invested-company";
import { persistDealIntelFacts } from "@/lib/ingestion/persist-deal-intel-facts";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { backfillDealIntelFactEmbeddings } from "@/lib/deal-intel/backfill-facts";
import { backfillDealIntelKeywordGraph, reconcileDealIntelKeywordClustersOffline } from "@/lib/deal-intel/keywords";

const DEFAULT_MD = path.join(process.cwd(), "Invested Companies_.md");

function cli(): { materialize: boolean; file: string } {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf("--file");
  return {
    materialize: argv.includes("--materialize"),
    file: fi >= 0 && argv[fi + 1] ? path.resolve(argv[fi + 1]) : DEFAULT_MD,
  };
}

async function main() {
  const userId = process.env.INVESTED_SEED_USER_ID;
  if (!userId) {
    console.error("Set INVESTED_SEED_USER_ID to your Supabase auth user id.");
    process.exit(1);
  }
  const { materialize, file } = cli();
  if (!existsSync(file)) {
    console.error("File not found:", file);
    process.exit(1);
  }
  const md = readFileSync(file, "utf8");
  const recs = parseInvestedCompaniesMarkdown(md);
  const admin = createAdminClient();

  for (const rec of recs) {
    const dealMetadata = buildInvestedCompanyDealMetadata(rec);
    const name = String(dealMetadata.company_name ?? "Unknown");
    const { dealId, revisionId } = await persistDealIntelFacts({
      admin,
      userId,
      facts: rec.rawJson as Record<string, unknown>,
      dealMetadata: { ...dealMetadata, ingest: "seed_invested_companies_md" },
    });
    if (materialize) {
      await backfillDealIntelFactEmbeddings(admin, dealId);
      await materializeDealIntelTree({ admin, dealId, revisionId });
      await backfillDealIntelKeywordGraph(admin, dealId);
      console.log("materialized", name, dealId);
    } else {
      console.log("facts", name, dealId);
    }
  }
  if (materialize) {
    const out = await reconcileDealIntelKeywordClustersOffline(admin);
    console.log("offline keyword reconcile merged", out.merged, "clusters");
  }
  console.log("Done.", recs.length, "deals");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
