/**
 * LiveKit transcription worker.
 *
 * For every meeting, this process subscribes to the LiveKit room, runs Deepgram STT,
 * persists transcript segments + semantic chunks, and routes findings into four KPI /
 * contradiction paths plus the question engine. Each path has a distinct cost / latency
 * profile and writes a stable `source_map.dedupe_key` so cards from different paths for
 * the same fact collapse into a single `meeting_assistant_event` row.
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────────┐
 *   │ Path     │ Trigger                                  │ Cost  │ Dedupe key shape     │
 *   ├──────────┼──────────────────────────────────────────┼───────┼──────────────────────┤
 *   │ Fast     │ Final segment + regex KPI hit            │ regex │ cmetric:{family}:{v} │
 *   │ Middle   │ Semantic chunk + looksKpiLike + regex    │ small │ cmetric:{family}:{v} │
 *   │          │ found nothing OR low conf OR no CRM map  │ LLM   │                      │
 *   │ Slow     │ Per-claim (queued in bg-worker)          │ big   │ cfact / cclaim /     │
 *   │          │ via `meeting_claim_reasoning`            │ LLM   │ cmetric:{family}:{v} │
 *   │ Deep     │ Periodic batch (queued in bg-worker)     │ big   │ cmetric / ctxt       │
 *   │          │ across non-adjacent semantic chunks      │ LLM   │                      │
 *   └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * All LLM-based paths run their `founder_quote` (and `record_quote` where applicable)
 * through `lib/live-assistant/quote-grounding.ts` before emitting; ungrounded outputs are
 * dropped, so a sentence about funding cannot be reported as a TAM contradiction.
 *
 * `createMeetingAssistantEvent` performs its own recent-rows dedupe regardless of `fast_lane`,
 * so cross-path duplicates collapse to one card without relying on the periodic sweep.
 * The `meeting_dedupe_contradictions` job exists as belt-and-suspenders cleanup only.
 */
import dotenv from "dotenv";

// Next.js loads `.env.local` automatically, but this standalone worker does not.
// Load `.env.local` first (if present), then `.env` / process env.
dotenv.config({ path: ".env.local" });
dotenv.config();
import { AccessToken } from "livekit-server-sdk";
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  dispose,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { STT as DeepgramSTT } from "@livekit/agents-plugin-deepgram";
import { stt as lkStt, initializeLogger } from "@livekit/agents";
import { createAdminClient } from "@/lib/supabase/admin";
import { TranscriptRingBuffer } from "@/lib/live-assistant/transcript";
import { createMeetingAssistantEvent } from "@/lib/live-assistant/tools";
import { contradictionFactDedupeKey } from "@/lib/live-assistant/contradiction";
import { runDeepContradictionBatch } from "@/lib/live-assistant/deep-contradictions";
import { SemanticChunkBuilder, type SemanticChunk } from "@/lib/live-assistant/chunker";
import { classifyClaimsFromChunk, type ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { confidenceForMetric, extractFastSignals } from "@/lib/live-assistant/fast-kpi";
import { runMeetingNotesTick } from "@/lib/live-assistant/notes";
import { runMeetingQuestionEngineTick } from "@/lib/live-assistant/question-engine-tick";
// `priority.ts` is intentionally unused for live-meeting slow reasoning: every claim that
// makes it past `shouldQueueSlowPath` already deserves prompt handling, and a flat high
// priority gives `meeting_claim_reasoning` consistent latency in the bg-worker queue.
import { loadLiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";
import { missingCoveragePrompts, updateCoverageState, type CoverageState } from "@/lib/live-assistant/coverage";
import { persistClassifiedClaimsForChunk, type PersistedMeetingClaimRow } from "@/lib/live-assistant/meeting-claims";
import { splitClaimTextOnConjunctions } from "@/lib/live-assistant/claim-segmenter";
import { runMeetingClaimAutoVerify } from "@/lib/live-assistant/claim-verify-auto";
import { runSlowReasoningForClaim } from "@/lib/live-assistant/reasoning";
import { runCanonicalClaimVerifyLite } from "@/lib/live-assistant/claim-verifier-lite";
import { GuestTurnTracker, type SettledTurn } from "@/lib/live-assistant/guest-turn-tracker";
import { runGuestTurnVerify } from "@/lib/live-assistant/guest-turn-verify";
import { dedupeContradictionEventsByFactKey } from "@/lib/live-assistant/dedupe-contradictions";
import {
  fetchDealIntelGroundingPack,
  kpiBufferMsFromEnv,
  kpiCanonicalDedupeKey,
  metricFamily,
  recordSnippetForMetric,
  type DealIntelGroundingPack,
} from "@/lib/live-assistant/deal-intel-grounding";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function livekitEnv() {
  return {
    url: env("LIVEKIT_URL"),
    apiKey: env("LIVEKIT_API_KEY"),
    apiSecret: env("LIVEKIT_API_SECRET"),
  };
}

type WorkerArgs = {
  meetingId: string;
  roomName: string;
};

function parseArgs(): WorkerArgs {
  const meetingId = process.argv.find((a) => a.startsWith("--meetingId="))?.split("=", 2)[1];
  const roomName = process.argv.find((a) => a.startsWith("--roomName="))?.split("=", 2)[1];
  if (!meetingId || !roomName) {
    throw new Error("Usage: tsx scripts/livekit-transcription-worker.ts --meetingId=<uuid> --roomName=<name>");
  }
  return { meetingId, roomName };
}

async function makeWorkerToken(roomName: string): Promise<string> {
  const { apiKey, apiSecret } = livekitEnv();
  const at = new AccessToken(apiKey, apiSecret, {
    identity: `worker:transcribe:${roomName}`,
    name: "Transcription worker",
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
  });
  return await at.toJwt();
}

function toSegmentKey(p: RemoteParticipant, ev: lkStt.SpeechEvent): string {
  const alt = ev.alternatives?.[0];
  const start = alt ? Math.floor(alt.startTime * 1000) : 0;
  const end = alt ? Math.floor(alt.endTime * 1000) : 0;
  return `${p.identity}:${start}:${end}`;
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function shouldQueueSlowPath(claim: ClassifiedClaim): boolean {
  const kpiSections = ["traction", "financials", "solution", "problem", "product", "market", "gtm"];
  const sectionOk =
    kpiSections.includes(claim.section) || ["competition", "risks"].includes(claim.section);
  // KPI slow-path: allow even when the number is implicit (e.g. "funding", "valuation") so it can be grounded.
  const isKpi =
    claim.intent === "metric" ||
    /\b(arr|mrr|revenue|growth|churn|runway|margin|burn|funding|raised|valuation|round|customer|logo|nrr|cac|ltv|users?)\b/i.test(
      claim.text,
    );
  if (isKpi && kpiSections.includes(claim.section)) return true;
  const strongCommit = /\b(will|plan to|committed|guarantee|raise|launch|ship by|signed|partnered)\b/i.test(claim.text);
  const numeric =
    /\d/.test(claim.text) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/i.test(claim.text);
  const externallyVerifiable =
    /\b(partnered with|customers include|signed with)\b/i.test(claim.text) ||
    (numeric && /\b(investor|raised|valuation|round)\b/i.test(claim.text));
  return sectionOk && (isKpi || externallyVerifiable || strongCommit);
}

function meetingClaimIdForClassifiedClaim(claim: ClassifiedClaim, persisted: PersistedMeetingClaimRow[]): string | null {
  const parts = splitClaimTextOnConjunctions(claim.text);
  for (const p of parts) {
    const row = persisted.find((r) => r.text === p);
    if (row) return row.id;
  }
  return null;
}

function looksKpiLike(text: string): boolean {
  const s = text.toLowerCase();
  // Quantitative-only: require a number and a unit-ish token (prevents triggering on generic "funding" chatter).
  const hasNumber = /\d/.test(s) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/.test(s);
  if (!hasNumber) return false;
  return (
    /\b(arr|mrr|revenue|growth|customer|churn|runway|burn|raised|valuation|round|seed|series|percent|%|\$|usd)\b/i.test(s)
  );
}

function dedupeHash(prefix: string, text: string): string {
  return (
    prefix +
    ":" +
    createHash("sha256")
      .update(text.toLowerCase().trim().slice(0, 600))
      .digest("hex")
      .slice(0, 16)
  );
}

function fmtNumber(n: number, unit: "usd" | "pct" | "count" | null): string {
  if (!Number.isFinite(n)) return String(n);
  if (unit === "pct") return `${(n * 100).toFixed(1)}%`;
  if (unit === "usd") {
    const abs = Math.abs(n);
    if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${Math.round(n)}`;
  }
  if (unit === "count") {
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return `${Math.round(n)}`;
  }
  return String(n);
}

type ContraWindow = { startMs: number; count: number };

type FastContraGate = {
  sawFirst: boolean;
  nextAllowedAtMs: number;
};

async function processFastKpiContradictions(
  admin: SupabaseClient,
  opts: {
    meetingId: string;
    text: string;
    quote: string;
    crm: DealIntelGroundingPack;
    recentCards: Map<string, number>;
    lastMetricInMeeting: Map<string, number>;
    contraWindow: ContraWindow;
    maxContradictionsPerMin: number;
    kpiBufferMs: number;
    fastContraGate: FastContraGate;
  },
): Promise<void> {
  const fast = extractFastSignals(opts.text);
  if (!fast.metrics.length) return;

  // Canonical verifier owns verdicts: when the flag is on we skip both the inline KPI
  // mismatch contradiction AND the in-meeting drift contradiction. Aligned + not-on-record
  // `crm_fact` rows still emit (they aren't verdicts), and `meeting_kpi_observation` rows
  // are still persisted upstream so the canonical verifier sees the numbers.
  const suppressContradictions = envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false);

  const crmTraction = opts.crm?.traction ?? null;
  const tractionHint = (family: string): string[] => {
    if (!crmTraction) return [];
    if (family === "funding") {
      const raised = Array.isArray(crmTraction.money_raised_per_stage) ? crmTraction.money_raised_per_stage : [];
      const inv = Array.isArray(crmTraction.investor_list) ? crmTraction.investor_list : [];
      return [
        raised.length ? `money_raised_per_stage: ${raised.slice(0, 3).join(" | ")}` : "",
        inv.length ? `investor_list: ${inv.slice(0, 5).join(", ")}` : "",
      ].filter(Boolean);
    }
    if (family === "revenue") {
      return crmTraction.revenue_data ? [`revenue_data: ${String(crmTraction.revenue_data).slice(0, 220)}`] : [];
    }
    if (family === "customers") {
      const partners = (crmTraction.notable_partners_or_customors ?? crmTraction.notable_partners_or_customers) as string[] | null | undefined;
      return [
        crmTraction.customer_size_and_count ? `customer_size_and_count: ${String(crmTraction.customer_size_and_count).slice(0, 220)}` : "",
        Array.isArray(partners) && partners.length ? `notable_partners_or_customers: ${partners.slice(0, 4).join(", ")}` : "",
      ].filter(Boolean);
    }
    if (family === "growth") {
      return crmTraction.growth_trends_description ? [`growth_trends_description: ${String(crmTraction.growth_trends_description).slice(0, 220)}`] : [];
    }
    return [];
  };

  const top = fast.metrics.slice(0, 5);

  const shouldDelayFastContra = (): boolean => {
    const delayEnabled = envFlag("LIVE_ASSISTANT_FAST_CONTRA_DELAY", true);
    if (!delayEnabled) return false;
    if (!opts.fastContraGate.sawFirst) return false; // first one is immediate
    return Date.now() < opts.fastContraGate.nextAllowedAtMs;
  };

  const markFastContraEmitted = () => {
    const now = Date.now();
    if (!opts.fastContraGate.sawFirst) {
      opts.fastContraGate.sawFirst = true;
      opts.fastContraGate.nextAllowedAtMs = now; // no delay until after the first is emitted
      return;
    }
    const minMs = Math.max(2_000, Number(process.env.LIVE_ASSISTANT_FAST_CONTRA_DELAY_MIN_MS ?? 4_000));
    const maxMs = Math.max(minMs + 1000, Number(process.env.LIVE_ASSISTANT_FAST_CONTRA_DELAY_MAX_MS ?? 14_000));
    const jitter = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    opts.fastContraGate.nextAllowedAtMs = now + jitter;
  };

  for (const m of top) {
    const conf = confidenceForMetric(m.sourceText, m.key, m.rawValue);
    if (conf < 0.62) continue;

    const recVal = recordSnippetForMetric(m.key, opts.crm);
    const unitHint: "usd" | "pct" | "count" | null =
      m.unit === "percent"
        ? "pct"
        : m.unit === "usd" || /\b(arr|mrr|revenue|fund|raise|valuation|round|raised)\b/i.test(m.key)
          ? "usd"
          : "count";

    const founderVal = m.normalizedValue;
    const recordVal = recVal?.recordValue ?? null;
    const diffAbs = recordVal == null ? null : founderVal - recordVal;
    const diffRatio = recordVal == null || recordVal === 0 ? null : Math.abs(diffAbs ?? 0) / Math.abs(recordVal);
    const mismatchHard = diffRatio != null && diffRatio >= 0.22;

    const baseLines: string[] = [];
    baseLines.push(`Founder said: ${m.key} = ${m.rawValue} (≈ ${fmtNumber(founderVal, unitHint)})`);
    if (recVal) baseLines.push(`Our records: ${recVal.recordText} (≈ ${fmtNumber(recVal.recordValue, unitHint)})`);

    const verifyQuery = `${m.key} ${m.rawValue}`.trim();
    const fam = metricFamily(m.key);
    const canonDedupe = `kpi:${kpiCanonicalDedupeKey(opts.meetingId, fam, founderVal)}`;

    // When the canonical verifier owns verdicts and we detected a real mismatch, drop the
    // utterance entirely from the fast emit pipeline (no aligned card either) — falling
    // through to the `else if (recVal)` branch would mislabel a mismatch as "KPI vs CRM
    // (aligned)".
    if (mismatchHard && suppressContradictions) {
      continue;
    }

    if (mismatchHard && diffAbs != null && diffRatio != null) {
      // Cross-path fact-anchored key so this card collapses with the same fact emitted by
      // middle-path / slow / deep paths in `createMeetingAssistantEvent`. Anchored on the
      // normalized founder value so different label paraphrases (e.g. fast says "arr" /
      // middle says "annual recurring revenue") still hash to the same key.
      const factDk = contradictionFactDedupeKey(opts.meetingId, {
        metricFamily: fam,
        normalizedValue: founderVal,
        founderQuote: opts.quote,
      });
      // In-memory rate-limit key (unchanged): keeps the fast path from re-emitting on every chunk.
      const rateLimitKey = canonDedupe;
      const last = opts.recentCards.get(rateLimitKey) ?? 0;
      if (Date.now() - last >= opts.kpiBufferMs) {
        if (shouldDelayFastContra()) continue;
        opts.recentCards.set(rateLimitKey, Date.now());
        const lines = [...baseLines];
        lines.push(`Gap: ${fmtNumber(diffAbs, unitHint)} (${(diffRatio * 100).toFixed(0)}% vs CRM)`);
        lines.push("");
        lines.push("Follow-up: Confirm definition, timeframe, and source for this number.");
        await createMeetingAssistantEvent(admin, {
          meeting_id: opts.meetingId,
          kind: "contradiction",
          severity: diffRatio >= 0.55 ? "high" : "med",
          title: "KPI mismatch vs CRM",
          body: lines.join("\n"),
          source_map: {
            lane: "attention",
            fast_lane: true,
            kind: "kpi_mismatch_fast",
            metric_key: m.key,
            metric_family: fam,
            founder_value: founderVal,
            record_value: recordVal,
            diff_abs: diffAbs,
            diff_ratio: diffRatio,
            confidence: conf,
            verify_query: verifyQuery,
            quote: opts.quote.slice(0, 280),
            dedupe_key: factDk,
            local_rate_limit_key: rateLimitKey,
          },
        });
        markFastContraEmitted();
      }
    } else if (recVal) {
      const dk = `align:${canonDedupe}`;
      const last = opts.recentCards.get(dk) ?? 0;
      if (Date.now() - last >= opts.kpiBufferMs) {
        opts.recentCards.set(dk, Date.now());
        await createMeetingAssistantEvent(admin, {
          meeting_id: opts.meetingId,
          kind: "crm_fact",
          severity: "low",
          title: "KPI vs CRM (aligned)",
          body: baseLines.join("\n"),
          source_map: {
            lane: "context",
            fast_lane: true,
            kind: "kpi_capture_fast",
            metric_key: m.key,
            normalized_value: founderVal,
            unit: m.unit,
            confidence: conf,
            verify_query: verifyQuery,
            quote: opts.quote.slice(0, 280),
            dedupe_key: dk,
          },
        });
      }
    } else if (!recVal) {
      const dk = `norcd:${canonDedupe}`;
      const last = opts.recentCards.get(dk) ?? 0;
      if (Date.now() - last >= opts.kpiBufferMs) {
        opts.recentCards.set(dk, Date.now());
        // Not-on-record should still show what we *do* have in CRM traction fields (if anything).
        const lines: string[] = [];
        lines.push(`Founder said: ${m.key} = ${m.rawValue} (≈ ${fmtNumber(founderVal, unitHint)})`);
        const famHints = tractionHint(fam);
        if (famHints.length) {
          lines.push(`Our records (closest CRM fields for ${fam}):`);
          for (const h of famHints) lines.push(`- ${h}`);
        } else {
          lines.push("Our records: no matching numeric value found in company facts, traction fields, ingested claims, or fact nodes for this metric family.");
        }
        lines.push("");
        lines.push("Follow-up: Add the source document or CRM field, or confirm the number live.");
        await createMeetingAssistantEvent(admin, {
          meeting_id: opts.meetingId,
          kind: "crm_fact",
          severity: "low",
          title: "KPI not on record",
          body: lines.join("\n"),
          source_map: {
            lane: "context",
            fast_lane: true,
            kind: "kpi_not_on_record_fast",
            metric_key: m.key,
            normalized_value: founderVal,
            confidence: conf,
            verify_query: verifyQuery,
            quote: opts.quote.slice(0, 280),
            dedupe_key: dk,
          },
        });
      }
    }

    const prevVal = opts.lastMetricInMeeting.get(m.key);
    const driftFromPrev =
      prevVal == null || !Number.isFinite(prevVal)
        ? 0
        : prevVal === 0
          ? Math.abs(m.normalizedValue - prevVal)
          : Math.abs(m.normalizedValue - prevVal) / Math.abs(prevVal);
    const driftHard = driftFromPrev > 0.3;
    if (driftHard && conf >= 0.62 && !suppressContradictions) {
      if (Date.now() - opts.contraWindow.startMs > 60_000) {
        opts.contraWindow.startMs = Date.now();
        opts.contraWindow.count = 0;
      }
      if (opts.contraWindow.count < opts.maxContradictionsPerMin) {
        // KPI drift inside the meeting is still about the same fact (metric family + value
        // bucket) — share the key so it doesn't pile a separate "drift" card on top of an
        // existing CRM mismatch card for the same number.
        const factDk = contradictionFactDedupeKey(opts.meetingId, {
          metricFamily: fam,
          normalizedValue: m.normalizedValue,
          founderQuote: opts.quote,
        });
        const rateLimitKey = `drift:${kpiCanonicalDedupeKey(opts.meetingId, fam, m.normalizedValue)}`;
        const last = opts.recentCards.get(rateLimitKey) ?? 0;
        if (Date.now() - last >= opts.kpiBufferMs) {
          if (shouldDelayFastContra()) continue;
          opts.recentCards.set(rateLimitKey, Date.now());
          opts.contraWindow.count += 1;
          const recLine = recVal ? `Our records: ${recVal.recordText} (≈ ${fmtNumber(recVal.recordValue, unitHint)})` : null;
          const lines: string[] = [];
          lines.push(`Founder said: ${m.key} = ${m.rawValue} (≈ ${fmtNumber(founderVal, unitHint)})`);
          if (recLine) lines.push(recLine);
          if (prevVal != null && Number.isFinite(prevVal)) lines.push(`Earlier in meeting: ${m.key} ≈ ${fmtNumber(prevVal, unitHint)}`);
          lines.push("");
          lines.push(`Drift: ${(driftFromPrev * 100).toFixed(0)}% vs earlier in this meeting.`);
          lines.push("Follow-up: Clarify which number is correct and why it changed.");
          await createMeetingAssistantEvent(admin, {
            meeting_id: opts.meetingId,
            kind: "contradiction",
            severity: "high",
            title: "KPI drift (in meeting)",
            body: lines.join("\n"),
            source_map: {
              lane: "attention",
              fast_lane: true,
              kind: "kpi_drift_fast",
              metric_key: m.key,
              metric_family: fam,
              normalized_value: m.normalizedValue,
              unit: m.unit,
              confidence: conf,
              drift_ratio: driftFromPrev,
              verify_query: verifyQuery,
              quote: opts.quote.slice(0, 280),
              dedupe_key: factDk,
              local_rate_limit_key: rateLimitKey,
            },
          });
          markFastContraEmitted();
        }
      }
    }
  }

  for (const m of top) {
    opts.lastMetricInMeeting.set(m.key, m.normalizedValue);
  }
}

async function main() {
  initializeLogger({ pretty: true, level: process.env.LIVEKIT_AGENT_LOG_LEVEL || "info" });

  const { meetingId, roomName } = parseArgs();
  const { url } = livekitEnv();

  const admin = createAdminClient();
  const ring = new TranscriptRingBuffer({ maxWindowMs: 15 * 60_000 });
  const chunkBuilder = new SemanticChunkBuilder({
    pauseMs: Number(process.env.LIVE_ASSISTANT_CHUNK_PAUSE_MS || 1200),
    minTokens: Number(process.env.LIVE_ASSISTANT_CHUNK_MIN_TOKENS || 10),
    maxTokens: Number(process.env.LIVE_ASSISTANT_CHUNK_MAX_TOKENS || 70),
  });
  const turnTracker = new GuestTurnTracker({
    meetingId,
    settleMs: Number(process.env.LIVE_ASSISTANT_TURN_SETTLE_MS || 2500),
  });
  const revisions = new Map<string, number>();
  const recentCards = new Map<string, number>(); // dedupe_key -> last_ms
  let coverageState: CoverageState | undefined;
  let crmSnapshotCache: { atMs: number; dealId: string; snap: DealIntelGroundingPack } | null = null;
  const kpiBufferMs = kpiBufferMsFromEnv();
  const useKpiMiddlePath = envFlag("LIVE_ASSISTANT_KPI_MIDDLE_PATH", true);
  const lastMetricInMeeting = new Map<string, number>();
  const kpiFastOrMidOnce = new Set<string>();
  const useChunkClassifier = envFlag("LIVE_ASSISTANT_USE_CHUNK_CLASSIFIER", true);
  const useFastKpi = envFlag("LIVE_ASSISTANT_USE_FAST_KPI", true);
  const telemetry = {
    chunkFinalize: new Map<string, number>(),
    fastPathHits: 0,
    queuedSlowPath: 0,
  };
  let lastNotesTickAt = 0;
  const maxContradictionsPerMin = Math.max(1, Math.min(20, Number(process.env.LIVE_ASSISTANT_MAX_CONTRADICTIONS_PER_MIN || 4)));
  const contraWindow: ContraWindow = { startMs: Date.now(), count: 0 };
  const deepBatchBaseSeconds = Math.max(10, Math.min(180, Number(process.env.LIVE_ASSISTANT_DEEP_BATCH_SECONDS || 55)));
  // Deep batches are off by default (slow/auto-verify/middle path cover most cases; deep often repeats late).
  // Set LIVE_ASSISTANT_DEEP_CONTRA=true to turn batch deep contradictions back on.
  const deepBatchEnabled = envFlag("LIVE_ASSISTANT_DEEP_CONTRA", false);
  const deepBatchDirect = envFlag("LIVE_ASSISTANT_DEEP_CONTRA_DIRECT", process.env.NODE_ENV === "development");
  let lastDeepBatchAt = 0;
  let lastQuestionEngineTickAt = 0;
  let lastFastContraDedupeEnqAt = 0;
  const fastContraGate: FastContraGate = { sawFirst: false, nextAllowedAtMs: 0 };

  const meeting = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, deal_id, host_user_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (!meeting.data?.deal_id || !meeting.data?.host_user_id) {
    throw new Error(`meeting_session not found (or missing deal_id/host_user_id) for meetingId=${meetingId}`);
  }
  const dealId = String(meeting.data.deal_id);
  const hostUserId = String(meeting.data.host_user_id);
  const preferenceSignals = await loadLiveAssistantPreferenceSignals(admin, hostUserId);

  const loadGroundingPack = async (): Promise<DealIntelGroundingPack> => {
    const now = Date.now();
    if (crmSnapshotCache && crmSnapshotCache.dealId === dealId && now - crmSnapshotCache.atMs < 25_000) {
      return crmSnapshotCache.snap;
    }
    const snap = await fetchDealIntelGroundingPack(admin, dealId);
    crmSnapshotCache = { atMs: now, dealId, snap };
    return snap;
  };

  const processSemanticChunk = async (ch: SemanticChunk) => {
      telemetry.chunkFinalize.set(ch.finalizeReason, (telemetry.chunkFinalize.get(ch.finalizeReason) ?? 0) + 1);
      // Persist semantic chunk for meeting-native contradiction pipeline.
      const chunkIns = await admin
        .schema("deal_intel")
        .from("meeting_semantic_chunk")
        .insert({
          meeting_id: meetingId,
          speaker: ch.speaker,
          t_start_ms: ch.startedAtMs,
          t_end_ms: ch.endedAtMs,
          text: ch.text,
          finalize_reason: ch.finalizeReason,
          source_segment_keys: ch.sourceSegments.map((s) => s.segmentId),
        })
        .select("id")
        .maybeSingle();
      if (chunkIns.error) {
        console.error("meeting_semantic_chunk insert failed", chunkIns.error.message || String(chunkIns.error));
      }
      const meetingChunkId = chunkIns.data?.id ? String(chunkIns.data.id) : null;

      // Canonical verifier (per-guest-turn): in canonical mode we route every chunk through
      // `turnTracker`, which coalesces multi-chunk utterances and fires `runGuestTurnVerify`
      // exactly once per settled guest turn. Per-chunk emission would generate duplicate /
      // partial cards. When the flag is off, the legacy auto-verify / slow-reasoning paths
      // below own the verdict surface (this block is a no-op).
      if (envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false)) {
        turnTracker.ingestChunk(ch);
      }

      let fastChunkForClaims: ReturnType<typeof extractFastSignals> | null = null;
      if (useFastKpi) {
        // NOTE: We intentionally do NOT emit fast KPI contradictions from semantic chunks.
        // Fast contradictions should be driven by final transcript segments (more precise, less spammy).
        fastChunkForClaims = extractFastSignals(ch.text);

        // Decide whether to enqueue the LLM middle path. Trigger when:
        //   (a) the chunk looks KPI-ish but the fast regex found nothing, OR
        //   (b) it found metrics but every match is low-confidence, OR
        //   (c) it found metrics but none of them mapped to a CRM record.
        // The third case is what catches "$5M ARR" when CRM stores it as "5M USD ARR" under
        // a different key — the fast path can read the number but has no CRM anchor, and
        // the middle-path LLM is what crosses that gap.
        if (useKpiMiddlePath && looksKpiLike(ch.text)) {
          let needsMidPath = !fastChunkForClaims.metrics.length;
          if (!needsMidPath) {
            const allLowConfidence = fastChunkForClaims.metrics.every(
              (m) => confidenceForMetric(m.sourceText, m.key, m.rawValue) < 0.62,
            );
            if (allLowConfidence) {
              needsMidPath = true;
            } else {
              try {
                const crm = await loadGroundingPack();
                const noneMapped = fastChunkForClaims.metrics.every((m) => !recordSnippetForMetric(m.key, crm));
                if (noneMapped) needsMidPath = true;
              } catch {
                // best-effort: if CRM load fails, skip the mapping check
              }
            }
          }
          if (needsMidPath) {
            const midDk = dedupeHash("kpi_mid_enq", `${meetingId}:${ch.text.toLowerCase().trim().slice(0, 400)}`);
            const last = recentCards.get(midDk) ?? 0;
            if (Date.now() - last >= kpiBufferMs) {
              recentCards.set(midDk, Date.now());
              await admin.rpc("deal_intel_enqueue_job", {
                p_job_type: "meeting_kpi_middle",
                p_subject_kind: "meeting",
                p_subject_id: meetingId,
                p_payload: {
                  meeting_id: meetingId,
                  deal_id: dealId,
                  user_id: hostUserId,
                  chunk_text: ch.text,
                  dedupe_key: midDk,
                },
                p_priority: 75,
              });
            }
          }
        }
        if (meetingChunkId && fastChunkForClaims.metrics.length) {
          const rows = fastChunkForClaims.metrics.map((m) => {
            const dk = dedupeHash("kpi", `${meetingId}:${m.key}:${m.rawValue}:${m.unit}:${ch.startedAtMs}`);
            return {
              meeting_id: meetingId,
              chunk_id: meetingChunkId,
              section: m.key.includes("arr") || m.key.includes("revenue") || m.key.includes("growth") ? "traction" : "other",
              metric_key: m.key,
              raw_value_text: m.rawValue,
              normalized_value_number: m.normalizedValue,
              unit: m.unit,
              confidence: confidenceForMetric(m.sourceText, m.key, m.rawValue),
              source_text: m.sourceText,
              dedupe_key: dk,
            };
          });
          await admin.schema("deal_intel").from("meeting_kpi_observation").upsert(rows, { onConflict: "meeting_id,dedupe_key" });
        }
      }
      let claims: ClassifiedClaim[] = [];
      // Host turns are diligence prompts, not assertions about the company. Skipping the
      // classifier entirely for host chunks prevents host questions from being persisted as
      // `meeting_claim` rows and from triggering "Claim check" cards. Host chunks still flow
      // into `meeting_semantic_chunk` and `meeting_question_span` (where they belong) so
      // ClaimContext can use the host's verbatim ask as the topic anchor for the next guest
      // reply.
      const isHostChunk = ch.speaker.startsWith("host:");
      if (useChunkClassifier && !isHostChunk) {
        try {
          claims = await classifyClaimsFromChunk(ch.text);
        } catch (e) {
          console.error("claim classifier error", e);
        }
      }
      if (!isHostChunk && !claims.length) {
        claims = (fastChunkForClaims ?? extractFastSignals(ch.text)).claims;
      }

      const { dedupeKeys: claimDedupeKeys, persisted: persistedClaims } = await persistClassifiedClaimsForChunk(admin, {
        meetingId,
        chunkId: meetingChunkId,
        speaker: ch.speaker,
        tStartMs: ch.startedAtMs,
        tEndMs: ch.endedAtMs,
        claims,
      });

      // Canonical verifier flag: when on, the lite verifier (fired inline above on the
      // chunk insert) is the only writer of canonical claim_verification cards, and the
      // legacy auto-verify / slow-reasoning paths are skipped. When off, the legacy
      // per-claim auto-verify enqueue runs as before.
      const useCanonicalVerifier = envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false);

      if (claimDedupeKeys.length && !useCanonicalVerifier) {
        try {
          await admin.rpc("deal_intel_enqueue_job", {
            p_job_type: "meeting_claim_auto_verify",
            p_subject_kind: "meeting",
            p_subject_id: meetingId,
            p_payload: {
              meeting_id: meetingId,
              deal_id: dealId,
              user_id: hostUserId,
              claim_dedupe_keys: claimDedupeKeys,
            },
            p_priority: 60,
          });
        } catch (e) {
          console.warn("meeting_claim_auto_verify enqueue", e);
        }
        if (envFlag("LIVE_ASSISTANT_BG_JOB_DIRECT", process.env.NODE_ENV !== "production")) {
          void runMeetingClaimAutoVerify(admin, {
            meeting_id: meetingId,
            deal_id: dealId,
            user_id: hostUserId,
            claim_dedupe_keys: claimDedupeKeys,
          }).catch(() => {});
        }
      }

      // Notes: enqueue periodic tick (never inline in audio callback).
      if (envFlag("LIVE_ASSISTANT_NOTES", true)) {
        const nowNotes = Date.now();
        const pollMs = Math.max(3000, Math.min(12_000, Number(process.env.LIVE_ASSISTANT_NOTES_TICK_MS || 5000)));
        if (nowNotes - lastNotesTickAt > pollMs) {
          lastNotesTickAt = nowNotes;
          try {
            await admin.rpc("deal_intel_enqueue_job", {
              p_job_type: "meeting_notes_tick",
              p_subject_kind: "meeting",
              p_subject_id: meetingId,
              p_payload: {
                meeting_id: meetingId,
                deal_id: dealId,
                user_id: hostUserId,
              },
              p_priority: 45,
            });
          } catch {
            // ignore
          }

          // Dev-quality-of-life: if the bg worker isn't running, notes would never refresh.
          // Run in the background (do not await) so transcription isn't blocked.
          if (envFlag("LIVE_ASSISTANT_BG_JOB_DIRECT", process.env.NODE_ENV !== "production")) {
            void runMeetingNotesTick(admin, { meetingId, userId: hostUserId, pref: preferenceSignals }).catch(() => {});
          }
        }
      }

      const nowTick = Date.now();
      const qPollMs = Math.max(3000, Math.min(12_000, Number(process.env.LIVE_ASSISTANT_Q_TICK_MS || 5000)));
      if (nowTick - lastQuestionEngineTickAt > qPollMs) {
        lastQuestionEngineTickAt = nowTick;
        try {
          await admin.rpc("deal_intel_enqueue_job", {
            p_job_type: "meeting_question_engine_tick",
            p_subject_kind: "meeting",
            p_subject_id: meetingId,
            p_payload: {
              meeting_id: meetingId,
              deal_id: dealId,
              user_id: hostUserId,
              chunk_text: ch.text,
              t_start_ms: ch.startedAtMs,
              t_end_ms: ch.endedAtMs,
              is_host: ch.speaker.startsWith("host:"),
            },
            p_priority: 35,
          });
        } catch (e) {
          console.warn("meeting_question_engine_tick enqueue", e);
        }

        // Same dev QoL: ensure question matching / answered-state advances even without bg-worker.
        if (envFlag("LIVE_ASSISTANT_BG_JOB_DIRECT", process.env.NODE_ENV !== "production")) {
          void runMeetingQuestionEngineTick(admin, {
            meeting_id: meetingId,
            deal_id: dealId,
            user_id: hostUserId,
            chunk_text: ch.text,
            t_start_ms: ch.startedAtMs,
            t_end_ms: ch.endedAtMs,
            is_host: ch.speaker.startsWith("host:"),
          }).catch(() => {});
        }
      }

      coverageState = updateCoverageState(
        coverageState,
        claims.map((c) => ({ section: c.section, text: c.text })),
      );

      const coveragePrompts = missingCoveragePrompts(coverageState).slice(0, 2);
      for (const prompt of coveragePrompts) {
        const dk = dedupeHash("coverage", prompt);
        const last = recentCards.get(dk) ?? 0;
        if (Date.now() - last < 120_000) continue;
        recentCards.set(dk, Date.now());
        await createMeetingAssistantEvent(admin, {
          meeting_id: meetingId,
          kind: "suggested_question",
          severity: "low",
          title: "Coverage prompt",
          body: prompt,
          source_map: { lane: "memo", kind: "coverage_prompt", chunk_id: ch.chunkId, dedupe_key: dk },
        });
      }

      // Slow-reasoning priority is intentionally flat. `shouldQueueSlowPath` already filters
      // to KPI-shaped claims, and this is a live-meeting path: per-claim score-based ordering
      // (which used to return ~130–215, the lowest priority bucket) just added wait time vs
      // queued research jobs. A constant low number ensures contradiction cards land within
      // a few seconds rather than ~15s.
      const SLOW_REASONING_QUEUE_PRIORITY = 25;
      // Canonical verifier owns the verdict surface — when it's enabled, the slow-reasoning
      // loop would compete for the same `cclaim:` dedupe key and re-emit "Possible
      // contradiction" cards the canonical path is already writing. Skip enqueue + direct.
      const slowReasoningSuppressedByCanonical = useCanonicalVerifier;
      for (const claim of claims.slice(0, 5)) {
        if (slowReasoningSuppressedByCanonical) break;
        if (!shouldQueueSlowPath(claim)) continue;
        const meetingClaimId = meetingClaimIdForClassifiedClaim(claim, persistedClaims);
        const reasoningPayload = {
          meeting_id: meetingId,
          deal_id: dealId,
          user_id: hostUserId,
          quote: claim.text,
          section: claim.section,
          intent: claim.intent,
          confidence: claim.confidence,
          chunk_id: ch.chunkId,
          source_text: ch.text,
          meeting_claim_id: meetingClaimId,
          preference_hints: preferenceSignals.focusHints.slice(0, 3),
          preference_context: {
            hints: preferenceSignals.focusHints.slice(0, 4),
            sectionWeights: preferenceSignals.sectionWeights,
            preferredDomains: preferenceSignals.websiteDomains.slice(0, 5),
            confidence: preferenceSignals.preferenceConfidence,
          },
          dedupe_key: dedupeHash("slow", `${meetingId}:${claim.section}:${claim.intent}:${claim.text}`),
        };
        // Slow contradiction reasoning runs only via the bg-worker queue (`runSlowReasoningForClaim`
        // in `lib/live-assistant/reasoning.ts`). The legacy inline-LLM branch was removed because
        // it duplicated the same prompt with a narrower fact set, raced the queued path on dedupe,
        // and bypassed the new quote-grounding guardrails.
        await admin.rpc("deal_intel_enqueue_job", {
          p_job_type: "meeting_claim_reasoning",
          p_subject_kind: "meeting",
          p_subject_id: meetingId,
          p_payload: reasoningPayload,
          p_priority: SLOW_REASONING_QUEUE_PRIORITY,
        });
        telemetry.queuedSlowPath += 1;

        // Mirrors the auto-verify and notes-tick pattern: when no bg-worker is draining the
        // queue (dev) or the queue stalls (prod), run the same handler in-process on a
        // background promise. The queued path is still authoritative; whichever wins, the
        // recent-rows dedupe in `createMeetingAssistantEvent` collapses any duplicate output
        // because both paths share the same `cclaim:` dedupe key.
        if (envFlag("LIVE_ASSISTANT_BG_JOB_DIRECT", process.env.NODE_ENV !== "production")) {
          void runSlowReasoningForClaim(admin, {
            meetingId,
            userId: hostUserId,
            dealId,
            claim: {
              text: claim.text,
              section: claim.section,
              intent: claim.intent,
              confidence: claim.confidence,
            },
            sourceText: ch.text,
            meetingClaimId,
            preferenceContext: reasoningPayload.preference_context,
          }).catch(() => {});
        }
      }

      // Deep batch: enqueue every N seconds per meeting.
      if (deepBatchEnabled) {
        const now = Date.now();
        // Adaptive scheduling: tick faster when deep contradictions are sparse (reduce time-to-first),
        // then back off once we already have several (avoid over-triggering / cost).
        let deepBatchSeconds = deepBatchBaseSeconds;
        try {
          const recentDeep = await admin
            .schema("deal_intel")
            .from("meeting_assistant_event")
            .select("id, source_map")
            .eq("meeting_id", meetingId)
            .eq("kind", "contradiction")
            .gte("created_at", new Date(Date.now() - 60_000).toISOString())
            .limit(200);
          if (!recentDeep.error) {
            const rows = (recentDeep.data ?? []) as Array<{ source_map: unknown }>;
            const deepCount = rows.filter((r) => {
              const sm = r.source_map && typeof r.source_map === "object" ? (r.source_map as Record<string, unknown>) : {};
              const k = typeof sm.kind === "string" ? sm.kind : "";
              return k.startsWith("deep_");
            }).length;
            if (deepCount <= 0) deepBatchSeconds = 22;
            else if (deepCount <= 2) deepBatchSeconds = 30;
            else if (deepCount <= 4) deepBatchSeconds = 40;
            else deepBatchSeconds = Math.max(45, deepBatchBaseSeconds);
          }
        } catch {
          // ignore adaptive failures
        }

        if (now - lastDeepBatchAt > deepBatchSeconds * 1000) {
          lastDeepBatchAt = now;
          for (const section of ["traction", "solution", "problem"]) {
            if (deepBatchDirect) {
              // Dev fallback: run deep contradiction batch inline when bg-worker isn't running.
              await runDeepContradictionBatch(admin, { meetingId, dealId, userId: hostUserId, section });
            } else {
              await admin.rpc("deal_intel_enqueue_job", {
                p_job_type: "meeting_deep_contradictions",
                p_subject_kind: "meeting",
                p_subject_id: meetingId,
                p_payload: {
                  meeting_id: meetingId,
                  deal_id: dealId,
                  user_id: hostUserId,
                  section,
                },
                // Lower numeric = higher priority in our queue.
                p_priority: 18,
              });
            }
          }
        }
      }
  };

  const room = new Room();
  const token = await makeWorkerToken(roomName);
  await room.connect(url, token, { autoSubscribe: true, dynacast: true });
  console.log("transcription worker connected", { roomName, meetingId });

  // Single source of truth for guest-turn verdicts in canonical mode. Listener fires once
  // when the tracker decides the guest turn has settled (speaker switch or pause settle).
  turnTracker.onGuestTurnSettled((turn: SettledTurn) => {
    if (!envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false)) return;
    const recentTurns = turnTracker.getRecentDialogue(4);
    void runGuestTurnVerify(admin, {
      meetingId,
      dealId,
      userId: hostUserId,
      turn,
      recentTurns,
    }).catch((e) => {
      console.warn("[guest-turn-verify] inline failed", e instanceof Error ? e.message : e);
    });
  });

  const watchdogMs = Math.max(200, Math.min(5000, Number(process.env.LIVE_ASSISTANT_CHUNK_WATCHDOG_MS ?? 500)));
  const chunkWatchdog = setInterval(() => {
    void (async () => {
      try {
        const idleChunks = chunkBuilder.flushIdle(Date.now());
        for (const ch of idleChunks) {
          await processSemanticChunk(ch);
        }
        // Settle any open turn that has been silent past the configured threshold; the
        // listener registered above fires for guest turns so verdict cards land within ~1s
        // of the founder finishing speaking.
        turnTracker.tickIdle(Date.now());
      } catch (e) {
        console.error("chunk watchdog error", e);
      }
    })();
  }, watchdogMs);

  const dgStt = new DeepgramSTT({
    apiKey: process.env.DEEPGRAM_API_KEY,
    interimResults: true,
    punctuate: true,
    smartFormat: true,
    model: "nova-3",
    sampleRate: 16000,
    numChannels: 1,
    diarize: false,
  });

  const handleSpeechEvent = async (p: RemoteParticipant, ev: lkStt.SpeechEvent) => {
    let delta: ReturnType<TranscriptRingBuffer["upsert"]>;

    if (ev.alternatives?.length) {
      const a = ev.alternatives[0]!;
      const text = String(a.text || "").trim();
      if (!text) return;

      const segmentId = toSegmentKey(p, ev);
      const prevRev = revisions.get(segmentId) ?? 0;
      const isFinal =
        ev.type === lkStt.SpeechEventType.FINAL_TRANSCRIPT || ev.type === lkStt.SpeechEventType.END_OF_SPEECH;

      delta = ring.upsert({
        segmentId,
        tStartMs: Math.floor(a.startTime * 1000),
        tEndMs: Math.floor(a.endTime * 1000),
        speaker: a.speakerId ? String(a.speakerId) : p.identity,
        text,
        isFinal,
        revision: prevRev,
      });
    } else if (ev.type === lkStt.SpeechEventType.END_OF_SPEECH) {
      // Deepgram sends EOS with no alternatives; finalize the latest open segment for this speaker.
      delta = ring.finalizeLatestNonFinalForIdentity(p.identity, (segmentId) => revisions.get(segmentId) ?? 0);
    } else {
      return;
    }

    if (!delta) return;

    revisions.set(delta.segment.segmentId, delta.segment.revision);

    // Append-only persistence: write a new row per revision.
    await admin.schema("deal_intel").from("meeting_transcript_segment").insert({
      meeting_id: meetingId,
      segment_key: delta.segment.segmentId,
      revision: delta.segment.revision,
      speaker: delta.segment.speaker ?? null,
      t_start_ms: delta.segment.tStartMs,
      t_end_ms: delta.segment.tEndMs,
      text: delta.segment.text,
      is_final: delta.segment.isFinal,
    });

    if (useFastKpi) {
      const fast = extractFastSignals(delta.segment.text);
      if (fast.metrics.length > 0) telemetry.fastPathHits += 1;
      if (fast.missingPrompts.length > 0 && delta.segment.isFinal) {
        for (const prompt of fast.missingPrompts.slice(0, 2)) {
          const dk = dedupeHash("prompt", prompt);
          const last = recentCards.get(dk) ?? 0;
          if (Date.now() - last < 60_000) continue;
          recentCards.set(dk, Date.now());
          await createMeetingAssistantEvent(admin, {
            meeting_id: meetingId,
            kind: "suggested_question",
            severity: "low",
            title: "Missing context",
            body: prompt,
            source_map: { lane: "context", kind: "coverage_gap", quote: delta.segment.text.slice(0, 240), dedupe_key: dk },
          });
        }
      }
      if (fast.metrics.length > 0 && delta.segment.isFinal) {
        // Fast KPI contradictions: quantitative-only, and only once per metric family (fast OR mid).
        const families = new Set(fast.metrics.slice(0, 5).map((m) => metricFamily(m.key)));
        const anyFresh = [...families].some((fam) => !kpiFastOrMidOnce.has(`k:${meetingId}:${fam}`));
        if (anyFresh) {
          const crm = await loadGroundingPack();
          await processFastKpiContradictions(admin, {
            meetingId,
            text: delta.segment.text,
            quote: delta.segment.text,
            crm,
            recentCards,
            lastMetricInMeeting,
            contraWindow,
            maxContradictionsPerMin,
            kpiBufferMs,
            fastContraGate,
          });
          for (const fam of families) kpiFastOrMidOnce.add(`k:${meetingId}:${fam}`);
        }

        const now = Date.now();
        if (now - lastFastContraDedupeEnqAt > 45_000) {
          lastFastContraDedupeEnqAt = now;
          await admin.rpc("deal_intel_enqueue_job", {
            p_job_type: "meeting_dedupe_contradictions",
            p_subject_kind: "meeting",
            p_subject_id: meetingId,
            p_payload: { meeting_id: meetingId },
            p_priority: 40,
          });
          // Mirror auto-verify / slow-reasoning: when the bg-worker is not draining (dev or
          // stalled prod), run the sweep in-process so duplicate cards collapse without
          // waiting on the queue. Idempotent — DB-level uniques win regardless of who runs it.
          if (envFlag("LIVE_ASSISTANT_BG_JOB_DIRECT", process.env.NODE_ENV !== "production")) {
            void dedupeContradictionEventsByFactKey(admin, meetingId).catch(() => {});
          }
        }
      }
      // Per-segment middle-path enqueue was removed. Middle path is now driven exclusively by
      // semantic chunks (see the chunk loop below) so we only pay one LLM call per utterance,
      // not one per segment AND one per chunk. Semantic chunks are also the right granularity:
      // they're what the slow/deep paths already operate on.
    }

    const eventType = ev.type === lkStt.SpeechEventType.END_OF_SPEECH ? "eos" : delta.segment.isFinal ? "final" : "interim";
    // Prefix speaker with host:/guest: from LiveKit identity so downstream Q&A matching knows role
    // even when diarization labels exist. Join tokens use host:${host_user_id} / guest:...
    const isHostParticipant = p.identity?.startsWith("host:") ?? false;
    const roleScopedSpeaker = `${isHostParticipant ? "host" : "guest"}:${delta.segment.speaker || p.identity}`;
    // Do not generate chunks/claims from interim transcript updates (spam + unstable text).
    const chunks =
      eventType === "interim"
        ? []
        : chunkBuilder.ingest(
            {
              segmentId: delta.segment.segmentId,
              speaker: roleScopedSpeaker,
              text: delta.segment.text,
              tStartMs: delta.segment.tStartMs,
              tEndMs: delta.segment.tEndMs,
              isFinal: delta.segment.isFinal,
            },
            eventType,
          );

    for (const ch of chunks) {
      await processSemanticChunk(ch);
    }

  };

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    console.log("audio track subscribed", { participant: participant.identity });
    const audio = new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 20 });
    const stream = dgStt.stream();
    type StreamInput = Parameters<typeof stream.updateInputStream>[0];
    stream.updateInputStream(audio as unknown as StreamInput);

    (async () => {
      for await (const ev of stream) {
        try {
          if (
            ev.type === lkStt.SpeechEventType.INTERIM_TRANSCRIPT ||
            ev.type === lkStt.SpeechEventType.FINAL_TRANSCRIPT ||
            ev.type === lkStt.SpeechEventType.END_OF_SPEECH
          ) {
            await handleSpeechEvent(participant, ev);
          }
        } catch (e) {
          // Never let one LLM/tooling error kill the audio transcription loop.
          console.error("speech event error", e);
        }
      }
    })().catch((e) => {
      console.error("stt loop error", e);
    });
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log("room disconnected");
  });

  process.on("SIGINT", async () => {
    console.log("SIGINT, shutting down");
    clearInterval(chunkWatchdog);
    const remaining = chunkBuilder.flushAll("pause_timeout");
    if (remaining.length > 0) {
      console.log("flushed semantic chunks on shutdown", { count: remaining.length });
      for (const ch of remaining) {
        try {
          await processSemanticChunk(ch);
        } catch (e) {
          console.error("shutdown semantic chunk error", e);
        }
      }
    }
    // Force-close any open turn so the canonical verifier still emits a card for the last
    // guest utterance even when the participant disconnects mid-sentence.
    const remainingTurns = turnTracker.flushAll();
    const guestTurnsAtShutdown = remainingTurns.filter((t) => t.role === "guest").length;
    if (guestTurnsAtShutdown > 0) {
      console.log("flushed guest turns on shutdown", { count: guestTurnsAtShutdown });
    }
    console.log("live-assistant telemetry", {
      fastPathHits: telemetry.fastPathHits,
      queuedSlowPath: telemetry.queuedSlowPath,
      chunkFinalize: Object.fromEntries(telemetry.chunkFinalize.entries()),
    });
    await room.disconnect();
    await dispose();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

