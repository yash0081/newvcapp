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

export function ensureLocalAutostartEnabled(): { ok: true } | { ok: false; reason: string } {
  if (process.env.NODE_ENV !== "development") {
    return { ok: false, reason: "Assistant autostart is only supported in local development." };
  }
  // In local dev, enable by default. Allow explicit disable for safety.
  if (envFlagExplicitFalse("LIVE_ASSISTANT_AUTOSTART_LOCAL")) {
    return { ok: false, reason: "Local assistant is disabled (set LIVE_ASSISTANT_AUTOSTART_LOCAL=1 to re-enable)." };
  }
  return { ok: true };
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

export function getWorkerState(meetingId: string, roomName: string): WorkerState {
  const existing = workers.get(meetingId);
  if (!existing) return toPublicState(baseState(meetingId, roomName));
  if (existing.roomName !== roomName) existing.roomName = roomName;
  return toPublicState(existing);
}

export function startWorkerForMeeting(meetingId: string, roomName: string): WorkerState {
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

export function stopWorkerForMeeting(meetingId: string, roomName: string): WorkerState {
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

