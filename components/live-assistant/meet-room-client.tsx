"use client";

import { useEffect, useMemo, useState } from "react";
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
};

type JoinResponse = {
  livekitUrl: string;
  token: string;
  roomName: string;
  role: "host" | "guest";
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
        <div className="h-full grid grid-cols-1 md:grid-cols-[1fr_360px] gap-4 p-4">
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
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 overflow-auto">
            <AssistantEventsPanel meetingId={props.meetingId} guestToken={props.guestToken} />
          </div>
        </div>
      </LiveKitRoom>
    </div>
  );
}

function AssistantEventsPanel(props: { meetingId: string; guestToken: string | null }) {
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const mid = props.meetingId;
    if (!mid) return;

    let isCancelled = false;

    // Guest: no direct DB access (RLS). Use the API and poll.
    if (props.guestToken) {
      const gt = props.guestToken;
      const poll = async () => {
        try {
          const res = await fetch(
            `/api/meetings/${mid}/events?guest=${encodeURIComponent(gt)}`,
            { method: "GET" },
          );
          const json = (await res.json().catch(() => null)) as { events?: AssistantEvent[]; error?: string } | null;
          if (!res.ok) throw new Error(json?.error || `Failed to load events (${res.status})`);
          if (!isCancelled) setEvents((json?.events ?? []) as AssistantEvent[]);
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
    }

    // Host: use Supabase realtime for low-latency updates.
    const supabase = createClient();
    (async () => {
      const res = await supabase
        .schema("deal_intel")
        .from("meeting_assistant_event")
        .select("id, kind, title, body, severity, created_at")
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

    return () => {
      isCancelled = true;
      supabase.removeChannel(channel);
    };
  }, [props.meetingId, props.guestToken]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-zinc-900">Assistant</p>
        <p className="text-xs text-zinc-500">Live flags and prompts from the transcription worker.</p>
      </div>

      {err ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {err}
          <div className="mt-1 text-xs text-rose-600">If you’re a guest, this is expected (host-only DB access in MVP).</div>
        </div>
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
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No assistant events yet.</p>
      )}
    </div>
  );
}

function MeetingVideoGrid() {
  // Must be called under the LiveKit Room context.
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: true },
    ],
    { onlySubscribed: false },
  );
  return (
    <GridLayout tracks={tracks}>
      <ParticipantTile />
    </GridLayout>
  );
}

