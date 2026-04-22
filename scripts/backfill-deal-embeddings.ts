/**
 * Backfill `deals.search_document` + `deals.deal_embedding` for rows missing embeddings.
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLOUD_PROJECT,
 * Application Default Credentials (or GOOGLE_APPLICATION_CREDENTIALS), VERTEX_EMBEDDING_* optional.
 *
 * Loads `.env` then `.env.local` (override). Does not print env values to stdout.
 *
 * Usage: npm run backfill-embeddings
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

function log(msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

async function main() {
  log("starting — loading similar-deals / Vertex helpers (may take a few seconds)…");
  const { createClient } = await import("@supabase/supabase-js");
  const { afterPersistIndexDealEmbedding } = await import("../lib/similar-deals");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    log("warning: GOOGLE_CLOUD_PROJECT is unset — embedding calls will fail");
  }

  const admin = createClient(url, key);
  log("querying deals with deal_embedding IS NULL…");
  const { data: deals, error } = await admin
    .from("deals")
    .select("id, company_name")
    .is("deal_embedding", null)
    .limit(500);

  if (error) throw error;

  const list = deals ?? [];
  log(`found ${list.length} deal(s); each may take ~10–40s (embed + optional retrieval profile)`);

  let i = 0;
  for (const d of list) {
    i++;
    const id = d.id as string;
    const name = (d.company_name as string) ?? id;
    log(`[${i}/${list.length}] processing — ${name}`);
    try {
      const ok = await afterPersistIndexDealEmbedding(admin, id);
      log(`[${i}/${list.length}] ${ok ? "✓ indexed" : "○ skipped (no document text)"} — ${name}`);
    } catch (e) {
      console.error(`[${i}/${list.length}] ✗`, name, e);
    }
  }
  log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
