/**
 * Phase agents are prompted for 0–10 scores, but models often return 0–100 or 0–1 instead.
 * Normalize to 0–10 for storage, composites, and UI.
 */
export function normalizeScore0to10(raw: unknown): number {
  if (typeof raw === "string") {
    const n = parseFloat(raw.trim());
    if (Number.isNaN(n)) return 0;
    return normalizeScore0to10(n);
  }
  if (typeof raw !== "number" || Number.isNaN(raw)) return 0;
  let v = raw;
  if (v > 10 && v <= 100) {
    v = v / 10;
  }
  if (v > 100) {
    v = 10;
  }
  // Treat (0, 1) as a 0–1 fraction of max (e.g. 0.9 → 9). Skip exactly 1 so a literal 1/10 stays 1.
  if (v > 0 && v < 1) {
    v = v * 10;
  }
  return Math.max(0, Math.min(10, v));
}
