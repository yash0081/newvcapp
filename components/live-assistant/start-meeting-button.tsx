"use client";

import { useMemo, useState } from "react";

export function StartMeetingButton(props: { dealId: string }) {
  const [loading, setLoading] = useState(false);
  const [guestUrl, setGuestUrl] = useState<string | null>(null);
  const [workerCmd, setWorkerCmd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fullGuestUrl = useMemo(() => {
    if (!guestUrl) return null;
    try {
      return new URL(guestUrl, window.location.origin).toString();
    } catch {
      return guestUrl;
    }
  }, [guestUrl]);

  const start = async () => {
    setLoading(true);
    setError(null);
    setGuestUrl(null);
    setWorkerCmd(null);
    try {
      const res = await fetch("/api/meetings/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: props.dealId }),
      });
      const json = (await res.json().catch(() => null)) as
        | { guestJoinUrl?: string; meetingId?: string; roomName?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      if (!json?.guestJoinUrl) throw new Error("Missing guestJoinUrl");
      setGuestUrl(json.guestJoinUrl);
      if (json.meetingId && json.roomName) {
        setWorkerCmd(
          `npm run livekit-worker -- --meetingId=${json.meetingId} --roomName=${json.roomName}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!fullGuestUrl) return;
    await navigator.clipboard.writeText(fullGuestUrl);
  };

  const copyCmd = async () => {
    if (!workerCmd) return;
    await navigator.clipboard.writeText(workerCmd);
  };

  return (
    <div className="space-y-2">
      <button className="crm-button" onClick={start} disabled={loading}>
        {loading ? "Starting…" : "Start meeting + get guest link"}
      </button>

      {error ? <p className="text-sm text-rose-600">{error}</p> : null}

      {fullGuestUrl ? (
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs text-zinc-500">Guest link</p>
              <p className="text-sm text-zinc-900 break-all">{fullGuestUrl}</p>
            </div>
            <button className="crm-button-secondary" onClick={copy} type="button">
              Copy
            </button>
          </div>

          {workerCmd ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs text-zinc-500">Local transcription worker command</p>
                <p className="text-sm font-mono text-zinc-900 break-all">{workerCmd}</p>
              </div>
              <button className="crm-button-secondary" onClick={copyCmd} type="button">
                Copy
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

