"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ControlBar, GridLayout, LiveKitRoom, ParticipantTile, RoomAudioRenderer, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";

type AssistantEvent = {
  id: string;
  kind: "contradiction" | "crm_fact" | "key_point" | "suggested_question" | "action_prompt" | "claim_verification";
  title: string | null;
  body: string;
  severity: "low" | "med" | "high";
  created_at: string;
  source_map?: Record<string, unknown> | null;
};

type ClaimVerificationRow = {
  id: string;
  claim_id: string;
  stage: string;
  auto_verdict: string | null;
  auto_summary: string | null;
  research_verdict: string | null;
  research_summary: string | null;
  research_citations: unknown;
  claim_text?: string;
};

type TrackedQuestion = {
  id: string;
  text: string;
  section: string;
  importance_weight: number;
  state: string;
  provenance: string;
  venue: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type QuestionEvidence = {
  relation: string;
  claim_text: string;
  scores: unknown;
  created_at: string;
};

type EventLane = "attention" | "context" | "memo";

/**
 * Display label for `meeting_tracked_question.provenance`. The legacy `similar_company`
 * value (from the killed peer-template recycler) renders the same as the new `peer_style`
 * generator so historical rows in the DB keep a sensible badge.
 */
function provenanceLabel(p: string): string {
  if (p === "similar_company" || p === "peer_style") return "peer style";
  if (p === "assumption_inversion") return "assumption check";
  if (p === "low_evidence") return "low evidence";
  if (p === "coverage_prompt") return "coverage";
  return p;
}

type NoteRow = {
  id: string;
  section: string;
  text: string;
  t_ms: number;
  importance_score: number;
  source_claim_ids: string[];
  parent_bullet_id: string | null;
  created_at: string;
  updated_at: string;
};

type NotesSections = Record<string, { bullets: NoteRow[]; subbullets: Record<string, NoteRow[]> }>;

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
          className={`h-full grid gap-4 p-4 ${
            isHost ? "grid-cols-1 lg:grid-cols-[320px_1fr_420px]" : "grid-cols-1"
          }`}
        >
          {isHost ? (
            <div className="rounded-2xl border border-zinc-200 bg-gradient-to-b from-white to-zinc-50/40 p-4 overflow-auto space-y-4 min-h-0">
              <LeftSidebarPanel meetingId={props.meetingId} />
            </div>
          ) : null}
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
            <div className="rounded-2xl border border-zinc-200 bg-gradient-to-b from-white to-zinc-50/40 p-4 overflow-auto space-y-4 min-h-0">
              <AssistantControlPanel meetingId={props.meetingId} />
              <AssistantEventsPanel meetingId={props.meetingId} dealId={props.join.dealId} />
            </div>
          ) : null}
        </div>
      </LiveKitRoom>
    </div>
  );
}

function LeftSidebarPanel(props: { meetingId: string }) {
  const [tab, setTab] = useState<"open" | "answered" | "notes">("open");
  const [trackedQuestions, setTrackedQuestions] = useState<TrackedQuestion[]>([]);
  const [evidenceByQuestionId, setEvidenceByQuestionId] = useState<Record<string, QuestionEvidence[]>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const mid = props.meetingId;
    if (!mid) return;
    let isCancelled = false;

    const load = async () => {
      const res = await fetch(`/api/meetings/${mid}/questions?includeAnswered=1`, { method: "GET" });
      const json = (await res.json().catch(() => null)) as
        | { questions?: TrackedQuestion[]; evidenceByQuestionId?: Record<string, QuestionEvidence[]>; error?: string }
        | null;
      if (isCancelled) return;
      if (!res.ok) {
        setErr(json?.error || `Failed (${res.status})`);
        return;
      }
      setErr(null);
      setTrackedQuestions(Array.isArray(json?.questions) ? json!.questions! : []);
      setEvidenceByQuestionId((json?.evidenceByQuestionId && typeof json.evidenceByQuestionId === "object" ? json.evidenceByQuestionId : {}) as Record<
        string,
        QuestionEvidence[]
      >);
    };

    void load();
    const pollId = window.setInterval(() => void load(), 4_000);
    return () => {
      isCancelled = true;
      window.clearInterval(pollId);
    };
  }, [props.meetingId]);

  const active = useMemo(() => {
    return trackedQuestions.filter((q) => {
      const st = String(q.state || "").trim().toLowerCase();
      return st !== "answered" && st !== "contradicted";
    });
  }, [trackedQuestions]);

  const answered = useMemo(() => {
    return trackedQuestions.filter((q) => String(q.state || "").trim().toLowerCase() === "answered");
  }, [trackedQuestions]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-base font-semibold tracking-tight text-zinc-900">Questions</p>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Assumptions, peer questions, and evidence gaps. They’ll disappear when strongly answered.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTab("open")}
          className={`h-8 px-3 rounded-full text-xs font-medium border ${
            tab === "open" ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-700 border-zinc-200"
          }`}
        >
          Open <span className={tab === "open" ? "text-white/80" : "text-zinc-400"}>({active.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("answered")}
          className={`h-8 px-3 rounded-full text-xs font-medium border ${
            tab === "answered" ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-700 border-zinc-200"
          }`}
        >
          Answered <span className={tab === "answered" ? "text-white/80" : "text-zinc-400"}>({answered.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("notes")}
          className={`h-8 px-3 rounded-full text-xs font-medium border ${
            tab === "notes" ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-700 border-zinc-200"
          }`}
        >
          Notes
        </button>
      </div>
      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{err}</div> : null}
      {tab === "notes" ? (
        <NotesPanel meetingId={props.meetingId} />
      ) : tab === "answered" ? (
        answered.length ? (
          <ul className="space-y-2">
            {answered.slice(0, 14).map((q) => {
              const meta = q.metadata && typeof q.metadata === "object" ? (q.metadata as Record<string, unknown>) : {};
              const metaAnswer =
                typeof meta.answer_excerpt === "string" && meta.answer_excerpt.trim() ? meta.answer_excerpt.trim() : "";
              const answerSource =
                typeof meta.answer_source === "string" ? String(meta.answer_source).trim().toLowerCase() : "";
              const ev = evidenceByQuestionId[q.id]?.[0];
              const scores = ev?.scores && typeof ev.scores === "object" ? (ev.scores as Record<string, unknown>) : null;
              const scoreAnswer = scores && typeof scores.answer_text === "string" ? scores.answer_text.trim() : "";
              const claimSnippet = typeof ev?.claim_text === "string" ? ev.claim_text.trim() : "";
              // Canonical guest-turn answers must use persisted excerpt only — matcher spans can
              // reflect a different chunk and flip the UI between polls if merged with OR logic.
              const display =
                answerSource === "guest_turn_canonical"
                  ? metaAnswer
                  : metaAnswer || scoreAnswer || claimSnippet || "";
              return (
                <li key={q.id} className="rounded-2xl border border-emerald-200/70 bg-white p-3 shadow-sm">
                  <div className="flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
                    <span className="rounded-full bg-emerald-50 text-emerald-800 px-2 py-0.5">answered</span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5">{provenanceLabel(q.provenance)}</span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5">{q.section}</span>
                  </div>
                  <p className="mt-2 font-sans text-[14px] font-medium leading-snug text-zinc-900">{q.text}</p>
                  {display ? (
                    <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50/40 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-900/90">Answer</p>
                      <p className="mt-1 font-sans text-[13px] leading-relaxed text-emerald-950">{display}</p>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-zinc-500">No answer excerpt captured yet.</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No answered questions yet.</p>
        )
      ) : active.length ? (
        <ul className="space-y-2">
          {active.slice(0, 18).map((q) => (
            <li key={q.id} className="rounded-2xl border border-violet-200/70 bg-white p-3 shadow-sm">
              <div className="flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">{q.state}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">{provenanceLabel(q.provenance)}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">{q.section}</span>
              </div>
              <p className="mt-2 font-sans text-[14px] font-medium leading-snug text-zinc-900">{q.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">No open questions yet.</p>
      )}
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
          {reason ?? "Local assistant is disabled."}
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

function NotesPanel(props: { meetingId: string }) {
  const [sections, setSections] = useState<NotesSections>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/meetings/${props.meetingId}/notes`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as {
          sections?: NotesSections;
          error?: string;
        } | null;
        if (!res.ok) throw new Error(json?.error || `Failed to load notes (${res.status})`);
        if (!isCancelled) {
          setSections((json?.sections && typeof json.sections === "object" ? json.sections : {}) as NotesSections);
          setErr(null);
        }
      } catch (e) {
        if (!isCancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    poll();
    const t = window.setInterval(poll, 2500);
    return () => {
      isCancelled = true;
      window.clearInterval(t);
    };
  }, [props.meetingId]);

  const orderedSections = useMemo(() => {
    const pref = ["problem", "solution", "traction", "product", "market", "gtm", "team", "competition", "financials", "risks", "other"];
    const keys = Object.keys(sections || {});
    keys.sort((a, b) => {
      const ai = pref.indexOf(a);
      const bi = pref.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });
    return keys;
  }, [sections]);

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-semibold text-zinc-900">Notes</p>
        <p className="text-xs text-zinc-500">Structured bullets per section, refined from live claims (not raw transcript).</p>
      </div>
      {err ? <p className="text-xs text-rose-600">{err}</p> : null}
      {orderedSections.length ? (
        <div className="space-y-4 max-h-80 overflow-auto pr-1">
          {orderedSections.map((sec) => {
            const s = sections[sec];
            if (!s) return null;
            return (
              <div key={sec}>
                <p className="text-[11px] font-semibold tracking-wide text-zinc-700 uppercase">{sec}</p>
                <ul className="mt-2 space-y-1.5 list-disc pl-5">
                  {s.bullets.slice(0, 18).map((b) => (
                    <li key={b.id} className="text-[14.5px] leading-snug text-zinc-800">
                      <span className="font-serif">{b.text}</span>
                      {s.subbullets?.[b.id]?.length ? (
                        <ul className="mt-2 space-y-1 list-disc pl-5 text-[13px] text-zinc-700">
                          {s.subbullets[b.id]!.slice(0, 5).map((sb) => (
                            <li key={sb.id} className="leading-snug">
                              {sb.text}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No notes yet.</p>
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

/**
 * When a contradiction / claim_verification card's `source_map.meeting_claim_id` was
 * superseded by a later corrected claim, render a small inline footer so the user sees
 * the correction without needing a separate fresh card. The supersession map is
 * populated from /api/meetings/.../events on each poll.
 */
function SupersededFooter(props: {
  sourceMap: unknown;
  supersessions: Record<
    string,
    { superseded_by_claim_id: string; superseded_at: string | null; new_claim_text: string | null }
  >;
}) {
  const sm = props.sourceMap && typeof props.sourceMap === "object" ? (props.sourceMap as Record<string, unknown>) : {};
  const claimId = typeof sm.meeting_claim_id === "string" ? sm.meeting_claim_id : "";
  if (!claimId) return null;
  const info = props.supersessions[claimId];
  if (!info) return null;
  const text = info.new_claim_text ? info.new_claim_text.trim() : "";
  return (
    <div className="mt-2 pt-2 border-t border-zinc-100">
      <p className="text-[11px] leading-snug text-emerald-700">
        <span className="font-medium">Updated to:</span>{" "}
        {text ? `“${formatAssistantPipeLists(text.slice(0, 220))}”` : "guest provided a corrected value"}
      </p>
    </div>
  );
}

type MemoBodySegment =
  | { kind: "labeled"; label: string; text: string }
  | { kind: "followup"; text: string }
  | { kind: "prose"; text: string };

const MEMO_LINE_PREFIXES: Array<{ prefix: string; label: string; followUp?: boolean }> = [
  { prefix: "Related diligence Q: ", label: "Related diligence Q" },
  { prefix: "Records: ", label: "Records" },
  { prefix: "Field: ", label: "Field" },
  { prefix: "Note: ", label: "Note" },
  { prefix: "Stated: ", label: "Stated" },
  { prefix: "Follow-up: ", label: "Follow-up", followUp: true },
];

/** Snapshot / CRM strings often use `|` as a list delimiter; show commas in the UI instead. */
function formatAssistantPipeLists(text: string): string {
  return String(text || "").replace(/\s*\|\s*/g, ", ");
}

function parseMemoCardBody(body: string): MemoBodySegment[] {
  const out: MemoBodySegment[] = [];
  for (const raw of String(body || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let matched = false;
    for (const row of MEMO_LINE_PREFIXES) {
      if (line.startsWith(row.prefix)) {
        const text = line.slice(row.prefix.length).trim();
        if (row.followUp) out.push({ kind: "followup", text });
        else out.push({ kind: "labeled", label: row.label, text });
        matched = true;
        break;
      }
    }
    if (!matched) out.push({ kind: "prose", text: line });
  }
  return out;
}

/** Memo-style layout for assistant card bodies (not transcript / dialogue quotes). */
function MemoFormattedCardBody(props: { body: string }) {
  const segments = parseMemoCardBody(formatAssistantPipeLists(props.body));
  if (!segments.length) return null;
  return (
    <div className="mt-3 space-y-3 font-sans text-[13px] leading-relaxed text-zinc-800">
      {segments.map((seg, idx) => {
        if (seg.kind === "prose") {
          return (
            <p key={idx} className="text-zinc-800 leading-snug">
              {seg.text}
            </p>
          );
        }
        if (seg.kind === "followup") {
          return (
            <div key={idx} className="rounded-2xl border border-amber-100 bg-amber-50/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-950/80">Follow-up</p>
              <p className="mt-1 text-[13px] text-zinc-900 leading-snug">{seg.text}</p>
            </div>
          );
        }
        return (
          <div key={idx}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{seg.label}</p>
            <p className="mt-0.5 text-[13px] text-zinc-900 leading-snug">{seg.text}</p>
          </div>
        );
      })}
    </div>
  );
}

function laneForEvent(e: AssistantEvent): EventLane {
  const lane = e.source_map && typeof e.source_map === "object" ? String((e.source_map as Record<string, unknown>).lane ?? "") : "";
  if (lane === "attention" || lane === "context" || lane === "memo") return lane;
  if (e.kind === "contradiction" || e.kind === "action_prompt") return "attention";
  if (e.kind === "crm_fact") return "context";
  return "memo";
}

function eventPriority(e: AssistantEvent): number {
  const sm = e.source_map && typeof e.source_map === "object" ? (e.source_map as Record<string, unknown>) : {};
  const k = typeof sm.kind === "string" ? sm.kind : "";
  const reasoned = sm.reasoned === true;
  if (e.kind === "contradiction" && (reasoned || k.startsWith("deep_"))) return 100;
  if (e.kind === "contradiction" && sm.fast_lane === true) return 10;
  if (e.kind === "action_prompt") return 60;
  if (e.kind === "crm_fact") return 30;
  if (e.kind === "claim_verification") {
    const rv = typeof sm.research_verdict === "string" ? sm.research_verdict : "";
    if (rv === "contradicts") return 96;
    const av = typeof sm.auto_verdict === "string" ? sm.auto_verdict : "";
    if (av === "contradicts") return 93;
    if (av === "new") return 58;
    if (av === "aligns") return 28;
    return 38;
  }
  return 20;
}

function parseResearchCitations(raw: unknown): Array<{ url: string; title: string; snippet: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ url: string; title: string; snippet: string }> = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    if (!url) continue;
    out.push({
      url,
      title: typeof o.title === "string" ? o.title : "",
      snippet: typeof o.snippet === "string" ? o.snippet : "",
    });
  }
  return out;
}

/** Host-only: subscribed from parent when `role === "host"`. */
type SupersessionInfo = {
  superseded_by_claim_id: string;
  superseded_at: string | null;
  new_claim_text: string | null;
};

function AssistantEventsPanel(props: { meetingId: string; dealId?: string }) {
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [verifications, setVerifications] = useState<ClaimVerificationRow[]>([]);
  const [supersessions, setSupersessions] = useState<Record<string, SupersessionInfo>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<EventLane>(() => {
    try {
      const raw = window.sessionStorage.getItem(`meet_tab:${props.meetingId}`) || "";
      if (raw === "attention" || raw === "context" || raw === "memo") return raw;
    } catch {
      // ignore
    }
    return "attention";
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(`meet_tab:${props.meetingId}`, tab);
    } catch {
      // ignore
    }
  }, [props.meetingId, tab]);

  useEffect(() => {
    const mid = props.meetingId;
    if (!mid) return;

    let isCancelled = false;

    const load = async () => {
      const [evRes, verRes] = await Promise.all([
        fetch(`/api/meetings/${mid}/events`, { method: "GET" }),
        fetch(`/api/meetings/${mid}/verifications`, { method: "GET" }),
      ]);
      const json = (await evRes.json().catch(() => null)) as {
        events?: AssistantEvent[];
        supersessions?: Record<string, SupersessionInfo>;
        error?: string;
      } | null;
      const verJson = (await verRes.json().catch(() => null)) as { verifications?: ClaimVerificationRow[]; error?: string } | null;
      if (isCancelled) return;
      if (!evRes.ok) {
        setErr(json?.error || `Failed (${evRes.status})`);
        return;
      }
      if (!verRes.ok) {
        setErr(verJson?.error || `Verifications failed (${verRes.status})`);
        return;
      }
      setErr(null);
      setEvents(Array.isArray(json?.events) ? json!.events! : []);
      setVerifications(Array.isArray(verJson?.verifications) ? verJson.verifications! : []);
      setSupersessions(json?.supersessions && typeof json.supersessions === "object" ? json.supersessions : {});
    };

    void load();

    const pollMs = 4_000;
    const pollId = window.setInterval(() => {
      void load();
    }, pollMs);

    return () => {
      isCancelled = true;
      window.clearInterval(pollId);
    };
  }, [props.meetingId]);

  const verificationsByClaimId = useMemo(() => {
    const m = new Map<string, ClaimVerificationRow>();
    for (const v of verifications) m.set(String(v.claim_id), v);
    return m;
  }, [verifications]);

  const grouped = useMemo(() => {
    const out: Record<EventLane, AssistantEvent[]> = { attention: [], context: [], memo: [] };
    for (const e of events) out[laneForEvent(e)].push(e);
    for (const lane of Object.keys(out) as EventLane[]) {
      out[lane].sort((a, b) => {
        const pa = eventPriority(a);
        const pb = eventPriority(b);
        if (pa !== pb) return pb - pa;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }
    return out;
  }, [events]);

  const tabButton = (lane: EventLane, label: string) => {
    const active = tab === lane;
    return (
      <button
        type="button"
        onClick={() => setTab(lane)}
        className={`px-3 py-1.5 text-xs font-medium rounded-full border transition ${
          active ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50"
        }`}
      >
        {label}
        <span className={`ml-2 text-[11px] ${active ? "text-white/80" : "text-zinc-500"}`}>{grouped[lane].length}</span>
      </button>
    );
  };

  const renderLane = (lane: EventLane, title: string, subtitle: string) => (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-semibold text-zinc-900">{title}</p>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      {grouped[lane].length ? (
        grouped[lane].map((e) => {
          if (e.kind === "claim_verification") {
            const sm = e.source_map && typeof e.source_map === "object" ? (e.source_map as Record<string, unknown>) : {};
            const claimId = typeof sm.claim_id === "string" ? sm.claim_id : "";
            const ver = claimId ? verificationsByClaimId.get(claimId) : undefined;
            const autoVerdict = String(ver?.auto_verdict ?? sm.auto_verdict ?? "").trim();
            const researchVerdict = String(ver?.research_verdict ?? sm.research_verdict ?? "").trim();
            const autoSummary = String(ver?.auto_summary ?? sm.auto_summary ?? "").trim();
            const researchSummary = String(ver?.research_summary ?? sm.research_summary ?? "").trim();
            const stage = String(ver?.stage ?? "");
            const citations = parseResearchCitations(ver?.research_citations ?? sm.research_citations);
            const bodyTrim = String(e.body ?? "").trim();
            const quote =
              (ver?.claim_text && String(ver.claim_text).trim()) ||
              String(sm.claim_quote ?? "")
                .trim()
                .slice(0, 400) ||
              bodyTrim
                .replace(/^["“]|["”]$/g, "")
                .trim()
                .slice(0, 400);
            const autoSummaryTrim = autoSummary.replace(/\s+/g, " ").trim();
            const bodyNorm = bodyTrim.replace(/\s+/g, " ");
            const summaryDupedInBody =
              Boolean(autoSummaryTrim) &&
              Boolean(bodyNorm) &&
              (bodyNorm.includes(autoSummaryTrim.slice(0, Math.min(80, autoSummaryTrim.length))) ||
                autoSummaryTrim.includes(bodyNorm.slice(0, Math.min(80, bodyNorm.length))));
            // Surface Verify on both `new` (legacy) and `contradicts` (canonical-emitted
            // contradiction cards) when no web research has run yet. This matches the
            // Verify button the legacy `kind: "contradiction"` cards used to render.
            const showVerify =
              (autoVerdict === "new" || autoVerdict === "contradicts") &&
              !researchVerdict &&
              stage !== "research_pending" &&
              stage !== "research_done";
            const researching = stage === "research_pending";

            return (
              <div
                key={e.id}
                className={`rounded-2xl border p-4 shadow-sm ${
                  lane === "attention"
                    ? e.severity === "high"
                      ? "border-rose-200 bg-white"
                      : "border-amber-200 bg-white"
                    : lane === "context"
                      ? "border-blue-200 bg-white"
                      : "border-zinc-200 bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold tracking-tight text-zinc-900 truncate">{e.title ?? "Claim check"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                      {autoVerdict ? (
                        <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-900">
                          deal: {autoVerdict}
                        </span>
                      ) : null}
                      {researchVerdict ? (
                        <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-900">
                          web: {researchVerdict}
                        </span>
                      ) : null}
                      <span className="rounded-full border border-zinc-200 px-2 py-0.5 bg-zinc-50">{e.severity}</span>
                      <span>{new Date(e.created_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {showVerify && claimId ? (
                      <button
                        className="inline-flex items-center justify-center h-8 px-3.5 text-[11px] font-medium leading-none rounded-full border border-violet-300 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                        disabled={busyId === e.id}
                        type="button"
                        onClick={async () => {
                          setBusyId(e.id);
                          setErr(null);
                          try {
                            const res = await fetch(`/api/meetings/${props.meetingId}/claims/${claimId}/verify`, {
                              method: "POST",
                            });
                            const json = (await res.json().catch(() => null)) as { error?: string } | null;
                            if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
                          } catch (ex) {
                            setErr(ex instanceof Error ? ex.message : String(ex));
                          } finally {
                            setBusyId(null);
                          }
                        }}
                      >
                        Verify
                      </button>
                    ) : null}
                    {researching ? (
                      <span className="text-[11px] text-zinc-500 animate-pulse">Researching…</span>
                    ) : null}
                    <button
                      className="inline-flex items-center justify-center h-8 px-3.5 text-[11px] font-medium leading-none rounded-full border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      disabled={busyId === e.id}
                      onClick={async () => {
                        setBusyId(e.id);
                        setErr(null);
                        try {
                          const res = await fetch(`/api/meetings/${props.meetingId}/events/${e.id}`, { method: "DELETE" });
                          const json = (await res.json().catch(() => null)) as { error?: string } | null;
                          if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
                          setEvents((prev) => prev.filter((x) => x.id !== e.id));
                        } catch (ex) {
                          setErr(ex instanceof Error ? ex.message : String(ex));
                        } finally {
                          setBusyId(null);
                        }
                      }}
                      type="button"
                      title="Dismiss"
                    >
                      {busyId === e.id ? "…" : "Dismiss"}
                    </button>
                  </div>
                </div>
                <MemoFormattedCardBody body={String(e.body ?? "")} />
                {quote ? (
                  <div className="mt-3 rounded-2xl border border-zinc-200/70 bg-white px-4 py-3 shadow-sm ring-1 ring-zinc-950/[0.04]">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Source utterance</p>
                    <p className="mt-1 font-sans text-[13px] leading-relaxed text-zinc-800">{formatAssistantPipeLists(quote)}</p>
                  </div>
                ) : null}
                {autoSummary && !summaryDupedInBody ? (
                  <div className="mt-2 rounded-2xl border border-zinc-100 bg-white px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Deal check</p>
                    <p className="mt-1 font-sans text-[13px] leading-snug text-zinc-700">{formatAssistantPipeLists(autoSummary)}</p>
                  </div>
                ) : null}
                {researchSummary ? (
                  <p className="mt-2 text-[13px] leading-snug text-zinc-800 font-medium">{formatAssistantPipeLists(researchSummary)}</p>
                ) : null}
                {!researchSummary && researchVerdict ? (
                  <p className="mt-2 text-[13px] text-zinc-600 capitalize">Web research: {researchVerdict}</p>
                ) : null}
                {citations.length ? (
                  <details className="mt-3 rounded-xl border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                    <summary className="cursor-pointer text-[11px] font-medium text-zinc-700">Sources ({citations.length})</summary>
                    <ul className="mt-2 space-y-2">
                      {citations.map((c, idx) => (
                        <li key={idx} className="text-[11px] leading-snug">
                          <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 hover:underline break-all">
                            {c.title || c.url}
                          </a>
                          {c.snippet ? <p className="mt-0.5 text-zinc-600">{formatAssistantPipeLists(c.snippet)}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <AssistantEventCrmLinks sourceMap={e.source_map} dealId={props.dealId} />
                <SupersededFooter sourceMap={e.source_map} supersessions={supersessions} />
              </div>
            );
          }

          return (
            <div
              key={e.id}
              className={`rounded-2xl border p-4 shadow-sm ${
                lane === "attention"
                  ? e.severity === "high"
                    ? "border-rose-200 bg-white"
                    : "border-amber-200 bg-white"
                  : lane === "context"
                    ? "border-blue-200 bg-white"
                    : "border-zinc-200 bg-white"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold tracking-tight text-zinc-900 truncate">{e.title ?? e.kind}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span className="rounded-full border border-zinc-200 px-2 py-0.5 bg-zinc-50">{e.kind}</span>
                    <span className="rounded-full border border-zinc-200 px-2 py-0.5 bg-zinc-50">{e.severity}</span>
                    <span>{new Date(e.created_at).toLocaleTimeString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {e.kind === "contradiction"
                    ? (() => {
                        const sm =
                          e.source_map && typeof e.source_map === "object" ? (e.source_map as Record<string, unknown>) : {};
                        const contraClaimId = typeof sm.meeting_claim_id === "string" ? sm.meeting_claim_id : "";
                        return contraClaimId ? (
                          <button
                            className="inline-flex items-center justify-center h-8 px-3.5 text-[11px] font-medium leading-none rounded-full border border-violet-300 bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                            disabled={busyId === e.id}
                            type="button"
                            title="Run web research on this utterance"
                            onClick={async () => {
                              setBusyId(e.id);
                              setErr(null);
                              try {
                                const res = await fetch(`/api/meetings/${props.meetingId}/claims/${contraClaimId}/verify`, {
                                  method: "POST",
                                });
                                const json = (await res.json().catch(() => null)) as { error?: string } | null;
                                if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
                              } catch (ex) {
                                setErr(ex instanceof Error ? ex.message : String(ex));
                              } finally {
                                setBusyId(null);
                              }
                            }}
                          >
                            Verify
                          </button>
                        ) : null;
                      })()
                    : null}
                  {e.kind === "contradiction" || e.kind === "suggested_question" ? (
                    <button
                      className="inline-flex items-center justify-center h-8 px-3.5 text-[11px] font-medium leading-none rounded-full border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      disabled={busyId === e.id}
                      onClick={async () => {
                        setBusyId(e.id);
                        setErr(null);
                        try {
                          const res = await fetch(`/api/meetings/${props.meetingId}/events/${e.id}`, { method: "DELETE" });
                          const json = (await res.json().catch(() => null)) as { error?: string } | null;
                          if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
                          setEvents((prev) => prev.filter((x) => x.id !== e.id));
                        } catch (ex) {
                          setErr(ex instanceof Error ? ex.message : String(ex));
                        } finally {
                          setBusyId(null);
                        }
                      }}
                      type="button"
                      title="Dismiss"
                    >
                      {busyId === e.id ? "…" : "Dismiss"}
                    </button>
                  ) : null}
                </div>
              </div>
              <MemoFormattedCardBody body={String(e.body ?? "")} />
              <AssistantEventCrmLinks sourceMap={e.source_map} dealId={props.dealId} />
              <SupersededFooter sourceMap={e.source_map} supersessions={supersessions} />
            </div>
          );
        })
      ) : (
        <p className="text-xs text-zinc-500">No {title.toLowerCase()} cards yet.</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <p className="text-base font-semibold tracking-tight text-zinc-900">Live assistant</p>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Indexed deal materials, contradiction checks, and links back to your company workspace (transcription worker).
        </p>
      </div>

      <div className="flex items-center gap-2">
        {tabButton("attention", "Attention")}
        {tabButton("context", "Context")}
        {tabButton("memo", "Memo")}
      </div>

      {err ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{err}</div>
      ) : null}

      {events.length ? (
        <div className="space-y-4">{renderLane(tab, tab === "attention" ? "Attention" : tab === "context" ? "Context" : "Memo", tab === "attention" ? "Contradictions and urgent prompts" : tab === "context" ? "Memory and linked evidence" : "Key points and prompts")}</div>
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
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }], { onlySubscribed: true });
  const visibleTracks = useMemo(() => {
    const filtered = tracks.filter((t) => {
      const identity = (t as { participant?: { identity?: string } }).participant?.identity || "";
      return !identity.startsWith("worker:transcribe:");
    });
    filtered.sort((a, b) => {
      const ai = (a as { participant?: { identity?: string } }).participant?.identity || "";
      const bi = (b as { participant?: { identity?: string } }).participant?.identity || "";
      if (ai !== bi) return ai.localeCompare(bi);
      return String((a as { source?: unknown }).source ?? "").localeCompare(String((b as { source?: unknown }).source ?? ""));
    });
    return filtered;
  }, [tracks]);
  return (
    <GridLayout tracks={visibleTracks}>
      <ParticipantTile />
    </GridLayout>
  );
}

