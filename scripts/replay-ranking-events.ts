/**
 * Replay ranking events for offline analysis or retraining of recommender weights.
 *
 * This script can:
 * - Analyze ranking event statistics (e.g., acceptance rates by host, feature distributions)
 * - Replay events through SGD to retrain weights from historical data
 * - Export events for external analysis
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   npx tsx scripts/replay-ranking-events.ts --analyze              # show statistics only
 *   npx tsx scripts/replay-ranking-events.ts --retrain --user-id <uuid>
 *   npx tsx scripts/replay-ranking-events.ts --retrain --session-id <uuid>
 *   npx tsx scripts/replay-ranking-events.ts --retrain --days 7    # replay last 7 days
 *   npx tsx scripts/replay-ranking-events.ts --export --output events.json
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  RECOMMENDER_PRIORS,
  sgdUpdate,
  type RecommenderWeights,
  type RecommenderFeatures,
} from "@/lib/copilot/recommender-weights";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

function log(msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let analyze = false;
  let retrain = false;
  let exportEvents = false;
  let userId: string | null = null;
  let sessionId: string | null = null;
  let days = 30;
  let outputPath: string | null = null;
  
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--analyze") {
      analyze = true;
    } else if (argv[i] === "--retrain") {
      retrain = true;
    } else if (argv[i] === "--export") {
      exportEvents = true;
    } else if (argv[i] === "--user-id" && argv[i + 1]) {
      userId = argv[++i] ?? null;
    } else if (argv[i] === "--session-id" && argv[i + 1]) {
      sessionId = argv[++i] ?? null;
    } else if (argv[i] === "--days" && argv[i + 1]) {
      days = Math.max(1, parseInt(argv[++i], 10) || days);
    } else if (argv[i] === "--output" && argv[i + 1]) {
      outputPath = argv[++i] ?? null;
    }
  }
  
  if (!analyze && !retrain && !exportEvents) {
    analyze = true; // default to analyze
  }
  
  return { analyze, retrain, exportEvents, userId, sessionId, days, outputPath };
}

async function main() {
  const args = parseArgs();
  log("starting — loading Supabase client…");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    log("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Build query
  let query = supabase
    .schema("deal_intel")
    .from("copilot_ranking_event")
    .select("*");
  
  const cutoffDate = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();
  query = query.gte("created_at", cutoffDate);
  
  if (args.userId) {
    query = query.eq("user_id", args.userId);
  }
  
  if (args.sessionId) {
    query = query.eq("session_id", args.sessionId);
  }
  
  query = query.order("created_at", { ascending: true });
  
  log(`fetching ranking events (last ${args.days} days${args.userId ? `, user: ${args.userId}` : ""}${args.sessionId ? `, session: ${args.sessionId}` : ""})…`);
  
  const { data: events, error } = await query;
  
  if (error) {
    log(`ERROR: ${error.message}`);
    process.exit(1);
  }
  
  if (!events || events.length === 0) {
    log("no ranking events found");
    process.exit(0);
  }
  
  log(`found ${events.length} ranking events`);
  
  if (args.analyze) {
    await analyzeEvents(events);
  }
  
  if (args.retrain) {
    await retrainWeights(supabase, events, args.userId);
  }
  
  if (args.exportEvents) {
    await exportEventsToFile(events, args.outputPath);
  }
  
  log("done");
}

async function analyzeEvents(events: any[]) {
  log("\n=== Ranking Event Analysis ===\n");
  
  const total = events.length;
  const labeled = events.filter((e) => e.label !== null);
  const chosen = events.filter((e) => e.chosen === true);
  const notChosen = events.filter((e) => e.chosen === false);
  
  log(`Total events: ${total}`);
  log(`Labeled events: ${labeled.length} (${((labeled.length / total) * 100).toFixed(1)}%)`);
  log(`Chosen candidates: ${chosen.length} (${((chosen.length / total) * 100).toFixed(1)}%)`);
  log(`Not chosen: ${notChosen.length} (${((notChosen.length / total) * 100).toFixed(1)}%)`);
  
  // Label distribution
  const labelCounts: Record<number, number> = {};
  for (const e of labeled) {
    labelCounts[e.label] = (labelCounts[e.label] || 0) + 1;
  }
  log(`\nLabel distribution:`);
  log(`  0 (reject): ${labelCounts[0] || 0}`);
  log(`  1 (accept): ${labelCounts[1] || 0}`);
  
  // Host distribution
  const hostCounts: Record<string, number> = {};
  for (const e of events) {
    hostCounts[e.candidate_host] = (hostCounts[e.candidate_host] || 0) + 1;
  }
  const topHosts = Object.entries(hostCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  log(`\nTop 10 hosts by event count:`);
  for (const [host, count] of topHosts) {
    log(`  ${host}: ${count}`);
  }
  
  // Feature statistics
  const featureSums: Record<string, number> = {};
  const featureCounts: Record<string, number> = {};
  for (const e of events) {
    const features = e.features as RecommenderFeatures;
    for (const [key, value] of Object.entries(features)) {
      featureSums[key] = (featureSums[key] || 0) + value;
      featureCounts[key] = (featureCounts[key] || 0) + 1;
    }
  }
  log(`\nFeature averages:`);
  for (const [key, sum] of Object.entries(featureSums)) {
    const avg = sum / (featureCounts[key] || 1);
    log(`  ${key}: ${avg.toFixed(4)}`);
  }
}

async function retrainWeights(supabase: any, events: any[], userId: string | null) {
  log("\n=== Retraining Weights ===\n");
  
  // Load current weights or use priors
  let weights: RecommenderWeights = { ...RECOMMENDER_PRIORS };
  let updatesCount = 0;
  
  if (userId) {
    const { data: weightRow } = await supabase
      .schema("deal_intel")
      .from("copilot_recommender_weights")
      .select("weights, updates_count")
      .eq("user_id", userId)
      .maybeSingle();
    
    if (weightRow) {
      weights = weightRow.weights as RecommenderWeights;
      updatesCount = weightRow.updates_count || 0;
      log(`loaded existing weights (updates_count: ${updatesCount})`);
    } else {
      log(`no existing weights found for user, using priors`);
    }
  } else {
    log("no user-id specified, using priors as starting point");
  }
  
  // Filter to labeled events only
  const labeledEvents = events.filter((e) => e.label !== null);
  log(`retraining on ${labeledEvents.length} labeled events`);
  
  // Replay SGD updates
  let i = 0;
  for (const event of labeledEvents) {
    const features = event.features as RecommenderFeatures;
    const label = event.label as 0 | 1;
    
    weights = sgdUpdate({
      weights,
      features,
      label,
      sampleWeight: 1.0,
      updatesCount: i,
    });
    
    i++;
    if (i % 100 === 0) {
      log(`  processed ${i}/${labeledEvents.length} events`);
    }
  }
  
  log(`\nfinal weights after ${i} SGD updates:`);
  log(`  w_task: ${weights.w_task.toFixed(4)}`);
  log(`  w_freq: ${weights.w_freq.toFixed(4)}`);
  log(`  w_accept: ${weights.w_accept.toFixed(4)}`);
  log(`  w_reject: ${weights.w_reject.toFixed(4)}`);
  log(`  w_page: ${weights.w_page.toFixed(4)}`);
  log(`  bias: ${weights.bias.toFixed(4)}`);
  
  // Optionally save the retrained weights
  if (userId) {
    log(`\nsaving retrained weights for user ${userId}…`);
    await supabase
      .schema("deal_intel")
      .from("copilot_recommender_weights")
      .upsert(
        {
          user_id: userId,
          weights: weights as unknown as Record<string, number>,
          updates_count: updatesCount + i,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    log("weights saved successfully");
  } else {
    log("\nno user-id specified, weights not saved (dry run)");
  }
}

async function exportEventsToFile(events: any[], outputPath: string | null) {
  const filename = outputPath || `ranking-events-${Date.now()}.json`;
  log(`\nexporting ${events.length} events to ${filename}…`);
  
  const fs = await import("node:fs");
  fs.writeFileSync(filename, JSON.stringify(events, null, 2));
  log(`export complete`);
}

main().catch((err) => {
  log(`ERROR: ${err}`);
  process.exit(1);
});
