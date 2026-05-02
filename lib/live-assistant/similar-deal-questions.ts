import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { embedMeetingQuestionText } from "@/lib/live-assistant/meeting-embeddings";
import {
  findNearDuplicateTrackedQuestion,
  upsertMeetingTrackedQuestion,
} from "@/lib/live-assistant/tracked-questions";
import { loadLiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";

/**
 * Per-meeting "peer-style" question generator.
 *
 * REPLACES the old `similar_deal_question_template` recycler, which copied every
 * `meeting_assistant_event` (kind=suggested_question) into a templates table and re-served
 * them via cosine match. With no quality signal in the seed, bot junk became future
 * "peer questions" and produced cards like "What evidence would invalidate the external
 * dependency behind: '...'".
 *
 * The new design uses ONLY positive user signals as a style prior:
 *   - questions the host actually asked aloud in past meetings
 *     (`meeting_question_span.confirmed_by_llm = true` AND `linked_tracked_question_id IS NOT NULL`)
 *   - the host's preference signals (`loadLiveAssistantPreferenceSignals`)
 *
 * Then it makes a single grounded LLM call against the current meeting's recent claims and
 * proposes 0-3 fresh questions. There is NO templates table; the LLM never sees other bot
 * output.
 */

const MODEL = getLiveAssistantModel("fast");
const HYDRATE_COOLDOWN_MS = 60_000;
const MAX_NEW_QUESTIONS_PER_TICK = 3;

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "have", "has", "had", "are", "was", "were",
  "but", "from", "into", "about", "they", "them", "their", "our", "your", "you", "yours",
  "ours", "its", "what", "which", "than", "then", "also", "just", "very", "much", "many",
  "more", "most", "some", "any", "all", "we", "us", "be", "is", "of", "in", "on", "at",
  "to", "by", "as", "or", "if", "so", "do", "did", "does", "done", "been", "will", "would",
  "could", "should", "can", "got", "yes", "no", "not", "out", "up", "down", "off", "now",
  "how", "why", "when", "where", "who", "whom", "whose",
]);

/**
 * Bag of distinctive content tokens for grounding gates. Lowercased, punctuation stripped,
 * stop-words and short words dropped. Used to require that the LLM's question shares at
 * least one noun with one of the actual claims in the room.
 */
function topicTokens(text: string, max = 8): string[] {
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  if (!tokens.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function shareToken(text: string, claimTokens: ReadonlySet<string>): boolean {
  if (!claimTokens.size) return false;
  const t = text.toLowerCase();
  for (const tok of claimTokens) {
    if (t.includes(tok)) return true;
  }
  return false;
}

type RecentClaim = { id: string; text: string; section: string };
type StyleExample = { text: string };

async function loadRecentClaims(admin: SupabaseClient, meetingId: string): Promise<RecentClaim[]> {
  const sinceMs = Date.now() - 6 * 60_000;
  const res = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, section_labels, updated_at")
    .eq("meeting_id", meetingId)
    .gte("updated_at", new Date(sinceMs).toISOString())
    .order("updated_at", { ascending: false })
    .limit(15);
  if (res.error || !res.data) return [];
  return res.data
    .map((r) => {
      const labels = Array.isArray((r as { section_labels?: unknown }).section_labels)
        ? ((r as { section_labels: string[] }).section_labels)
        : [];
      const section = labels.find((s) => s && s !== "other") || labels[0] || "other";
      return {
        id: String((r as { id: string }).id),
        text: String((r as { text?: string }).text ?? "").trim(),
        section,
      };
    })
    .filter((r) => r.text.length >= 12);
}

/**
 * Pull verbatim spans the host actually said in past meetings that the system confirmed mapped
 * to a tracked diligence question. These are the only "good question" examples we trust.
 */
async function loadAskedAloudExamples(
  admin: SupabaseClient,
  userId: string,
  excludeMeetingId: string,
): Promise<StyleExample[]> {
  const meetingsRes = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id")
    .eq("host_user_id", userId)
    .neq("id", excludeMeetingId)
    .order("created_at", { ascending: false })
    .limit(40);
  if (meetingsRes.error || !meetingsRes.data?.length) return [];
  const meetingIds = meetingsRes.data.map((r) => String((r as { id: string }).id));

  const spansRes = await admin
    .schema("deal_intel")
    .from("meeting_question_span")
    .select("text, confirmed_by_llm, linked_tracked_question_id, created_at")
    .in("meeting_id", meetingIds)
    .eq("confirmed_by_llm", true)
    .not("linked_tracked_question_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (spansRes.error || !spansRes.data) return [];

  const seen = new Set<string>();
  const out: StyleExample[] = [];
  for (const r of spansRes.data) {
    const text = String((r as { text?: string }).text ?? "").trim();
    if (text.length < 8 || text.length > 320) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text });
    if (out.length >= 12) break;
  }
  return out;
}

const lastHydrateAt = new Map<string, number>();

export async function runUserStyleQuestionHydrate(
  admin: SupabaseClient,
  args: { meetingId: string; userId: string; dealId: string },
): Promise<void> {
  const lastInMem = lastHydrateAt.get(args.meetingId) ?? 0;
  if (lastInMem && Date.now() - lastInMem < HYDRATE_COOLDOWN_MS) return;

  // Defense-in-depth: also respect the persisted last_similar_hydrate_at so a process
  // restart doesn't burst the LLM.
  const stRes = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_similar_hydrate_at")
    .eq("meeting_id", args.meetingId)
    .maybeSingle();
  const lastDb = stRes.data?.last_similar_hydrate_at
    ? new Date(String(stRes.data.last_similar_hydrate_at)).getTime()
    : 0;
  if (lastDb && Date.now() - lastDb < HYDRATE_COOLDOWN_MS) {
    lastHydrateAt.set(args.meetingId, lastDb);
    return;
  }
  lastHydrateAt.set(args.meetingId, Date.now());

  const claims = await loadRecentClaims(admin, args.meetingId);
  if (!claims.length) {
    await touchHydrateState(admin, args.meetingId);
    return;
  }

  const [examples, prefs] = await Promise.all([
    loadAskedAloudExamples(admin, args.userId, args.meetingId),
    loadLiveAssistantPreferenceSignals(admin, args.userId).catch(() => null),
  ]);

  // Aggregate claim topic tokens once - the LLM gate later requires every proposed
  // question to reference at least one of these.
  const claimTokenSet = new Set<string>();
  for (const c of claims) for (const t of topicTokens(c.text)) claimTokenSet.add(t);
  if (!claimTokenSet.size) {
    await touchHydrateState(admin, args.meetingId);
    return;
  }

  const styleHint = examples.length
    ? `USER_STYLE (verbatim questions this user has asked aloud in past meetings - mimic the brevity and specificity, do not paraphrase):
${examples.map((e, i) => `${i + 1}. ${e.text}`).join("\n")}`
    : `USER_STYLE: (no prior asked-aloud questions captured. Default to crisp, specific VC follow-up questions.)`;

  const focusHints = prefs?.focusHints?.length ? `FOCUS_HINTS: ${prefs.focusHints.slice(0, 4).join(" | ")}` : "";
  const sectionWeights = prefs?.sectionWeights
    ? Object.entries(prefs.sectionWeights)
        .filter(([, w]) => typeof w === "number" && (w as number) >= 1.05)
        .map(([s]) => s)
    : [];
  const preferredSections = sectionWeights.length
    ? `PREFERRED_SECTIONS: ${sectionWeights.join(", ")}`
    : "";

  const claimsBlock = claims
    .map(
      (c, i) =>
        `${i + 1}. [id=${c.id}] [section=${c.section}] ${c.text.slice(0, 360)}`,
    )
    .join("\n");

  const prompt = `You are a sharp VC partner suggesting follow-up questions during a live diligence call.

Propose 0 to ${MAX_NEW_QUESTIONS_PER_TICK} questions a thoughtful investor would ask NEXT, grounded in the RECENT_CLAIMS below.

Hard rules:
- Each question MUST reference at least one specific noun, number, or entity that appears in one of the RECENT_CLAIMS. No generic, reusable, or template-ish questions.
- Do NOT propose assumption-inversion questions ("what breaks if...", "what evidence would invalidate..."), do NOT propose contradiction restates. Those are handled by other systems.
- Do NOT propose questions that are essentially restating a claim back as a question.
- Each question must be a single sentence, <= 180 chars, ending in a question mark.
- Output JSON only. Return {"questions": []} if there is nothing concrete and specific to ask.

RECENT_CLAIMS:
${claimsBlock}

${styleHint}

${preferredSections}
${focusHints}

Return JSON: {"questions": [{"text": "...", "section": "<one of: problem|solution|traction|gtm|market|team|financials|risks|other>", "grounded_in_claim_id": "<uuid from RECENT_CLAIMS>"}]}`;

  let raw: string;
  try {
    raw = await vertexRunWithText(MODEL, prompt, false);
  } catch (e) {
    console.error("runUserStyleQuestionHydrate LLM", e);
    await touchHydrateState(admin, args.meetingId);
    return;
  }

  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
    questions?: unknown;
  };
  const arr = Array.isArray(parsed?.questions) ? parsed.questions : [];

  const claimIdSet = new Set(claims.map((c) => c.id));
  const claimSectionById = new Map(claims.map((c) => [c.id, c.section]));

  let emitted = 0;
  for (const item of arr) {
    if (emitted >= MAX_NEW_QUESTIONS_PER_TICK) break;
    const r = (item && typeof item === "object" ? (item as Record<string, unknown>) : {}) as Record<string, unknown>;
    const text = String(r.text ?? "").trim();
    const groundedClaimId = String(r.grounded_in_claim_id ?? "").trim();
    if (!text) continue;
    if (text.length > 220) continue;
    if (!/\?\s*$/.test(text)) continue;

    // The LLM has to point at a specific claim - if it invented an id we drop the question.
    if (!claimIdSet.has(groundedClaimId)) continue;

    // And the question text itself has to share at least one topic token with the active
    // claims. This is the same gate `assumption-extract` uses to kill generic platitudes.
    if (!shareToken(text, claimTokenSet)) continue;

    const sectionRaw = String(r.section ?? "").trim().toLowerCase();
    const allowedSections = new Set([
      "problem", "solution", "traction", "gtm", "market", "team", "financials", "risks", "other",
    ]);
    const section = allowedSections.has(sectionRaw)
      ? sectionRaw
      : claimSectionById.get(groundedClaimId) || "other";

    let embedding: number[] | null = null;
    try {
      embedding = await embedMeetingQuestionText(text);
    } catch {
      embedding = null;
    }
    if (embedding && embedding.length) {
      const dup = await findNearDuplicateTrackedQuestion(admin, {
        meetingId: args.meetingId,
        embedding,
      });
      if (dup) continue;
    }

    await upsertMeetingTrackedQuestion(admin, {
      meetingId: args.meetingId,
      text,
      section,
      importanceWeight: 0.6,
      state: "unanswered",
      provenance: "peer_style",
      venue: "in_meeting",
      similarDealId: null,
      dedupeKey: `peer:${args.meetingId}:${groundedClaimId}:${text.slice(0, 80).toLowerCase().replace(/\s+/g, " ")}`,
      metadata: {
        grounded_in_claim_id: groundedClaimId,
        style_examples_used: examples.length,
      },
      syncEvent: { title: "Peer-style question", lane: "memo", severity: "low" },
    });
    emitted += 1;
  }

  await touchHydrateState(admin, args.meetingId);
}

async function touchHydrateState(admin: SupabaseClient, meetingId: string): Promise<void> {
  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      {
        meeting_id: meetingId,
        last_similar_hydrate_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "meeting_id" },
    );
}
