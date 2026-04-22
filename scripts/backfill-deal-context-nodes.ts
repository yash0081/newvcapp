/**
 * Backfill deal_context_nodes + pipeline feature grid for deals analyzed before materialization existed.
 *
 * Uses latest deal_analyses per deal: prefers deal_analyses.raw_output (full pipeline), else markdown company profiles
 * (e.g. `seed-invested-companies.sql` / Invested Companies_.md shape), else stitches deal_pipeline_json_* + deal_scores.
 * Calls Vertex to embed node text (same as live persist).
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLOUD_PROJECT, Vertex/embedding envs.
 *
 * Usage:
 *   npx tsx scripts/backfill-deal-context-nodes.ts
 *   npx tsx scripts/backfill-deal-context-nodes.ts --limit 50
 *   npx tsx scripts/backfill-deal-context-nodes.ts --deal-id <uuid>   # single deal (latest analysis)
 *   npx tsx scripts/backfill-deal-context-nodes.ts --force            # rebuild nodes even if some exist
 *   npx tsx scripts/backfill-deal-context-nodes.ts --index-deals      # also refresh deals.search_document + deal_embedding
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

function log(msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let limit = 500;
  let force = false;
  let indexDeals = false;
  let dealId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      limit = Math.max(1, parseInt(argv[++i], 10) || limit);
    } else if (argv[i] === "--force") {
      force = true;
    } else if (argv[i] === "--index-deals") {
      indexDeals = true;
    } else if (argv[i] === "--deal-id" && argv[i + 1]) {
      dealId = argv[++i] ?? null;
    }
  }
  return { limit, force, indexDeals, dealId };
}

async function main() {
  log("starting — loading Supabase + materializer (first run can take a few seconds)…");

  const [
    { createClient },
    { materializeDealContextFromPipeline },
    { syncPipelineScoresToFeatureGrid },
    { reconstructDealSourcingResultFromDb },
    { afterPersistIndexDealEmbedding },
    { upsertMarkdownCorpusPlaceholderScoresIfMissing },
  ] = await Promise.all([
    import("@supabase/supabase-js"),
    import("../lib/materialize-deal-context"),
    import("../lib/sync-deal-feature-values"),
    import("../lib/reconstruct-deal-sourcing-result"),
    import("../lib/similar-deals"),
    import("../lib/corpus-deal-scores"),
  ]);

  const { limit, force, indexDeals, dealId: onlyDealId } = parseArgs();
  log(`args: limit=${limit} force=${force} indexDeals=${indexDeals} dealId=${onlyDealId ?? "(all)"}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    log("warning: GOOGLE_CLOUD_PROJECT is unset — Vertex embed calls will fail");
  }

  const admin = createClient(url, key);

  let dealsQuery = admin
    .from("deals")
    .select("id, user_id, company_name, decision, source")
    .order("created_at", { ascending: false });

  if (onlyDealId) {
    dealsQuery = dealsQuery.eq("id", onlyDealId);
  } else {
    dealsQuery = dealsQuery.limit(limit);
  }

  log("fetching deals from Supabase…");
  const { data: deals, error: de } = await dealsQuery;
  if (de) throw de;

  const list = deals ?? [];
  log(`loaded ${list.length} deal(s) to scan`);

  let ok = 0;
  let skip = 0;
  let fail = 0;
  let n = 0;

  for (const d of list) {
    n++;
    const dealId = d.id as string;
    const userId = d.user_id as string;
    const name = (d.company_name as string) ?? dealId;

    const { data: latest, error: ae } = await admin
      .from("deal_analyses")
      .select("id")
      .eq("deal_id", dealId)
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ae || !latest?.id) {
      log(`[${n}/${list.length}] ○ skip (no analysis) — ${name}`);
      skip++;
      continue;
    }

    const analysisId = latest.id as string;

    await upsertMarkdownCorpusPlaceholderScoresIfMissing(admin, dealId, analysisId, {
      decision: (d.decision as string | null) ?? null,
      source: (d.source as string | null) ?? null,
    });

    if (!force) {
      const { count, error: ce } = await admin
        .from("deal_context_nodes")
        .select("id", { count: "exact", head: true })
        .eq("analysis_id", analysisId);
      if (!ce && count && count > 0) {
        log(`[${n}/${list.length}] · skip (nodes already exist) — ${name}`);
        skip++;
        continue;
      }
    }

    log(`[${n}/${list.length}] reconstructing pipeline blob — ${name}`);
    const result = await reconstructDealSourcingResultFromDb(admin, dealId, analysisId);
    if (!result) {
      log(`[${n}/${list.length}] ○ skip (no reconstructable data) — ${name}`);
      skip++;
      continue;
    }

    try {
      log(
        `[${n}/${list.length}] → Vertex: embedding ~6–8 nodes sequentially for "${name}" (often 30–90s; not frozen)`
      );
      await materializeDealContextFromPipeline(admin, dealId, analysisId, result);
      await syncPipelineScoresToFeatureGrid(admin, userId, dealId, result);
      if (indexDeals) {
        log(`[${n}/${list.length}] → indexing deal-level embedding — ${name}`);
        await afterPersistIndexDealEmbedding(admin, dealId);
      }
      log(`[${n}/${list.length}] ✓ done — ${name}`);
      ok++;
    } catch (e) {
      console.error(`[${n}/${list.length}] ✗`, name, e);
      fail++;
    }
  }

  log(`finished — ok=${ok} skip=${skip} fail=${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
