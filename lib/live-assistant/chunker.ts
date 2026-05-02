export type ChunkFinalizeReason = "end_of_speech" | "pause_timeout" | "max_length" | "punctuation_boundary";

export type ChunkSourceSegment = {
  segmentId: string;
  speaker: string;
  text: string;
  tStartMs: number;
  tEndMs: number;
  isFinal: boolean;
};

export type SemanticChunk = {
  chunkId: string;
  speaker: string;
  text: string;
  tokenCount: number;
  sentenceCount: number;
  startedAtMs: number;
  endedAtMs: number;
  finalizeReason: ChunkFinalizeReason;
  sourceSegments: ChunkSourceSegment[];
  emittedAtMs: number;
};

type ChunkBuilderOpts = {
  minTokens?: number;
  maxTokens?: number;
  pauseMs?: number;
};

type ChunkSlot = {
  segmentId: string;
  segment: ChunkSourceSegment;
  text: string;
};

type MutableChunkState = {
  speaker: string;
  slots: ChunkSlot[];
  bySegmentId: Map<string, number>;
  lastEndMs: number;
  startedAtMs: number;
};

const DEFAULT_MIN_TOKENS = 10;
const DEFAULT_MAX_TOKENS = 70;
const DEFAULT_PAUSE_MS = 1200;

function tokenize(text: string): string[] {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function sentenceCount(text: string): number {
  const c = String(text || "").match(/[.!?]+/g);
  return c?.length ?? 0;
}

function normalizeText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function joinSlots(slots: ChunkSlot[]): string {
  return normalizeText(slots.map((s) => s.text).join(" "));
}

function chunkId(speaker: string, startedAtMs: number, endedAtMs: number): string {
  return `${speaker}:${startedAtMs}:${endedAtMs}`;
}

export class SemanticChunkBuilder {
  private readonly minTokens: number;
  private readonly maxTokens: number;
  private readonly pauseMs: number;
  private readonly stateBySpeaker = new Map<string, MutableChunkState>();

  constructor(opts: ChunkBuilderOpts = {}) {
    this.minTokens = Math.max(4, opts.minTokens ?? DEFAULT_MIN_TOKENS);
    this.maxTokens = Math.max(this.minTokens + 4, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    this.pauseMs = Math.max(600, opts.pauseMs ?? DEFAULT_PAUSE_MS);
  }

  ingest(segment: ChunkSourceSegment, eventType: "interim" | "final" | "eos"): SemanticChunk[] {
    const out: SemanticChunk[] = [];
    const speaker = segment.speaker || "speaker";
    const normalized = normalizeText(segment.text);
    if (!normalized) return out;

    let st = this.stateBySpeaker.get(speaker);
    if (!st) {
      st = {
        speaker,
        slots: [],
        bySegmentId: new Map(),
        lastEndMs: segment.tEndMs,
        startedAtMs: segment.tStartMs,
      };
      this.stateBySpeaker.set(speaker, st);
    }

    const preText = joinSlots(st.slots);
    const preTokens = tokenize(preText).length;
    const pause = Math.max(0, segment.tStartMs - st.lastEndMs);

    if (pause > this.pauseMs && preTokens >= this.minTokens) {
      const flushed = this.flushSpeaker(speaker, "pause_timeout");
      if (flushed) out.push(flushed);
      st = {
        speaker,
        slots: [],
        bySegmentId: new Map(),
        lastEndMs: segment.tEndMs,
        startedAtMs: segment.tStartMs,
      };
      this.stateBySpeaker.set(speaker, st);
    }

    const segId = String(segment.segmentId || "");
    if (segId && st.bySegmentId.has(segId)) {
      const idx = st.bySegmentId.get(segId)!;
      st.slots[idx] = { segmentId: segId, segment, text: normalized };
    } else {
      const idx = st.slots.length;
      st.slots.push({ segmentId: segId || `anon:${idx}:${segment.tStartMs}`, segment, text: normalized });
      if (segId) st.bySegmentId.set(segId, idx);
    }

    st.lastEndMs = segment.tEndMs;
    if (st.slots.length) {
      st.startedAtMs = Math.min(...st.slots.map((s) => s.segment.tStartMs));
    }

    const text = joinSlots(st.slots);
    const tokens = tokenize(text).length;
    const endedWithBoundary =
      /[.!?]\s*$/.test(text) || /\b(actually|to clarify|however|but)\b/i.test(text);

    if (tokens >= this.maxTokens) {
      const flushed = this.flushSpeaker(speaker, "max_length");
      if (flushed) out.push(flushed);
      return out;
    }
    // Do NOT flush on every `final && isFinal` — Deepgram may emit multiple finals for the same
    // logical segment (smart-format rewrite). Same `segmentId` replaces in-place; we flush only
    // on EOS, punctuation boundary, pause, max_length, or flushIdle.
    if (eventType === "eos") {
      const flushed = this.flushSpeaker(speaker, "end_of_speech");
      if (flushed) out.push(flushed);
      return out;
    }
    if (eventType === "final" && endedWithBoundary) {
      const flushed = this.flushSpeaker(speaker, "punctuation_boundary");
      if (flushed) out.push(flushed);
    }
    return out;
  }

  /**
   * Flush any speaker buffer that has been idle longer than `pauseMs` (no new STT event).
   * Call from a periodic watchdog — otherwise pause-timeout never fires when audio stops.
   */
  /**
   * Flush when the last segment ended long enough ago. Uses `minTokens` for normal idle; if the
   * buffer is still short, only flushes after `3 * pauseMs` so "Yes" / "Ok" is not cut off
   * mid-utterance but cannot hang for minutes.
   */
  flushIdle(nowMs: number): SemanticChunk[] {
    const out: SemanticChunk[] = [];
    for (const speaker of [...this.stateBySpeaker.keys()]) {
      const st = this.stateBySpeaker.get(speaker);
      if (!st || st.slots.length === 0) continue;
      const idleMs = nowMs - st.lastEndMs;
      if (idleMs <= this.pauseMs) continue;
      const preText = joinSlots(st.slots);
      const preTokens = tokenize(preText).length;
      if (preTokens < this.minTokens && idleMs <= this.pauseMs * 3) continue;
      const flushed = this.flushSpeaker(speaker, "pause_timeout");
      if (flushed) out.push(flushed);
    }
    return out;
  }

  flushAll(reason: ChunkFinalizeReason = "pause_timeout"): SemanticChunk[] {
    const out: SemanticChunk[] = [];
    for (const speaker of this.stateBySpeaker.keys()) {
      const c = this.flushSpeaker(speaker, reason);
      if (c) out.push(c);
    }
    return out;
  }

  private flushSpeaker(speaker: string, reason: ChunkFinalizeReason): SemanticChunk | null {
    const st = this.stateBySpeaker.get(speaker);
    if (!st || st.slots.length === 0) return null;
    const text = joinSlots(st.slots);
    const tokens = tokenize(text).length;
    if (!text || tokens === 0) {
      this.stateBySpeaker.delete(speaker);
      return null;
    }
    const c: SemanticChunk = {
      chunkId: chunkId(speaker, st.startedAtMs, st.lastEndMs),
      speaker,
      text,
      tokenCount: tokens,
      sentenceCount: sentenceCount(text),
      startedAtMs: st.startedAtMs,
      endedAtMs: st.lastEndMs,
      finalizeReason: reason,
      sourceSegments: st.slots.map((s) => s.segment),
      emittedAtMs: Date.now(),
    };
    this.stateBySpeaker.delete(speaker);
    return c;
  }
}
