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
import { getDealContext, matchClaimsHybrid, createMeetingAssistantEvent } from "@/lib/live-assistant/tools";
import { shouldAttemptContradiction, verifyContradictions } from "@/lib/live-assistant/contradiction";

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

async function main() {
  initializeLogger({ pretty: true, level: process.env.LIVEKIT_AGENT_LOG_LEVEL || "info" });

  const { meetingId, roomName } = parseArgs();
  const { url } = livekitEnv();

  const admin = createAdminClient();
  const ring = new TranscriptRingBuffer({ maxWindowMs: 15 * 60_000 });
  const revisions = new Map<string, number>();
  const recentContradictions = new Map<string, number>(); // key -> last_ms
  const recentGuestInfo = new Map<string, number>(); // key -> last_ms
  let lastVertexAuthWarnAt = 0;

  const isGuestIdentity = (identity: string) => identity.startsWith("guest:");

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
    if (!ev.alternatives?.length) return;
    const a = ev.alternatives[0]!;
    const text = String(a.text || "").trim();
    if (!text) return;

    const segmentId = toSegmentKey(p, ev);
    const prevRev = revisions.get(segmentId) ?? 0;
    const isFinal =
      ev.type === lkStt.SpeechEventType.FINAL_TRANSCRIPT || ev.type === lkStt.SpeechEventType.END_OF_SPEECH;

    const delta = ring.upsert({
      segmentId,
      tStartMs: Math.floor(a.startTime * 1000),
      tEndMs: Math.floor(a.endTime * 1000),
      speaker: a.speakerId ? String(a.speakerId) : p.identity,
      text,
      isFinal,
      revision: prevRev,
    });
    if (!delta) return;

    revisions.set(segmentId, delta.segment.revision);

    // Append-only persistence: write a new row per revision.
    await admin.schema("deal_intel").from("meeting_transcript_segment").insert({
      meeting_id: meetingId,
      segment_key: segmentId,
      revision: delta.segment.revision,
      speaker: delta.segment.speaker ?? null,
      t_start_ms: delta.segment.tStartMs,
      t_end_ms: delta.segment.tEndMs,
      text: delta.segment.text,
      is_final: delta.segment.isFinal,
    });

    // Accompanying info on HOST side: when guest says something substantive, surface relevant prior claims/facts.
    if (delta.segment.isFinal && isGuestIdentity(p.identity)) {
      const now = Date.now();
      const infoKey = `${meetingId}:${delta.segment.text.toLowerCase().slice(0, 180)}`;
      const last = recentGuestInfo.get(infoKey) ?? 0;
      if (now - last > 30_000) {
        recentGuestInfo.set(infoKey, now);

        try {
          const candidates = await matchClaimsHybrid(admin, {
            userId: hostUserId,
            dealId,
            queryText: delta.segment.text,
            limit: 6,
          });

          if (candidates.length) {
            const lines: string[] = [];
            lines.push(`Guest said: "${delta.segment.text.slice(0, 240)}"`);
            lines.push("");
            lines.push("Relevant prior claims:");
            for (const c of candidates.slice(0, 3)) {
              const where = c.page_number != null ? `p.${c.page_number}` : "doc";
              lines.push(`- (${where}) ${c.quote.slice(0, 220)}`);
            }

            await createMeetingAssistantEvent(admin, {
              meeting_id: meetingId,
              kind: "crm_fact",
              severity: "low",
              title: "Relevant context",
              body: lines.join("\n"),
              source_map: {
                kind: "guest_context",
                guest_quote: delta.segment.text,
                candidates,
              },
            });
          }
        } catch (e) {
          console.error("guest context error", e);
        }
      }
    }

    // Contradiction detection: only on final-ish text, and only when it looks worth checking.
    if (delta.segment.isFinal && shouldAttemptContradiction(delta.segment.text)) {
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
          const candidates = await matchClaimsHybrid(admin, {
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
              body: f.suggested_followup_question
                ? `${f.quote}\n\nFollow-up: ${f.suggested_followup_question}`
                : f.quote,
              source_map: {
                kind: "contradiction",
                quote: f.quote,
                conflicts_with: f.conflicts_with,
                confidence: f.confidence,
              },
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
                source_map: { kind: "vertex_auth_error" },
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
    stream.updateInputStream(audio as unknown as any);

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
    await room.disconnect();
    await dispose();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

