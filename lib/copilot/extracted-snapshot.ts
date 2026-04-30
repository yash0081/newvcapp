import "server-only";
import type { Extracted, ExtractedKeyValue } from "@/lib/copilot/types";

const MAX_VISIBLE_TEXT_CHARS = 5000;
const MAX_KEY_VALUE_CLAIMS = 12;
const MAX_OUTBOUND_LINKS = 36;

function normalizeKeyValueClaims(v: unknown): ExtractedKeyValue[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedKeyValue[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim().slice(0, 200) : "";
    const value = typeof r.value === "string" ? r.value.trim().slice(0, 400) : "";
    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : 0.5;
    if (!key || !value) continue;
    out.push({ key, value, confidence });
    if (out.length >= MAX_KEY_VALUE_CLAIMS) break;
  }
  return out;
}

function normalizeOutboundLinks(v: unknown): Array<{ url: string; text: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const urlRaw = typeof r.url === "string" ? r.url.trim() : "";
    if (!urlRaw) continue;
    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalizedUrl = parsed.toString();
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const text = typeof r.text === "string" ? r.text.trim().slice(0, 120) : "";
    out.push({ url: normalizedUrl, text });
    if (out.length >= MAX_OUTBOUND_LINKS) break;
  }
  return out;
}

/**
 * Normalizes a client-supplied DOM snapshot into the same {@link Extracted}
 * shape the vision pipeline produces. Used when the Chrome extension sends
 * pre-extracted DOM text instead of a screenshot, so downstream analysis
 * code stays unchanged.
 */
export function normalizeExtractedSnapshot(input: {
  visible_text?: unknown;
  page_title?: unknown;
  hostname?: unknown;
  key_value_claims?: unknown;
  outbound_links?: unknown;
}): Extracted | null {
  const visible_text = typeof input?.visible_text === "string" ? input.visible_text.slice(0, MAX_VISIBLE_TEXT_CHARS) : "";
  if (!visible_text || visible_text.length < 10) return null;

  return {
    visible_text,
    page_title: typeof input?.page_title === "string" ? input.page_title.slice(0, 240) : undefined,
    hostname:
      typeof input?.hostname === "string" ? input.hostname.toLowerCase().slice(0, 240) : undefined,
    key_value_claims: normalizeKeyValueClaims(input?.key_value_claims),
    outbound_links: normalizeOutboundLinks(input?.outbound_links),
  };
}
