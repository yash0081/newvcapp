/**
 * Canonical repeat-detection key for copilot suggestions.
 *
 * Snippet-first so two suggestions that differ only by summary wording or
 * kind label (e.g. `new` vs `aligns`) collapse to one entry across server
 * and client dedupe paths.
 */
export function suggestionRepeatKey(summary: string, snippet: string, linkUrl?: string | null): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  // Focus on the content (snippet) and source (linkUrl) more than the LLM-generated summary.
  const urlPart = linkUrl ? linkUrl.toLowerCase().trim() : "";
  const sNorm = norm(summary).slice(0, 80);
  const snNorm = norm(snippet).slice(0, 120);
  
  return `${urlPart}|${snNorm}|${sNorm}`;
}
