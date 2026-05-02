/**
 * Gates guest-turn verification so we do not score obvious discourse fragments
 * ("But", "And…") as standalone turns before the speaker finishes.
 */

/** Lowercase tokens that should merge into the next guest utterance instead of settling alone. */
const DISCOURSE_FRAGMENT_ONE_WORD = new Set([
  "but",
  "and",
  "or",
  "so",
  "well",
  "uh",
  "um",
  "er",
  "ah",
  "hmm",
]);

export function appendGuestCarryover(prefix: string | null | undefined, fragment: string): string {
  const a = typeof prefix === "string" ? prefix.trim() : "";
  const b = fragment.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

/**
 * True when the turn is only a filler prefix (e.g. "But", "But.", "uh um") with no substance yet.
 * One-word "yes"/"no" answers are NOT fragments — those can answer a tracked question.
 */
export function isDiscourseFragment(text: string): boolean {
  const stripped = text.trim().replace(/[.!?…]+$/g, "").trim().toLowerCase();
  if (!stripped) return true;
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 1) return DISCOURSE_FRAGMENT_ONE_WORD.has(words[0]!);
  if (words.length === 2) return words.every((w) => DISCOURSE_FRAGMENT_ONE_WORD.has(w));
  return false;
}
