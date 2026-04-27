"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ControlBar, GridLayout, LiveKitRoom, ParticipantTile, RoomAudioRenderer, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import { createClient } from "@/lib/supabase/client";

type AssistantEvent = {
  id: string;
  kind: "contradiction" | "crm_fact" | "key_point" | "suggested_question" | "action_prompt";
  title: string | null;
  body: string;
  severity: "low" | "med" | "high";
  created_at: string;
  source_map?: Record<string, unknown> | null;
};

type TranscriptSegment = {
  id: string;
  segment_key: string;
  text: string;
  speaker: string | null;
  revision: number;
  is_final: boolean;
  created_at: string;
};

type JoinResponse = {
  livekitUrl: string;
  token: string;
  roomName: string;
  role: "host" | "guest";
  /** Deal / company workspace id for CRM links from assistant cards */
  dealId?: string;
};

function joinStorageKey(meetingId: string) {
  return `lk:join:${meetingId}`;
}

export function MeetRoomClient(props: { meetingId: string }) {
  const sp = useSearchParams();
  const guestToken = sp.get("guest");
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [join, setJoin] = useState<JoinResponse | null>(null);
  const [booted, setBooted] = useState(false);

  const isGuest = useMemo(() => Boolean(guestToken), [guestToken]);

  // Persist join response so refreshes/disconnects don't throw you back to the join page.
  useEffect(() => {
    if (!props.meetingId) return;
    try {
      const raw = window.sessionStorage.getItem(joinStorageKey(props.meetingId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<JoinResponse>;
      if (parsed?.token && parsed?.livekitUrl && parsed?.roomName && (parsed.role === "host" || parsed.role === "guest")) {
        setJoin(parsed as JoinResponse);
      }
    } catch {
      // ignore
    } finally {
      setBooted(true);
    }
  }, [props.meetingId]);

  const doJoin = async () => {
    setJoining(true);
    setErr(null);
    try {
      const res = await fetch(`/api/meetings/${props.meetingId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: name,
          guest_token: guestToken,
        }),
      });
      const json = (await res.json().catch(() => null)) as JoinResponse & { error?: string };
      if (!res.ok) throw new Error(json?.error || `Join failed (${res.status})`);
      if (!json?.token || !json?.livekitUrl) throw new Error("Missing token/livekitUrl");
      setJoin(json);
      try {
        window.sessionStorage.setItem(joinStorageKey(props.meetingId), JSON.stringify(json));
      } catch {
        // ignore
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  };

  if (join) {
    return <ConnectedMeetingView meetingId={props.meetingId} guestToken={guestToken} join={join} />;
  }

  if (!booted) {
    return <div className="p-6 text-sm text-zinc-500">Loading meeting…</div>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Join meeting</h1>
        <p className="text-sm text-zinc-500 mt-1">You’ll be asked for microphone permission.</p>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
        {isGuest ? (
          <div className="space-y-1">
            <label className="block text-xs text-zinc-600">Your name</label>
            <input className="crm-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" />
          </div>
        ) : (
          <p className="text-sm text-zinc-600">
            Host join: sign in in another tab (or open this link from within the app).
          </p>
        )}

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <button className="crm-button w-full" onClick={doJoin} disabled={joining || (isGuest && name.trim().length < 2)}>
          {joining ? "Joining…" : "Join with microphone"}
        </button>

        <p className="text-xs text-zinc-500">
          By joining you consent to transcription for meeting assistance and notes.
        </p>
      </div>
    </div>
  );
}

function ConnectedMeetingView(props: { meetingId: string; guestToken: string | null; join: JoinResponse }) {
  const isHost = props.join.role === "host";
  return (
    <div className="h-[calc(100vh-2rem)]">
      <LiveKitRoom
        serverUrl={props.join.livekitUrl}
        token={props.join.token}
        connect
        audio
        video
        data-lk-theme="default"
        style={{ height: "100%" }}
      >
        <RoomAudioRenderer />
        <div
          className={`h-full grid gap-4 p-4 ${isHost ? "grid-cols-1 lg:grid-cols-[1fr_360px]" : "grid-cols-1"}`}
        >
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 overflow-hidden flex flex-col min-h-0">
            <div className="flex items-start justify-between gap-3 pb-3">
              <div>
                <p className="text-xs text-zinc-500">Room</p>
                <p className="text-sm text-zinc-900 font-medium break-all">{props.join.roomName}</p>
                <p className="text-xs text-zinc-500 mt-1">
                  Connected as <span className="text-zinc-700">{props.join.role}</span>
                </p>
              </div>
            </div>

            <div className="flex-1 min-h-0 rounded-2xl border border-zinc-200 bg-zinc-50 overflow-hidden">
              <MeetingVideoGrid />
            </div>

            <div className="pt-3">
              <ControlBar controls={{ camera: true, microphone: true, chat: false, screenShare: false, leave: true }} />
            </div>
          </div>
          {isHost ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 overflow-auto space-y-4 min-h-0">
              <AssistantControlPanel meetingId={props.meetingId} />
              <TranscriptPanel meetingId={props.meetingId} />
              <AssistantEventsPanel meetingId={props.meetingId} dealId={props.join.dealId} />
            </div>
          ) : null}
        </div>
      </LiveKitRoom>
    </div>
  );
}

function AssistantControlPanel(props: { meetingId: string }) {
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [state, setState] = useState<{ status: string; pid: number | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/meetings/${props.meetingId}/assistant`, { method: "GET" });
      const json = (await res.json().catch(() => null)) as
        | { enabled?: boolean; reason?: string | null; state?: { status?: string; pid?: number | null }; error?: string }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setEnabled(Boolean(json?.enabled));
      setReason(typeof json?.reason === "string" ? json.reason : null);
      setState({
        status: typeof json?.state?.status === "string" ? json.state.status : "idle",
        pid: typeof json?.state?.pid === "number" ? json.state.pid : null,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [props.meetingId]);

  useEffect(() => {
    load().catch(() => {});
    const t = window.setInterval(() => {
      load().catch(() => {});
    }, 4000);
    return () => window.clearInterval(t);
  }, [load]);

  const start = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/meetings/${props.meetingId}/assistant`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as { state?: { status?: string; pid?: number | null }; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setState({
        status: typeof json?.state?.status === "string" ? json.state.status : "running",
        pid: typeof json?.state?.pid === "number" ? json.state.pid : null,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const stop = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/meetings/${props.meetingId}/assistant`, { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as { state?: { status?: string; pid?: number | null }; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setState({
        status: typeof json?.state?.status === "string" ? json.state.status : "stopped",
        pid: typeof json?.state?.pid === "number" ? json.state.pid : null,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const running = state?.status === "running" || state?.status === "starting";

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-zinc-900">Live assistant</p>
          <p className="text-xs text-zinc-500">Host-only control for local assistant automation.</p>
        </div>
        <span className="text-[11px] rounded-full border border-zinc-300 px-2 py-0.5 text-zinc-700">
          {state?.status ?? "idle"}
        </span>
      </div>
      {typeof state?.pid === "number" ? (
        <p className="text-xs text-zinc-500">Worker PID: {state.pid}</p>
      ) : null}
      {enabled === false ? (
        <p className="text-xs text-amber-700">
          {reason ?? "Assistant autostart is disabled. Set LIVE_ASSISTANT_AUTOSTART_LOCAL=1 in local development."}
        </p>
      ) : (
        <button className="crm-button w-full" disabled={loading} onClick={running ? stop : start} type="button">
          {loading ? "Updating…" : running ? "Disable live assistant" : "Enable live assistant"}
        </button>
      )}
      {err ? <p className="text-xs text-rose-600">{err}</p> : null}
    </div>
  );
}

function TranscriptPanel(props: { meetingId: string }) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/meetings/${props.meetingId}/transcript`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as
          | { segments?: TranscriptSegment[]; error?: string }
          | null;
        if (!res.ok) throw new Error(json?.error || `Failed to load transcript (${res.status})`);
        if (!isCancelled) {
          setSegments((json?.segments ?? []) as TranscriptSegment[]);
          setErr(null);
        }
      } catch (e) {
        if (!isCancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    poll();
    const t = window.setInterval(poll, 2000);
    return () => {
      isCancelled = true;
      window.clearInterval(t);
    };
  }, [props.meetingId]);

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-zinc-900">Live transcript</p>
        <p className="text-xs text-zinc-500">Live segments from the transcription worker.</p>
      </div>
      {err ? <p className="text-xs text-rose-600">{err}</p> : null}
      {segments.length ? (
        <div className="space-y-2 max-h-56 overflow-auto pr-1">
          {segments.map((s) => (
            <div key={s.id} className="rounded-xl border border-zinc-200 bg-white p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-zinc-600">{s.speaker || "speaker"}</p>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] rounded-full px-1.5 py-0.5 border ${
                      s.is_final
                        ? "text-emerald-700 border-emerald-300 bg-emerald-50"
                        : "text-amber-700 border-amber-300 bg-amber-50"
                    }`}
                  >
                    {s.is_final ? "final" : "interim"}
                  </span>
                  <p className="text-[11px] text-zinc-500">{new Date(s.created_at).toLocaleTimeString()}</p>
                </div>
              </div>
              <p className="mt-1 text-sm text-zinc-800 whitespace-pre-wrap">{s.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No transcript yet.</p>
      )}
    </div>
  );
}

function extractDocumentIdsFromSourceMap(sourceMap: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  if (!sourceMap || typeof sourceMap !== "object") return out;
  const sm = sourceMap as Record<string, unknown>;
  const candidates = sm.candidates;
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      if (c && typeof c === "object" && "document_id" in c) {
        add((c as { document_id?: string }).document_id);
      }
    }
  }
  return out;
}

function AssistantEventCrmLinks(props: { sourceMap: unknown; dealId?: string }) {
  const { dealId } = props;
  if (!dealId) return null;
  const docIds = extractDocumentIdsFromSourceMap(props.sourceMap);
  if (!docIds.length) return null;
  return (
    <div className="mt-2 pt-2 border-t border-zinc-100">
      <Link
        href={`/home/deal-intel/${dealId}`}
        className="text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline"
      >
        Open CRM workspace
        {docIds.length > 1 ? ` · ${docIds.length} documents cited` : ""}
      </Link>
    </div>
  );
}

/** Host-only: subscribed from parent when `role === "host"`. */
function AssistantEventsPanel(props: { meetingId: string; dealId?: string }) {
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const mid = props.meetingId;
    if (!mid) return;

    let isCancelled = false;

    const supabase = createClient();
    (async () => {
      const res = await supabase
        .schema("deal_intel")
        .from("meeting_assistant_event")
        .select("id, kind, title, body, severity, created_at, source_map")
        .eq("meeting_id", mid)
        .order("created_at", { ascending: false })
        .limit(50);
      if (isCancelled) return;
      if (res.error) setErr(res.error.message);
      else setEvents((res.data ?? []) as AssistantEvent[]);
    })().catch((e) => {
      if (!isCancelled) setErr(e instanceof Error ? e.message : String(e));
    });

    const channel = supabase
      .channel(`meeting_assistant_event:${mid}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "deal_intel", table: "meeting_assistant_event", filter: `meeting_id=eq.${mid}` },
        (payload) => {
          const row = payload.new as AssistantEvent;
          setEvents((prev) => [row, ...prev].slice(0, 50));
        },
      )
      .subscribe();

    const pollMs = 12_000;
    const pollId = window.setInterval(() => {
      void (async () => {
        const res = await supabase
          .schema("deal_intel")
          .from("meeting_assistant_event")
          .select("id, kind, title, body, severity, created_at, source_map")
          .eq("meeting_id", mid)
          .order("created_at", { ascending: false })
          .limit(50);
        if (isCancelled || res.error) return;
        setEvents((res.data ?? []) as AssistantEvent[]);
      })();
    }, pollMs);

    return () => {
      isCancelled = true;
      window.clearInterval(pollId);
      supabase.removeChannel(channel);
    };
  }, [props.meetingId]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-zinc-900">Live CRM assistant</p>
        <p className="text-xs text-zinc-500">
          Indexed deal materials, contradiction checks, and links back to your company workspace (transcription worker).
        </p>
      </div>

      {err ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{err}</div>
      ) : null}

      {events.length ? (
        <div className="space-y-2">
          {events.map((e) => (
            <div
              key={e.id}
              className="rounded-xl border border-zinc-200 bg-white p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-zinc-900">{e.title ?? e.kind}</p>
                <span className="text-[11px] text-zinc-500">{new Date(e.created_at).toLocaleTimeString()}</span>
              </div>
              <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{e.body}</pre>
              <div className="mt-2 text-[11px] text-zinc-500">
                {e.kind} · {e.severity}
              </div>
              <AssistantEventCrmLinks sourceMap={e.source_map} dealId={props.dealId} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">
          No assistant cards yet. Enable the live assistant worker and speak; cards pull from your CRM claims and facts.
        </p>
      )}
    </div>
  );
}

function MeetingVideoGrid() {
  // Must be called under the LiveKit Room context.
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
    ],
    { onlySubscribed: false },
  );
  const visibleTracks = tracks.filter((t) => {
    const identity = (t as { participant?: { identity?: string } }).participant?.identity || "";
    return !identity.startsWith("worker:transcribe:");
  });
  return (
    <GridLayout tracks={visibleTracks}>
      <ParticipantTile />
    </GridLayout>
  );
}

