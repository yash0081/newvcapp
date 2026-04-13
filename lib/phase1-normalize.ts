/**
 * Deterministic normalization for Phase 1 parse JSON: lowercase prose, trim fluff tokens.
 * Keeps numeric/currency strings and short acronyms readable; does not re-parse slides.
 */

const FLUFF_RE = /\b(very|really|quite|rather|basically|actually|literally|just|simply|truly|highly)\b/gi;

function normalizeString(s: string): string {
  let t = s.trim().replace(/\s+/g, " ");
  t = t.toLowerCase();
  t = t.replace(FLUFF_RE, " ").replace(/\s+/g, " ").trim();
  return t;
}

function walk(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (keyHint === "company_name" || keyHint === "name") return value.trim().replace(/\s+/g, " ");
    return normalizeString(value);
  }
  if (Array.isArray(value)) return value.map((x) => walk(x));
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      out[k] = walk(o[k], k);
    }
    return out;
  }
  return value;
}

/** Apply in-place-ish normalization to a Phase 1 parsing object. */
export function normalizePhase1Parsing(parsing: Record<string, unknown>): Record<string, unknown> {
  return walk(parsing) as Record<string, unknown>;
}
