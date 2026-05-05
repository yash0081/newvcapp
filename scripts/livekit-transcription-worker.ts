/**
 * LiveKit transcription worker.
 *
 * For every meeting, this process subscribes to the LiveKit room, runs Deepgram STT,
 * persists transcript segments + semantic chunks, then runs the canonical guest-turn
 * verifier, notes, questions, coverage prompts, and lightweight KPI observation capture.
 * Legacy fast/middle/slow/deep contradiction stacks have been removed; the canonical
 * guest-turn verifier is the single verdict surface.
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
import { SemanticChunkBuilder, type SemanticChunk } from "@/lib/live-assistant/chunker";
import { classifyClaimsFromChunk, type ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { confidenceForMetric, extractFastSignals } from "@/lib/live-assistant/fast-kpi";
import { runMeetingNotesTick } from "@/lib/live-assistant/notes";
import { runMeetingQuestionEngineTick } from "@/lib/live-assistant/question-engine-tick";
import { loadLiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";
import { missingCoveragePrompts, updateCoverageState, type CoverageState } from "@/lib/live-assistant/coverage";
import { persistClassifiedClaimsForChunk } from "@/lib/live-assistant/meeting-claims";
import { GuestTurnTracker, type SettledTurn } from "@/lib/live-assistant/guest-turn-tracker";
import { runGuestTurnVerify } from "@/lib/live-assistant/guest-turn-verify";
import { createHash } from "node:crypto";

function env(name: string): string {
  const v = process.env[name]?.trim();
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
  const meetingId = process.argv.find((a) => a.startsWith("--meetingId="))?.split("=", 2)[1]?.trim();
  const roomName = process.argv.find((a) => a.startsWith("--roomName="))?.split("=", 2)[1]?.trim();
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
  const useChunkClassifier = envFlag("LIVE_ASSISTANT_USE_CHUNK_CLASSIFIER", true);
  const useFastKpi = envFlag("LIVE_ASSISTANT_USE_FAST_KPI", true);
  const telemetry = {
    chunkFinalize: new Map<string, number>(),
    fastPathHits: 0,
  };
  let lastNotesTickAt = 0;
  let lastQuestionEngineTickAt = 0;

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

      // Canonical verifier (per-guest-turn): route every chunk through `turnTracker`, which
      // coalesces multi-chunk utterances and fires `runGuestTurnVerify` once per settled
      // guest turn. Per-chunk verdict emission would generate duplicate / partial cards.
      turnTracker.ingestChunk(ch);

      let fastChunkForClaims: ReturnType<typeof extractFastSignals> | null = null;
      if (useFastKpi) {
        // Keep lightweight KPI extraction only for structured observations and claim fallback.
        // Verdicts live exclusively in the canonical guest-turn verifier.
        fastChunkForClaims = extractFastSignals(ch.text);
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
        const pollMs = Math.max(2500, Math.min(12_000, Number(process.env.LIVE_ASSISTANT_NOTES_TICK_MS || 4000)));
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
      const qPollMs = Math.max(2500, Math.min(12_000, Number(process.env.LIVE_ASSISTANT_Q_TICK_MS || 4000)));
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

  };

  const room = new Room();
  const token = await makeWorkerToken(roomName);
  await room.connect(url, token, { autoSubscribe: true, dynacast: true });
  console.log("transcription worker connected", { roomName, meetingId });

  // Single source of truth for guest-turn verdicts in canonical mode. Listener fires once
  // when the tracker decides the guest turn has settled (speaker switch or pause settle).
  turnTracker.onGuestTurnSettled((turn: SettledTurn) => {
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
