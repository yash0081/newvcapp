import "dotenv/config";
import { createAdminClient } from "@/lib/supabase/admin";

type Counts = {
  facts: number;
  fact_edges: number;
  tree_nodes: number;
  tree_edges: number;
  fact_embedded: number;
  root_nodes: number;
  negatives_children: number;
  anchor_filled: number;
  persona_nodes: number;
};

async function main() {
  const admin = createAdminClient();
  const idx = process.argv.indexOf("--deal-id");
  const dealId = idx >= 0 ? process.argv[idx + 1] : null;
  if (!dealId) {
    console.error("Usage: npm run deal-intel:validate-parity -- --deal-id <uuid>");
    process.exit(1);
  }
  const { data, error } = await admin.rpc("deal_intel_parity_counts", {
    p_deal_id: dealId,
  });
  if (error || !Array.isArray(data) || !data[0]) throw error ?? new Error("No parity counts returned");
  const c = data[0] as Counts;
  console.log(JSON.stringify(c, null, 2));

  const failed =
    c.facts === 0 ||
    c.fact_edges === 0 ||
    c.tree_nodes === 0 ||
    c.tree_edges === 0 ||
    c.fact_embedded === 0 ||
    c.root_nodes !== 1 ||
    c.negatives_children < 1 ||
    c.persona_nodes < 3;
  if (failed) {
    console.error("Parity validation failed.");
    process.exit(2);
  }
  console.log("Parity validation passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

