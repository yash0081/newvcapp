import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cwd } from "node:process";

export type WorkerStatus = "idle" | "starting" | "running" | "stopped" | "error";

export type WorkerState = {
  meetingId: string;
  roomName: string;
  status: WorkerStatus;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
  lastExitCode: number | null;
  lastSignal: string | null;
};

type WorkerProcessState = WorkerState & {
  proc: ChildProcessWithoutNullStreams | null;
};

const workers = new Map<string, WorkerProcessState>();

function envFlagExplicitFalse(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/** True when the Next.js API should proxy control calls to Cloud Run (`LIVE_ASSISTANT_URL`). */
export function isRemoteLiveAssistantControl(): boolean {
  return Boolean(process.env.LIVE_ASSISTANT_URL?.trim());
}

function liveAssistantBaseUrl(): string | null {
  const u = process.env.LIVE_ASSISTANT_URL?.trim();
  return u || null;
}

function liveAssistantControlSecret(): string | null {
  const s = process.env.LIVE_ASSISTANT_CONTROL_SECRET?.trim();
  return s || null;
}

async function remoteFetch(pathWithQuery: string, init?: RequestInit): Promise<Response> {
  const base = liveAssistantBaseUrl();
  const secret = liveAssistantControlSecret();
  if (!base || !secret) {
    throw new Error("LIVE_ASSISTANT_URL and LIVE_ASSISTANT_CONTROL_SECRET are required for remote assistant control");
  }
  const url = `${base.replace(/\/$/, "")}${pathWithQuery}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${secret}`);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

async function readRemoteError(res: Response): Promise<string> {
  const t = await res.text();
  try {
    const j = JSON.parse(t) as { error?: string };
    if (typeof j.error === "string" && j.error) return j.error;
  } catch {
    /* ignore */
  }
  return t || res.statusText || `HTTP ${res.status}`;
}

/**
 * Whether the host can start/stop the live transcription worker from the app.
 *
 * - **Production (Vercel):** set `LIVE_ASSISTANT_URL` to the Cloud Run live-assistant base URL
 *   and `LIVE_ASSISTANT_CONTROL_SECRET` (same value on Vercel and Cloud Run).
 * - **Local dev:** `NODE_ENV=development` and spawn worker on the same machine (optional
 *   `LIVE_ASSISTANT_AUTOSTART_LOCAL=0` to disable).
 */
export function ensureAssistantControlEnabled(): { ok: true } | { ok: false; reason: string } {
  if (isRemoteLiveAssistantControl()) {
    if (!liveAssistantControlSecret()) {
      return {
        ok: false,
        reason: "LIVE_ASSISTANT_CONTROL_SECRET must be set when LIVE_ASSISTANT_URL is set.",
      };
    }
    return { ok: true };
  }
  if (process.env.NODE_ENV !== "development") {
    return { ok: false, reason: "Assistant autostart is only supported in local development." };
  }
  if (envFlagExplicitFalse("LIVE_ASSISTANT_AUTOSTART_LOCAL")) {
    return { ok: false, reason: "Local assistant is disabled (set LIVE_ASSISTANT_AUTOSTART_LOCAL=1 to re-enable)." };
  }
  return { ok: true };
}

/** @deprecated Use `ensureAssistantControlEnabled`. */
export function ensureLocalAutostartEnabled(): { ok: true } | { ok: false; reason: string } {
  return ensureAssistantControlEnabled();
}

function baseState(meetingId: string, roomName: string): WorkerProcessState {
  return {
    meetingId,
    roomName,
    status: "idle",
    pid: null,
    proc: null,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    lastExitCode: null,
    lastSignal: null,
  };
}

function toPublicState(state: WorkerProcessState): WorkerState {
  return {
    meetingId: state.meetingId,
    roomName: state.roomName,
    status: state.status,
    pid: state.pid,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    lastError: state.lastError,
    lastExitCode: state.lastExitCode,
    lastSignal: state.lastSignal,
  };
}

/** In-process worker registry + child spawn (Next.js dev machine or Cloud Run live-assistant container). */
export function getLocalWorkerState(meetingId: string, roomName: string): WorkerState {
  const existing = workers.get(meetingId);
  if (!existing) return toPublicState(baseState(meetingId, roomName));
  if (existing.roomName !== roomName) existing.roomName = roomName;
  return toPublicState(existing);
}

export function startLocalWorkerForMeeting(meetingId: string, roomName: string): WorkerState {
  const existing = workers.get(meetingId);
  if (existing?.proc && !existing.proc.killed && existing.status !== "stopped" && existing.status !== "error") {
    return toPublicState(existing);
  }

  const state = existing ?? baseState(meetingId, roomName);
  state.roomName = roomName;
  state.status = "starting";
  state.lastError = null;
  state.stoppedAt = null;
  state.lastExitCode = null;
  state.lastSignal = null;

  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["run", "livekit-worker", "--", `--meetingId=${meetingId}`, `--roomName=${roomName}`];
  const proc = spawn(cmd, args, {
    cwd: cwd(),
    env: process.env,
    stdio: "pipe",
  });

  state.proc = proc;
  state.pid = proc.pid ?? null;
  state.startedAt = new Date().toISOString();
  state.status = "running";
  workers.set(meetingId, state);

  const onData = (chunk: Buffer) => {
    const msg = chunk.toString("utf8").trim();
    if (!msg) return;
    const lowered = msg.toLowerCase();
    if (lowered.includes("error") || lowered.includes("failed")) {
      state.lastError = msg.slice(0, 2000);
    }
  };
  proc.stderr.on("data", onData);
  proc.stdout.on("data", onData);

  proc.once("error", (err) => {
    state.status = "error";
    state.lastError = err.message;
    state.stoppedAt = new Date().toISOString();
    state.proc = null;
    state.pid = null;
  });

  proc.once("exit", (code, signal) => {
    state.status = code === 0 ? "stopped" : "error";
    state.lastExitCode = typeof code === "number" ? code : null;
    state.lastSignal = signal;
    state.stoppedAt = new Date().toISOString();
    state.proc = null;
    state.pid = null;
  });

  return toPublicState(state);
}

export function stopLocalWorkerForMeeting(meetingId: string, roomName: string): WorkerState {
  const state = workers.get(meetingId) ?? baseState(meetingId, roomName);
  state.roomName = roomName;
  const proc = state.proc;
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
  }
  state.status = "stopped";
  state.proc = null;
  state.pid = null;
  state.stoppedAt = new Date().toISOString();
  workers.set(meetingId, state);
  return toPublicState(state);
}

async function getRemoteWorkerState(meetingId: string, roomName: string): Promise<WorkerState> {
  const q = new URLSearchParams();
  q.set("roomName", roomName);
  const res = await remoteFetch(`/v1/workers/${encodeURIComponent(meetingId)}?${q.toString()}`, { method: "GET" });
  if (!res.ok) throw new Error(await readRemoteError(res));
  const json = (await res.json()) as { state?: WorkerState };
  if (!json.state) throw new Error("Invalid response from live assistant service");
  return json.state;
}

async function startRemoteWorkerForMeeting(meetingId: string, roomName: string): Promise<WorkerState> {
  const res = await remoteFetch("/v1/workers", {
    method: "POST",
    body: JSON.stringify({ meetingId, roomName }),
  });
  if (!res.ok) throw new Error(await readRemoteError(res));
  const json = (await res.json()) as { state?: WorkerState };
  if (!json.state) throw new Error("Invalid response from live assistant service");
  return json.state;
}

async function stopRemoteWorkerForMeeting(meetingId: string, roomName: string): Promise<WorkerState> {
  const q = new URLSearchParams();
  q.set("roomName", roomName);
  const res = await remoteFetch(`/v1/workers/${encodeURIComponent(meetingId)}?${q.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await readRemoteError(res));
  const json = (await res.json()) as { state?: WorkerState };
  if (!json.state) throw new Error("Invalid response from live assistant service");
  return json.state;
}

export async function getWorkerState(meetingId: string, roomName: string): Promise<WorkerState> {
  if (isRemoteLiveAssistantControl()) return getRemoteWorkerState(meetingId, roomName);
  return getLocalWorkerState(meetingId, roomName);
}

export async function startWorkerForMeeting(meetingId: string, roomName: string): Promise<WorkerState> {
  if (isRemoteLiveAssistantControl()) return startRemoteWorkerForMeeting(meetingId, roomName);
  return startLocalWorkerForMeeting(meetingId, roomName);
}

export async function stopWorkerForMeeting(meetingId: string, roomName: string): Promise<WorkerState> {
  if (isRemoteLiveAssistantControl()) return stopRemoteWorkerForMeeting(meetingId, roomName);
  return stopLocalWorkerForMeeting(meetingId, roomName);
}
