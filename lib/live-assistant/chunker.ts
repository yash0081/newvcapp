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

type MutableChunkState = {
  speaker: string;
  sourceSegments: ChunkSourceSegment[];
  lastEndMs: number;
  startedAtMs: number;
  textParts: string[];
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
        sourceSegments: [],
        lastEndMs: segment.tEndMs,
        startedAtMs: segment.tStartMs,
        textParts: [],
      };
      this.stateBySpeaker.set(speaker, st);
    }

    const pause = Math.max(0, segment.tStartMs - st.lastEndMs);
    const preText = normalizeText(st.textParts.join(" "));
    const preTokens = tokenize(preText).length;

    if (pause > this.pauseMs && preTokens >= this.minTokens) {
      const flushed = this.flushSpeaker(speaker, "pause_timeout");
      if (flushed) out.push(flushed);
      st = {
        speaker,
        sourceSegments: [],
        lastEndMs: segment.tEndMs,
        startedAtMs: segment.tStartMs,
        textParts: [],
      };
      this.stateBySpeaker.set(speaker, st);
    }

    st.sourceSegments.push(segment);
    st.textParts.push(normalized);
    st.lastEndMs = segment.tEndMs;
    if (st.sourceSegments.length === 1) st.startedAtMs = segment.tStartMs;

    const text = normalizeText(st.textParts.join(" "));
    const tokens = tokenize(text).length;
    const endedWithBoundary = /[.!?]\s*$/.test(text) || /\b(actually|to clarify|however|but)\b/i.test(normalized);

    if (tokens >= this.maxTokens) {
      const flushed = this.flushSpeaker(speaker, "max_length");
      if (flushed) out.push(flushed);
      return out;
    }
    if (eventType === "eos" || (eventType === "final" && segment.isFinal)) {
      if (tokens >= this.minTokens) {
        const flushed = this.flushSpeaker(speaker, "end_of_speech");
        if (flushed) out.push(flushed);
      }
      return out;
    }
    if (eventType === "final" && endedWithBoundary && tokens >= this.minTokens) {
      const flushed = this.flushSpeaker(speaker, "punctuation_boundary");
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
    if (!st || st.sourceSegments.length === 0) return null;
    const text = normalizeText(st.textParts.join(" "));
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
      sourceSegments: st.sourceSegments,
      emittedAtMs: Date.now(),
    };
    this.stateBySpeaker.delete(speaker);
    return c;
  }
}

