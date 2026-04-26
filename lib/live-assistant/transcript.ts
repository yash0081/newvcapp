export type TranscriptSegment = {
  /**
   * Stable identifier for the logical segment across interim/final/corrections.
   * For Deepgram, this should be a deterministic key derived from the stream + segment timing
   * (or Deepgram's own stable segment id if available).
   */
  segmentId: string;
  tStartMs: number;
  tEndMs: number;
  speaker?: string;
  text: string;
  isFinal: boolean;
  revision: number;
};

export type TranscriptDelta = {
  kind: "upsert";
  segment: TranscriptSegment;
};

function clampNonNegativeInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function normalizeText(s: string): string {
  return String(s || "")
    .replaceAll("\u0000", "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function byTimeThenId(a: TranscriptSegment, b: TranscriptSegment): number {
  if (a.tStartMs !== b.tStartMs) return a.tStartMs - b.tStartMs;
  if (a.tEndMs !== b.tEndMs) return a.tEndMs - b.tEndMs;
  return a.segmentId.localeCompare(b.segmentId);
}

/**
 * In-memory transcript buffer that supports:
 * - a raw ring window (time-bounded) for "verbatim recent context"
 * - corrections by replacing/up-revisioning a stable `segmentId`
 *
 * Persistence contract:
 * - DB table `deal_intel.meeting_transcript_segment` is append-only.
 * - Each correction increments `revision` for the same `segment_key` (segmentId).
 */
export class TranscriptRingBuffer {
  private readonly maxWindowMs: number;
  private readonly segmentsById = new Map<string, TranscriptSegment>();

  constructor(opts: { maxWindowMs: number }) {
    this.maxWindowMs = Math.max(10_000, opts.maxWindowMs);
  }

  /**
   * Apply a segment update. If the segmentId already exists:
   * - if content is identical, ignore
   * - otherwise, replace and keep `revision` monotonic
   */
  upsert(raw: TranscriptSegment): TranscriptDelta | null {
    const seg: TranscriptSegment = {
      segmentId: String(raw.segmentId),
      tStartMs: clampNonNegativeInt(raw.tStartMs),
      tEndMs: clampNonNegativeInt(raw.tEndMs),
      speaker: raw.speaker ? String(raw.speaker) : undefined,
      text: normalizeText(raw.text),
      isFinal: Boolean(raw.isFinal),
      revision: clampNonNegativeInt(raw.revision),
    };

    if (!seg.segmentId || !seg.text) return null;

    const prev = this.segmentsById.get(seg.segmentId);
    if (prev) {
      const unchanged =
        prev.tStartMs === seg.tStartMs &&
        prev.tEndMs === seg.tEndMs &&
        prev.text === seg.text &&
        prev.isFinal === seg.isFinal &&
        (prev.speaker || "") === (seg.speaker || "");
      if (unchanged) return null;

      // Ensure revision monotonic when caller doesn't manage it.
      const nextRevision = Math.max(prev.revision + 1, seg.revision);
      const next = { ...seg, revision: nextRevision };
      this.segmentsById.set(seg.segmentId, next);
      return { kind: "upsert", segment: next };
    }

    this.segmentsById.set(seg.segmentId, seg);
    return { kind: "upsert", segment: seg };
  }

  /**
   * Drop segments older than (nowMs - maxWindowMs) by end time.
   */
  prune(nowMs: number): void {
    const cutoff = clampNonNegativeInt(nowMs) - this.maxWindowMs;
    for (const [id, s] of this.segmentsById.entries()) {
      if (s.tEndMs < cutoff) this.segmentsById.delete(id);
    }
  }

  /**
   * Return segments in a time-ordered view.
   * If `finalOnly`, excludes interim segments.
   */
  list(opts?: { finalOnly?: boolean }): TranscriptSegment[] {
    const finalOnly = Boolean(opts?.finalOnly);
    const out: TranscriptSegment[] = [];
    for (const s of this.segmentsById.values()) {
      if (finalOnly && !s.isFinal) continue;
      out.push(s);
    }
    out.sort(byTimeThenId);
    return out;
  }

  /**
   * Extract a window of segments by time range.
   */
  windowByTime(opts: { startMs: number; endMs: number; finalOnly?: boolean }): TranscriptSegment[] {
    const start = clampNonNegativeInt(opts.startMs);
    const end = clampNonNegativeInt(opts.endMs);
    const finalOnly = Boolean(opts.finalOnly);
    const out: TranscriptSegment[] = [];
    for (const s of this.segmentsById.values()) {
      if (finalOnly && !s.isFinal) continue;
      if (s.tEndMs < start) continue;
      if (s.tStartMs > end) continue;
      out.push(s);
    }
    out.sort(byTimeThenId);
    return out;
  }

  /**
   * Build plain text for prompting. Keeps stable ordering and avoids huge prompts.
   */
  renderText(segments: TranscriptSegment[], opts?: { includeTimestamps?: boolean; maxChars?: number }): string {
    const includeTimestamps = Boolean(opts?.includeTimestamps);
    const maxChars = Math.max(500, opts?.maxChars ?? 12_000);
    let out = "";
    for (const s of segments) {
      const prefix = includeTimestamps ? `[${Math.floor(s.tStartMs / 1000)}s] ` : "";
      const line = `${prefix}${s.text}\n`;
      if (out.length + line.length > maxChars) break;
      out += line;
    }
    return out.trim();
  }
}

