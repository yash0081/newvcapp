// Browser-friendly perceptual hash + Hamming distance helpers used by the
// research copilot to skip frames that haven't changed enough to re-extract.
//
// Implementation: classic 16x16 grayscale average-hash. Cheap and good enough
// to detect tab/page transitions and meaningful scrolls; not robust against
// subtle theme changes (which is fine — we'd rather over-call than under-call).

const HASH_SIDE = 16;

function toGrayscale(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export type FrameHash = Uint8Array;

/**
 * Compute an average-hash of the given image source by drawing it into a
 * 16x16 offscreen canvas. Returns a 32-byte (256-bit) Uint8Array.
 *
 * The function works for any drawable source (HTMLVideoElement, ImageBitmap,
 * HTMLCanvasElement, etc.) — caller controls the source.
 */
export function computeFrameHash(source: CanvasImageSource): FrameHash {
  if (typeof document === "undefined") {
    throw new Error("computeFrameHash must run in the browser");
  }
  const canvas = document.createElement("canvas");
  canvas.width = HASH_SIDE;
  canvas.height = HASH_SIDE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable for frame hashing");
  ctx.drawImage(source, 0, 0, HASH_SIDE, HASH_SIDE);
  const { data } = ctx.getImageData(0, 0, HASH_SIDE, HASH_SIDE);

  const grays = new Array<number>(HASH_SIDE * HASH_SIDE);
  let sum = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = toGrayscale(data[i]!, data[i + 1]!, data[i + 2]!);
    grays[j] = v;
    sum += v;
  }
  const avg = sum / grays.length;

  const out = new Uint8Array(HASH_SIDE * HASH_SIDE / 8);
  for (let i = 0; i < grays.length; i++) {
    if (grays[i]! >= avg) {
      out[i >> 3]! |= 1 << (7 - (i & 7));
    }
  }
  return out;
}

const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = 0;
    let n = i;
    while (n) {
      c += n & 1;
      n >>= 1;
    }
    t[i] = c;
  }
  return t;
})();

export function hammingDistance(a: FrameHash, b: FrameHash): number {
  if (a.length !== b.length) throw new Error("hammingDistance: hashes differ in length");
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d += POPCOUNT[a[i]! ^ b[i]!]!;
  }
  return d;
}

/**
 * Default change threshold for "send for extraction". 256-bit hash; tuned to
 * trigger on content shifts but ignore minor flicker / cursor movement.
 */
export const DEFAULT_CHANGE_THRESHOLD = 18;
