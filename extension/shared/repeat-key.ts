/**
 * Canonical repeat-detection key for copilot suggestions.
 *
 * Mirrors lib/copilot/repeat-key.ts (extension cannot import server code).
 * Keep these two implementations in sync by review.
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
