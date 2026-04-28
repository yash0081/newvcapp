"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHANGE_THRESHOLD,
  computeFrameHash,
  hammingDistance,
  type FrameHash,
} from "@/lib/copilot/frame-hash";

const SAMPLE_MS = Math.max(2500, Number(process.env.NEXT_PUBLIC_COPILOT_SAMPLE_MS || 5000));
const TARGET_WIDTH = 1024;
const JPEG_QUALITY = 0.7;

type Props = {
  sessionId: string;
  paused: boolean;
  onPausedChange: (next: boolean) => void;
  onFrame: (imageBase64: string, mimeType: string, hostnameHint?: string) => Promise<void> | void;
  onError: (message: string) => void;
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

export function ScreenWatcher(props: Props) {
  const onFrame = props.onFrame;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastHashRef = useRef<FrameHash | null>(null);
  const tickingRef = useRef(false);
  const [active, setActive] = useState(false);
  const [hostname, setHostname] = useState<string | null>(null);

  function stopStream() {
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    setHostname(null);
    lastHashRef.current = null;
  }

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", stopStream);
        try {
          const settings = track.getSettings() as MediaTrackSettings & {
            displaySurface?: string;
            // Some browsers expose host info via experimental fields; best-effort.
          };
          if (settings.displaySurface !== "browser") {
            // Non-fatal but warn the user; copilot expects a tab share.
            props.onError("Tip: pick a Chrome tab to share for best results.");
          }
        } catch {
          // ignore
        }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setActive(true);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    }
  }

  const captureAndMaybeSend = useCallback(async () => {
    if (tickingRef.current) return;
    if (props.paused) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    tickingRef.current = true;
    try {
      const w = TARGET_WIDTH;
      const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);

      const hash = computeFrameHash(canvas);
      const prev = lastHashRef.current;
      if (prev) {
        const dist = hammingDistance(prev, hash);
        if (dist <= DEFAULT_CHANGE_THRESHOLD) return;
      }
      lastHashRef.current = hash;

      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      if (!blob) return;

      const base64 = await blobToBase64(blob);
      await onFrame(base64, "image/jpeg", hostname ?? undefined);
    } finally {
      tickingRef.current = false;
    }
  }, [props.paused, onFrame, hostname]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      captureAndMaybeSend().catch(() => undefined);
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [active, captureAndMaybeSend]);

  useEffect(() => {
    return () => {
      stopStream();
    };
  }, []);

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-900">Tab capture</p>
          <p className="text-xs text-zinc-500">
            {active
              ? props.paused
                ? "Paused. Resume to keep watching."
                : `Watching${hostname ? ` ${hostname}` : ""}. Sample every ${(SAMPLE_MS / 1000).toFixed(1)}s; only sends when the page changes.`
              : "Click Start watching to share a Chrome tab. Audio is never captured."}
          </p>
        </div>
        <div className="flex gap-2">
          {active ? (
            <>
              <button
                className="crm-button-secondary"
                type="button"
                onClick={() => props.onPausedChange(!props.paused)}
              >
                {props.paused ? "Resume" : "Pause"}
              </button>
              <button className="crm-button-secondary" type="button" onClick={stopStream}>
                Stop
              </button>
            </>
          ) : (
            <button className="crm-button" type="button" onClick={startCapture}>
              Start watching tab
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          className="crm-input flex-1"
          placeholder="Optional: hostname of the tab you're sharing (e.g. linkedin.com)"
          onChange={(e) => setHostname(e.target.value.trim().toLowerCase() || null)}
        />
      </div>
      <video ref={videoRef} muted playsInline className="hidden" />
    </div>
  );
}
