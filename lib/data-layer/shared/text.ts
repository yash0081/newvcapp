const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
  "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see",
  "two", "who", "way", "use", "that", "this", "with", "from", "they", "have", "been", "were",
  "said", "each", "which", "their", "time", "will", "about", "into", "than", "then", "them",
  "these", "some", "what", "when", "your", "more", "also", "such", "only", "other", "over",
  "most", "much", "very", "after", "being", "both", "those", "under", "while", "where", "would",
  "could", "should",
]);

export function extractKeywords(text: string, max = 40): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return Array.from(new Set(words)).slice(0, max);
}
