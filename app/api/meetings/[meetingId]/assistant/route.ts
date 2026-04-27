import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureLocalAutostartEnabled,
  getWorkerState,
  startWorkerForMeeting,
  stopWorkerForMeeting,
} from "@/lib/live-assistant/worker-manager";

async function loadHostMeeting(meetingId: string, hostUserId: string) {
  const admin = createAdminClient();
  const { data: meeting, error } = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id, livekit_room_name")
    .eq("id", meetingId)
    .maybeSingle();
  if (error) return { error: error.message || "Failed to load meeting", status: 500 as const };
  if (!meeting) return { error: "Not found", status: 404 as const };
  if (meeting.host_user_id !== hostUserId) return { error: "Forbidden", status: 403 as const };
  return { meeting };
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
  const guard = ensureLocalAutostartEnabled();
  const state = getWorkerState(meetingId, host.meeting.livekit_room_name);
  return NextResponse.json({ enabled: guard.ok, reason: guard.ok ? null : guard.reason, state });
}

export async function POST(_req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) {
    return NextResponse.json({ error: host.error }, { status: host.status });
  }
  const guard = ensureLocalAutostartEnabled();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason }, { status: 400 });
  }
  const state = startWorkerForMeeting(meetingId, host.meeting.livekit_room_name);
  return NextResponse.json({ state });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) {
    return NextResponse.json({ error: host.error }, { status: host.status });
  }
  const guard = ensureLocalAutostartEnabled();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason }, { status: 400 });
  }
  const state = stopWorkerForMeeting(meetingId, host.meeting.livekit_room_name);
  return NextResponse.json({ state });
}

