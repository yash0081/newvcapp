/**
 * Ground meeting note bullets in source claim text to reduce LLM hallucinations.
 * Reuses verbatim-span logic from quote-grounding where helpful.
 */

import { findVerbatimSpan } from "@/lib/live-assistant/quote-grounding";

export type ClaimRow = { id: string; text: string };

/** Concatenate cited claims for lexical checks. */
export function buildHaystackFromClaims(claimsById: Map<string, string>, claimIds: string[]): string {
  const parts: string[] = [];
  for (const id of claimIds) {
    const t = claimsById.get(id);
    if (t) parts.push(t);
  }
  return parts.join(" ").trim();
}

/**
 * Capitalized / acronym tokens that look like proper nouns (length >= 2 for acronyms).
 */
function candidateProperTokens(text: string): string[] {
  const out: string[] = [];
  const re = /\b[A-Z][a-z]{2,}\b|\b[A-Z]{2,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[0];
    if (w) out.push(w);
  }
  return out;
}

/** True if token appears in haystack (case-insensitive, word boundary loose). */
function tokenInHaystack(token: string, haystackLower: string): boolean {
  const t = token.toLowerCase();
  if (t.length <= 1) return true;
  return haystackLower.includes(t);
}

/**
 * If bullet introduces proper-noun tokens absent from haystack, treat as ungrounded unless
 * we can repair from verbatim spans.
 */
export function hasNovelProperNouns(bulletText: string, haystack: string): boolean {
  const hl = haystack.toLowerCase();
  for (const tok of candidateProperTokens(bulletText)) {
    if (!tokenInHaystack(tok, hl)) return true;
  }
  return false;
}

/**
 * Memo-style bullets: keep polished LLM wording if grounded (no invented proper nouns vs haystack).
 * Does **not** splice verbatim transcript spans — avoids notes reading like raw STT.
 */
/** Slice chunk text to the neighborhood of the claim so notes haystack isn't polluted by unrelated sentences in the same chunk. */
export function narrowChunkContextForClaim(chunkText: string, claimText: string, radius = 280): string {
  const c = String(chunkText || "")
    .replace(/\s+/g, " ")
    .trim();
  const q = String(claimText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!c || !q) return "";
  const lower = c.toLowerCase();
  const qLower = q.toLowerCase();
  const needle = qLower.slice(0, Math.min(96, qLower.length));
  let idx = needle.length >= 12 ? lower.indexOf(needle) : -1;
  if (idx < 0 && needle.length > 24) idx = lower.indexOf(needle.slice(0, 48));
  if (idx < 0) {
    for (const w of qLower.split(/\s+/).filter((x) => x.length > 3)) {
      const at = lower.indexOf(w);
      if (at >= 0) {
        idx = at;
        break;
      }
    }
  }
  if (idx < 0) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(c.length, idx + q.length + radius);
  return c.slice(start, end).trim();
}

/**
 * Drop bullets that invent competitive framing when the cited claims/chunk only discuss partnerships,
 * or mention competitors when the source never does.
 */
export function competitiveMemoLexiconGrounded(bulletText: string, haystack: string): boolean {
  const h = haystack.toLowerCase();
  const competitiveBullet =
    /\b(competitor|competitors|competition|competitive|compete|competing|versus)\b/i.test(bulletText) ||
    /\bvs\.?\s+[a-z]/i.test(bulletText);
  const competitiveHay =
    /\b(competitor|competitors|competition|competitive|compete|competing|versus)\b/i.test(haystack) ||
    /\bvs\.?\s+[a-z]/i.test(haystack);
  if (!competitiveBullet) return true;
  if (!competitiveHay) return false;
  return true;
}

export function softGroundMemoBullet(bulletText: string, haystack: string): { text: string | null } {
  const trimmed = bulletText.trim().slice(0, 280);
  if (!trimmed || trimmed.length < 8 || !haystack.trim()) return { text: null };
  if (hasNovelProperNouns(trimmed, haystack)) return { text: null };
  if (!competitiveMemoLexiconGrounded(trimmed, haystack)) return { text: null };
  return { text: trimmed };
}

/**
 * Legacy: verbatim-span repair (extractive/debug). Prefer {@link softGroundMemoBullet} for LLM notes.
 */
export function validateAndRepairBullet(bulletText: string, haystack: string): { text: string | null } {
  const trimmed = bulletText.trim();
  if (!trimmed || !haystack.trim()) return { text: null };

  const full = findVerbatimSpan(haystack, trimmed);
  if (full && full.matched.length >= 8) {
    return { text: full.matched.slice(0, 320).trim() };
  }

  const pieces: string[] = [];
  const chunks = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const ch of chunks) {
    if (ch.length < 6) continue;
    const sp = findVerbatimSpan(haystack, ch);
    if (sp) pieces.push(sp.matched.trim());
  }
  if (pieces.length) {
    const joined = [...new Set(pieces)].join("; ").slice(0, 320);
    return joined.length >= 8 ? { text: joined } : { text: null };
  }

  if (hasNovelProperNouns(trimmed, haystack)) {
    return { text: null };
  }

  const clip = haystack.trim().slice(0, 240);
  return clip.length >= 8 ? { text: clip } : { text: null };
}

const MAX_BULLET_CHARS = 280;

/**
 * Extractive bullets: one bullet per claim (trimmed), no LLM.
 */
export function extractiveBulletsFromClaims(rows: ClaimRow[]): Array<{ text: string; claim_ids: string[]; importance_hint: number | null }> {
  const out: Array<{ text: string; claim_ids: string[]; importance_hint: number | null }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const t = r.text.replace(/\s+/g, " ").trim().slice(0, MAX_BULLET_CHARS);
    if (t.length < 6) continue;
    const key = t.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: t, claim_ids: [r.id], importance_hint: 0.5 });
  }
  return out;
}

/**
 * Hybrid: replace LLM bullet text with extractive clip assembled only from cited claims.
 */
export function hybridTextFromClaimIds(claimsById: Map<string, string>, claimIds: string[]): string | null {
  const parts: string[] = [];
  for (const id of claimIds) {
    const t = claimsById.get(id);
    if (t) parts.push(t.replace(/\s+/g, " ").trim());
  }
  const joined = parts.join("; ").trim().slice(0, MAX_BULLET_CHARS);
  return joined.length >= 6 ? joined : null;
}
