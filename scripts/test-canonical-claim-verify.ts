/**
 * Manual integration smoke-test for `runCanonicalClaimVerify`.
 *
 * Usage (from repo root, with `.env.local` / Vertex configured):
 *
 *   npm run test:canonical-verifier -- --meetingId=<uuid> [--keys=key1,key2]
 *
 * If `--keys` is omitted, uses the last 5 distinct `dedupe_key` values from `deal_intel.meeting_claim`
 * for that meeting (guest claims only).
 *
 * `deal_id` and `user_id` default from `deal_intel.meeting_session` for the meeting.
 *
 * Note: uses dynamic `import()` after `dotenv.config()` so `.env.local` is loaded before any
 * `@/lib/live-assistant/*` module initializes `model-env` (static imports would run too early).
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

function getArg(prefix: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(prefix));
  return raw?.slice(prefix.length).trim() || undefined;
}

async function main() {
  const meetingId = getArg("--meetingId=");
  if (!meetingId) {
    console.error(
      "Usage: npm run test:canonical-verifier -- --meetingId=<uuid> [--keys=k1,k2] [--dealId=<uuid>] [--userId=<uuid>] [--limit=5]",
    );
    process.exit(1);
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { runCanonicalClaimVerify } = await import("@/lib/live-assistant/claim-verifier");

  const admin = createAdminClient();

  let dealId = getArg("--dealId=");
  let userId = getArg("--userId=");
  if (!dealId || !userId) {
    const ses = await admin
      .schema("deal_intel")
      .from("meeting_session")
      .select("deal_id, host_user_id")
      .eq("id", meetingId)
      .maybeSingle();
    if (ses.error || !ses.data?.deal_id || !ses.data?.host_user_id) {
      console.error("meeting_session not found or missing deal_id/host_user_id:", ses.error?.message);
      process.exit(1);
    }
    dealId = dealId ?? String(ses.data.deal_id);
    userId = userId ?? String(ses.data.host_user_id);
  }

  let keys = getArg("--keys=")
    ?.split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const limit = Math.max(1, Math.min(20, Number(getArg("--limit=") ?? "5")));

  if (!keys?.length) {
    const mc = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("dedupe_key, speaker")
      .eq("meeting_id", meetingId)
      .order("updated_at", { ascending: false })
      .limit(80);
    const rows = (mc.data ?? []) as Array<{ dedupe_key?: string | null; speaker?: string | null }>;
    const seen = new Set<string>();
    keys = [];
    for (const r of rows) {
      const dk = String(r.dedupe_key ?? "").trim();
      if (!dk || seen.has(dk)) continue;
      if (String(r.speaker ?? "").startsWith("host:")) continue;
      seen.add(dk);
      keys.push(dk);
      if (keys.length >= limit) break;
    }
  }

  if (!keys?.length) {
    console.error("No claim dedupe keys found for this meeting (try persisting claims first or pass --keys=...)");
    process.exit(1);
  }

  console.log("[test-canonical-claim-verify] running", {
    meeting_id: meetingId,
    deal_id: dealId,
    user_id: userId,
    keys_count: keys.length,
    keys: keys.slice(0, 10),
  });

  const t0 = Date.now();
  await runCanonicalClaimVerify(admin, {
    meeting_id: meetingId,
    deal_id: dealId!,
    user_id: userId!,
    claim_dedupe_keys: keys,
  });
  console.log("[test-canonical-claim-verify] done_ms:", Date.now() - t0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
