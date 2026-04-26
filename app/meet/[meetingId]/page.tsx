"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { MeetRoomClient } from "@/components/live-assistant/meet-room-client";

function MeetRoomInner() {
  const params = useParams<{ meetingId: string }>();
  const meetingId = typeof params?.meetingId === "string" ? params.meetingId : "";
  return <MeetRoomClient meetingId={meetingId} />;
}

export default function MeetRoomPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">Loading meeting…</div>}>
      <MeetRoomInner />
    </Suspense>
  );
}

