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
import {
  getDealContext,
  matchClaimsHybrid,
  createMeetingAssistantEvent,
  type ClaimHit,
} from "@/lib/live-assistant/tools";
import { shouldAttemptContradiction, verifyContradictions } from "@/lib/live-assistant/contradiction";
import { runDeepContradictionBatch } from "@/lib/live-assistant/deep-contradictions";
import { SemanticChunkBuilder } from "@/lib/live-assistant/chunker";
import { classifyClaimsFromChunk, type ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { confidenceForMetric, extractFastSignals } from "@/lib/live-assistant/fast-kpi";
import { runMeetingNotesTick } from "@/lib/live-assistant/notes";
import { runMeetingQuestionEngineTick } from "@/lib/live-assistant/question-engine-tick";
import { scoreClaimPriority, mapPriorityToQueueValue } from "@/lib/live-assistant/priority";
import { loadLiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";
import { missingCoveragePrompts, updateCoverageState, type CoverageState } from "@/lib/live-assistant/coverage";
import { persistClassifiedClaimsForChunk } from "@/lib/live-assistant/meeting-claims";
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

function isVertexAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e || "")).toLowerCase();
  return msg.includes("could not load the default credentials") || msg.includes("unable to authenticate your request");
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function textDomainBoost(text: string, affinities: Record<string, number>): number {
  const s = text.toLowerCase();
  let best = 1;
  for (const [domain, weight] of Object.entries(affinities)) {
    if (!domain) continue;
    if (s.includes(domain.toLowerCase())) best = Math.max(best, Math.max(0.6, Math.min(2, Number(weight) || 1)));
  }
  return best;
}

function taskBoost(section: string, taskAffinity: Record<string, number>): number {
  const key = section.toLowerCase();
  let best = 1;
  for (const [task, weight] of Object.entries(taskAffinity)) {
    if (task.includes(key)) best = Math.max(best, Math.max(0.7, Math.min(2, Number(weight) || 1)));
  }
  return best;
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
    const minMs = Math.max(5_000, Number(process.env.LIVE_ASSISTANT_FAST_CONTRA_DELAY_MIN_MS ?? 15_000));
    const maxMs = Math.max(minMs + 1000, Number(process.env.LIVE_ASSISTANT_FAST_CONTRA_DELAY_MAX_MS ?? 30_000));
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

    if (mismatchHard && diffAbs != null && diffRatio != null) {
      const dk = canonDedupe;
      const last = opts.recentCards.get(dk) ?? 0;
      if (Date.now() - last >= opts.kpiBufferMs) {
        if (shouldDelayFastContra()) continue;
        opts.recentCards.set(dk, Date.now());
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
            founder_value: founderVal,
            record_value: recordVal,
            diff_abs: diffAbs,
            diff_ratio: diffRatio,
            confidence: conf,
            verify_query: verifyQuery,
            quote: opts.quote.slice(0, 280),
            dedupe_key: dk,
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
    if (driftHard && conf >= 0.62) {
      if (Date.now() - opts.contraWindow.startMs > 60_000) {
        opts.contraWindow.startMs = Date.now();
        opts.contraWindow.count = 0;
      }
      if (opts.contraWindow.count < opts.maxContradictionsPerMin) {
        const dk = `drift:${kpiCanonicalDedupeKey(opts.meetingId, fam, m.normalizedValue)}`;
        const last = opts.recentCards.get(dk) ?? 0;
        if (Date.now() - last >= opts.kpiBufferMs) {
          if (shouldDelayFastContra()) continue;
          opts.recentCards.set(dk, Date.now());
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
              normalized_value: m.normalizedValue,
              unit: m.unit,
              confidence: conf,
              drift_ratio: driftFromPrev,
              verify_query: verifyQuery,
              quote: opts.quote.slice(0, 280),
              dedupe_key: dk,
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
  const revisions = new Map<string, number>();
  const recentContradictions = new Map<string, number>(); // key -> last_ms
  const recentCards = new Map<string, number>(); // dedupe_key -> last_ms
  let coverageState: CoverageState | undefined;
  let lastVertexAuthWarnAt = 0;
  let crmSnapshotCache: { atMs: number; dealId: string; snap: DealIntelGroundingPack } | null = null;
  const kpiBufferMs = kpiBufferMsFromEnv();
  const useKpiMiddlePath = envFlag("LIVE_ASSISTANT_KPI_MIDDLE_PATH", true);
  const lastMetricInMeeting = new Map<string, number>();
  const kpiFastOrMidOnce = new Set<string>();
  const useQueueSlowPath = envFlag("LIVE_ASSISTANT_QUEUE_SLOW_PATH", true);
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
  const deepBatchEnabled = envFlag("LIVE_ASSISTANT_DEEP_CONTRA", true);
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

  const room = new Room();
  const token = await makeWorkerToken(roomName);
  await room.connect(url, token, { autoSubscribe: true, dynacast: true });
  console.log("transcription worker connected", { roomName, meetingId });

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
        }
      } else if (useKpiMiddlePath && delta.segment.isFinal && looksKpiLike(delta.segment.text)) {
        const midDk = dedupeHash("kpi_mid_enq_seg", `${meetingId}:${delta.segment.text.toLowerCase().trim().slice(0, 400)}`);
        const last = recentCards.get(midDk) ?? 0;
        const onceKey = `mid:${meetingId}:${midDk}`;
        if (!kpiFastOrMidOnce.has(onceKey) && Date.now() - last >= kpiBufferMs) {
          recentCards.set(midDk, Date.now());
          kpiFastOrMidOnce.add(onceKey);
          await admin.rpc("deal_intel_enqueue_job", {
            p_job_type: "meeting_kpi_middle",
            p_subject_kind: "meeting",
            p_subject_id: meetingId,
            p_payload: {
              meeting_id: meetingId,
              deal_id: dealId,
              user_id: hostUserId,
              chunk_text: delta.segment.text,
              dedupe_key: midDk,
            },
            p_priority: 75,
          });
        }
      }
    }

    const eventType = ev.type === lkStt.SpeechEventType.END_OF_SPEECH ? "eos" : delta.segment.isFinal ? "final" : "interim";
    // Do not generate chunks/claims from interim transcript updates (spam + unstable text).
    const chunks =
      eventType === "interim"
        ? []
        : chunkBuilder.ingest(
            {
              segmentId: delta.segment.segmentId,
              speaker: delta.segment.speaker || p.identity,
              text: delta.segment.text,
              tStartMs: delta.segment.tStartMs,
              tEndMs: delta.segment.tEndMs,
              isFinal: delta.segment.isFinal,
            },
            eventType,
          );

    for (const ch of chunks) {
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

      let fastChunkForClaims: ReturnType<typeof extractFastSignals> | null = null;
      if (useFastKpi) {
        // NOTE: We intentionally do NOT emit fast KPI contradictions from semantic chunks.
        // Fast contradictions should be driven by final transcript segments (more precise, less spammy).
        fastChunkForClaims = extractFastSignals(ch.text);
        if (useKpiMiddlePath && looksKpiLike(ch.text)) {
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
      if (useChunkClassifier) {
        try {
          claims = await classifyClaimsFromChunk(ch.text);
        } catch (e) {
          console.error("claim classifier error", e);
        }
      }
      if (!claims.length) {
        claims = (fastChunkForClaims ?? extractFastSignals(ch.text)).claims;
      }

      await persistClassifiedClaimsForChunk(admin, {
        meetingId,
        chunkId: meetingChunkId,
        speaker: ch.speaker,
        tStartMs: ch.startedAtMs,
        tEndMs: ch.endedAtMs,
        claims,
      });

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

      for (const claim of claims.slice(0, 5)) {
        if (!shouldQueueSlowPath(claim)) continue;
        const score = scoreClaimPriority(
          { ...claim, emittedAtMs: ch.emittedAtMs, isNotable: /partnered with|customers include|working with/i.test(claim.text) },
          {
            prefs: {
              sectionWeights: preferenceSignals.sectionWeights,
              preferenceConfidence: preferenceSignals.preferenceConfidence,
              domainBoost: textDomainBoost(`${claim.text} ${ch.text}`, preferenceSignals.domainAffinity),
              taskBoost: taskBoost(claim.section, preferenceSignals.taskAffinity),
            },
          },
        );
        if (useQueueSlowPath) {
          await admin.rpc("deal_intel_enqueue_job", {
            p_job_type: "meeting_claim_reasoning",
            p_subject_kind: "meeting",
            p_subject_id: meetingId,
            p_payload: {
              meeting_id: meetingId,
              deal_id: dealId,
              user_id: hostUserId,
              quote: claim.text,
              section: claim.section,
              intent: claim.intent,
              confidence: claim.confidence,
              chunk_id: ch.chunkId,
              source_text: ch.text,
              preference_hints: preferenceSignals.focusHints.slice(0, 3),
              preference_context: {
                hints: preferenceSignals.focusHints.slice(0, 4),
                sectionWeights: preferenceSignals.sectionWeights,
                preferredDomains: preferenceSignals.websiteDomains.slice(0, 5),
                confidence: preferenceSignals.preferenceConfidence,
              },
              dedupe_key: dedupeHash("slow", `${meetingId}:${claim.section}:${claim.intent}:${claim.text}`),
            },
            p_priority: mapPriorityToQueueValue(score),
          });
          telemetry.queuedSlowPath += 1;
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
    }

    // Keep existing direct path when queue mode is disabled.
    if (!useQueueSlowPath && delta.segment.isFinal && shouldAttemptContradiction(delta.segment.text)) {
      const now = Date.now();
      const dedupeKey = `${meetingId}:${delta.segment.text.toLowerCase().slice(0, 180)}`;
      const last = recentContradictions.get(dedupeKey) ?? 0;
      if (now - last > 60_000) {
        recentContradictions.set(dedupeKey, now);
        try {
          const ctx = await getDealContext(admin, { userId: hostUserId, dealId });
          const canonicalFacts = (ctx.company_facts ?? []).map((f) => ({
            fact_path: String((f as { fact_path?: unknown }).fact_path ?? ""),
            canonical_value_text:
              (f as { canonical_value_text?: unknown }).canonical_value_text == null
                ? null
                : String((f as { canonical_value_text?: unknown }).canonical_value_text),
          }));
          const candidates: ClaimHit[] = await matchClaimsHybrid(admin, {
            userId: hostUserId,
            dealId,
            queryText: delta.segment.text,
            limit: 18,
          });
          const flags = await verifyContradictions({
            new_quote: delta.segment.text,
            canonical_facts: canonicalFacts,
            candidate_claims: candidates,
          });
          for (const f of flags) {
            await createMeetingAssistantEvent(admin, {
              meeting_id: meetingId,
              kind: "contradiction",
              severity: f.severity,
              title: "Possible contradiction",
              body: f.suggested_followup_question ? `${f.quote}\n\nFollow-up: ${f.suggested_followup_question}` : f.quote,
              source_map: { lane: "attention", kind: "contradiction", quote: f.quote, conflicts_with: f.conflicts_with, confidence: f.confidence },
            });
          }
        } catch (e) {
          if (isVertexAuthError(e)) {
            const t = Date.now();
            if (t - lastVertexAuthWarnAt > 120_000) {
              lastVertexAuthWarnAt = t;
              await createMeetingAssistantEvent(admin, {
                meeting_id: meetingId,
                kind: "action_prompt",
                severity: "med",
                title: "LLM disabled (Vertex auth)",
                body:
                  "The transcription worker can’t authenticate to Vertex AI, so contradictions are temporarily disabled.\n\nFix: run `gcloud auth application-default login` (or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON) and restart the worker.",
                source_map: { lane: "attention", kind: "vertex_auth_error" },
              });
            }
          } else {
            console.error("contradiction error", e);
          }
        }
      }
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
    const remaining = chunkBuilder.flushAll("pause_timeout");
    if (remaining.length > 0) {
      console.log("flushed semantic chunks on shutdown", { count: remaining.length });
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

