/**
 * Canonical repeat-detection key for copilot suggestions.
 *
 * Snippet-first so two suggestions that differ only by summary wording or
 * kind label (e.g. `new` vs `aligns`) collapse to one entry across server
 * and client dedupe paths.
 */
export function suggestionRepeatKey(summary: string, snippet: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9:/. -]/g, "")
      .trim()
      .slice(0, 220);
  return `${norm(snippet)}|${norm(summary)}`;
}
