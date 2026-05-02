/**
 * GuestTurnTracker
 *
 * Coalesces SemanticChunks into per-speaker "turns" so the canonical verifier fires once
 * per guest turn, not once per chunk. A turn closes when:
 *   - A chunk arrives whose role differs from the open turn's role (speaker switch), OR
 *   - `tickIdle` notices no activity within `settleMs` (default 2500ms).
 *
 * Host turns are tracked the same way but never trigger the verifier — they exist purely
 * to give the next guest turn labeled dialogue context.
 */

import { createHash } from "node:crypto";
import type { SemanticChunk } from "@/lib/live-assistant/chunker";

export type SpeakerRole = "host" | "guest" | "other";

export type SettledTurn = {
  turnId: string;
  role: SpeakerRole;
  speaker: string;
  text: string;
  tStartMs: number;
  tEndMs: number;
  sourceChunkIds: string[];
};

export type DialogueLine = SettledTurn & { inProgress?: boolean };

type OpenTurnState = {
  role: SpeakerRole;
  speaker: string;
  parts: string[];
  tStartMs: number;
  tEndMs: number;
  lastActivityMs: number;
  sourceChunkIds: string[];
};

type GuestTurnTrackerOpts = {
  meetingId: string;
  /** Max idle time before an open turn auto-settles (default 2500ms, env LIVE_ASSISTANT_TURN_SETTLE_MS). */
  settleMs?: number;
  /** Ring length of settled turns kept in memory for `getRecentDialogue` (default 8). */
  recentTurnLimit?: number;
};

const DEFAULT_SETTLE_MS = 2500;
const DEFAULT_RECENT_LIMIT = 8;

function roleFromSpeaker(speaker: string): SpeakerRole {
  if (speaker.startsWith("host:")) return "host";
  if (speaker.startsWith("guest:")) return "guest";
  return "other";
}

function turnIdFor(meetingId: string, speaker: string, tStartMs: number, tEndMs: number): string {
  return createHash("sha1")
    .update(`${meetingId}:${speaker}:${tStartMs}:${tEndMs}`)
    .digest("hex")
    .slice(0, 16);
}

function normalizeJoin(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export class GuestTurnTracker {
  private readonly meetingId: string;
  private readonly settleMs: number;
  private readonly recentTurnLimit: number;
  private readonly openByRole = new Map<SpeakerRole, OpenTurnState>();
  private readonly recent: SettledTurn[] = [];
  private listener: ((turn: SettledTurn) => void) | null = null;

  constructor(opts: GuestTurnTrackerOpts) {
    this.meetingId = opts.meetingId;
    this.settleMs = Math.max(500, opts.settleMs ?? DEFAULT_SETTLE_MS);
    this.recentTurnLimit = Math.max(2, opts.recentTurnLimit ?? DEFAULT_RECENT_LIMIT);
  }

  onGuestTurnSettled(cb: (turn: SettledTurn) => void): void {
    this.listener = cb;
  }

  /**
   * Append a semantic chunk to the open turn for its role. If the previous open turn was a
   * different role, that turn settles first (and emits if it was a guest turn).
   *
   * Returns settled turns in chronological order — host turns included so callers can persist
   * them for diagnostics, but only guest turns trigger the listener.
   */
  ingestChunk(ch: SemanticChunk): SettledTurn[] {
    const role = roleFromSpeaker(ch.speaker);
    const settled: SettledTurn[] = [];

    for (const [otherRole, state] of [...this.openByRole.entries()]) {
      if (otherRole === role) continue;
      if (state.tEndMs <= ch.startedAtMs) {
        const t = this.closeRole(otherRole);
        if (t) settled.push(t);
      }
    }

    let open = this.openByRole.get(role);
    if (!open) {
      open = {
        role,
        speaker: ch.speaker,
        parts: [],
        tStartMs: ch.startedAtMs,
        tEndMs: ch.endedAtMs,
        lastActivityMs: ch.endedAtMs,
        sourceChunkIds: [],
      };
      this.openByRole.set(role, open);
    }

    open.parts.push(ch.text);
    open.tEndMs = Math.max(open.tEndMs, ch.endedAtMs);
    open.lastActivityMs = Math.max(open.lastActivityMs, ch.endedAtMs);
    if (ch.chunkId) open.sourceChunkIds.push(ch.chunkId);
    if (!open.speaker) open.speaker = ch.speaker;

    return settled;
  }

  /** Close any open turn idle longer than settleMs. Use from a periodic watchdog. */
  tickIdle(nowMs: number): SettledTurn[] {
    const out: SettledTurn[] = [];
    for (const role of [...this.openByRole.keys()]) {
      const st = this.openByRole.get(role);
      if (!st) continue;
      const idle = nowMs - st.lastActivityMs;
      if (idle < this.settleMs) continue;
      const t = this.closeRole(role);
      if (t) out.push(t);
    }
    return out;
  }

  /** Force-close every open turn (SIGINT / disconnect). Returns settled turns in time order. */
  flushAll(): SettledTurn[] {
    const out: SettledTurn[] = [];
    for (const role of [...this.openByRole.keys()]) {
      const t = this.closeRole(role);
      if (t) out.push(t);
    }
    out.sort((a, b) => a.tStartMs - b.tStartMs);
    return out;
  }

  /**
   * Last `limit` settled turns (chronological) plus the currently open turn marked
   * `inProgress` if any. Use to feed labeled dialogue into the verifier prompt.
   */
  getRecentDialogue(limit = 4): DialogueLine[] {
    const settled = this.recent.slice(-Math.max(0, limit));
    const lines: DialogueLine[] = settled.map((t) => ({ ...t }));
    for (const st of this.openByRole.values()) {
      const text = normalizeJoin(st.parts);
      if (!text) continue;
      lines.push({
        turnId: turnIdFor(this.meetingId, st.speaker, st.tStartMs, st.tEndMs),
        role: st.role,
        speaker: st.speaker,
        text,
        tStartMs: st.tStartMs,
        tEndMs: st.tEndMs,
        sourceChunkIds: [...st.sourceChunkIds],
        inProgress: true,
      });
    }
    lines.sort((a, b) => a.tStartMs - b.tStartMs);
    return lines;
  }

  private closeRole(role: SpeakerRole): SettledTurn | null {
    const st = this.openByRole.get(role);
    if (!st) return null;
    this.openByRole.delete(role);
    const text = normalizeJoin(st.parts);
    if (!text) return null;
    const turn: SettledTurn = {
      turnId: turnIdFor(this.meetingId, st.speaker, st.tStartMs, st.tEndMs),
      role: st.role,
      speaker: st.speaker,
      text,
      tStartMs: st.tStartMs,
      tEndMs: st.tEndMs,
      sourceChunkIds: [...st.sourceChunkIds],
    };
    this.recent.push(turn);
    while (this.recent.length > this.recentTurnLimit) this.recent.shift();
    if (turn.role === "guest" && this.listener) {
      try {
        this.listener(turn);
      } catch (e) {
        console.error("[guest-turn-tracker] listener threw", e);
      }
    }
    return turn;
  }
}
