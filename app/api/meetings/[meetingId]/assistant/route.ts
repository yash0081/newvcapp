import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureAssistantControlEnabled,
  getLocalWorkerState,
  getWorkerState,
  isRemoteLiveAssistantControl,
  startWorkerForMeeting,
  stopWorkerForMeeting,
} from "@/lib/live-assistant/worker-manager";

async function loadHostMeeting(meetingId: string, hostUserId: string) {
  const admin = createAdminClient();
  const { data: meeting, error } = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id, livekit_room_name, status, metadata")
    .eq("id", meetingId)
    .maybeSingle();
  if (error) return { error: error.message || "Failed to load meeting", status: 500 as const };
  if (!meeting) return { error: "Not found", status: 404 as const };
  if (meeting.host_user_id !== hostUserId) return { error: "Forbidden", status: 403 as const };
  return { meeting };
}

function workerIsActive(state: { status?: string | null }): boolean {
  return state.status === "running" || state.status === "starting";
}

async function markAssistantState(
  meetingId: string,
  patch: { status: "live" | "ended" | "error"; assistantEnabled: boolean; workerState?: unknown; error?: string | null },
) {
  const admin = createAdminClient();
  const current = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("metadata")
    .eq("id", meetingId)
    .maybeSingle();
  const existingMetadata =
    current.data?.metadata && typeof current.data.metadata === "object"
      ? (current.data.metadata as Record<string, unknown>)
      : {};
  const metadataPatch = {
    ...existingMetadata,
    live_assistant_enabled: patch.assistantEnabled,
    live_assistant_last_state: patch.workerState ?? null,
    live_assistant_last_error: patch.error ?? null,
    live_assistant_updated_at: new Date().toISOString(),
  };
  await admin
    .schema("deal_intel")
    .from("meeting_session")
    .update({
      status: patch.status,
      ...(patch.status === "live" ? { started_at: new Date().toISOString(), ended_at: null } : {}),
      ...(patch.status === "ended" ? { ended_at: new Date().toISOString() } : {}),
      metadata: metadataPatch,
    })
    .eq("id", meetingId);
}

async function requireHost(meetingId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  return loadHostMeeting(meetingId, user.id);
}

export async function GET(_req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) {
    return NextResponse.json({ error: host.error }, { status: host.status });
  }
  const guard = ensureAssistantControlEnabled();
  try {
    // When remote control is misconfigured, avoid calling Cloud Run (would throw on missing secret).
    let state =
      guard.ok || !isRemoteLiveAssistantControl()
        ? await getWorkerState(meetingId, host.meeting.livekit_room_name)
        : getLocalWorkerState(meetingId, host.meeting.livekit_room_name);
    const meta = host.meeting.metadata && typeof host.meeting.metadata === "object"
      ? (host.meeting.metadata as Record<string, unknown>)
      : {};
    const assistantExpected =
      guard.ok &&
      (host.meeting.status === "live" || meta.live_assistant_enabled === true) &&
      !workerIsActive(state);
    if (assistantExpected) {
      state = await startWorkerForMeeting(meetingId, host.meeting.livekit_room_name);
      await markAssistantState(meetingId, { status: "live", assistantEnabled: true, workerState: state });
    }
    return NextResponse.json({ enabled: guard.ok, reason: guard.ok ? null : guard.reason, state });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) {
    return NextResponse.json({ error: host.error }, { status: host.status });
  }
  const guard = ensureAssistantControlEnabled();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason }, { status: 400 });
  }
  try {
    const state = await startWorkerForMeeting(meetingId, host.meeting.livekit_room_name);
    await markAssistantState(meetingId, { status: "live", assistantEnabled: true, workerState: state });
    return NextResponse.json({ state });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markAssistantState(meetingId, { status: "error", assistantEnabled: false, error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) {
    return NextResponse.json({ error: host.error }, { status: host.status });
  }
  const guard = ensureAssistantControlEnabled();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason }, { status: 400 });
  }
  try {
    const state = await stopWorkerForMeeting(meetingId, host.meeting.livekit_room_name);
    await markAssistantState(meetingId, { status: "ended", assistantEnabled: false, workerState: state });
    return NextResponse.json({ state });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
