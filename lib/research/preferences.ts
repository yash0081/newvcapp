import "server-only";
import { embedTexts } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

type AdminClient = {
  schema: (s: string) => {
    from: (t: string) => unknown;
  };
};

type PreferenceEvent = {
  domain: string;
  category: string;
  deltaPreferenceScore: number;
  deltaUsageCount: number;
  reason?: string;
  task?: string;
};

export type UserSitePreference = {
  domain: string;
  preference_score: number;
  category: string;
  usage_count: number;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function asDomain(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  // If a URL was passed, normalize to hostname.
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) return new URL(s).hostname.toLowerCase();
  } catch {
    // ignore
  }
  return s.toLowerCase();
}

async function getDealCentroidEmbedding(admin: AdminClient, dealId: string, userId: string): Promise<string | null> {
  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .select("centroid_embedding")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) return null;
  const v = res.data?.centroid_embedding;
  return typeof v === "string" ? v : null;
}

export async function recordResearchPreferenceEvents(args: {
  admin: AdminClient;
  userId: string;
  dealId: string;
  events: PreferenceEvent[];
}) {
  const events = (args.events ?? [])
    .map((e) => ({
      ...e,
      domain: asDomain(e.domain),
      category: String(e.category || "general"),
    }))
    .filter((e) => e.domain && e.category);

  if (!events.length) return;

  // 1) Lightweight preference learning for planner ranking.
  for (const ev of events) {
    const sel = await args.admin
      .schema("deal_intel")
      .from("user_research_site_preference")
      .select("id, preference_score, usage_count, success_rate, metadata")
      .eq("user_id", args.userId)
      .eq("domain", ev.domain)
      .eq("category", ev.category)
      .maybeSingle();

    const prevPref = sel.data?.preference_score == null ? 0 : Number(sel.data.preference_score);
    const prevUsage = sel.data?.usage_count == null ? 0 : Number(sel.data.usage_count);
    const nextPref = clamp(prevPref + Number(ev.deltaPreferenceScore || 0), -1, 1);
    const nextUsage = Math.max(0, prevUsage + Math.floor(Number(ev.deltaUsageCount || 0)));

    const meta = (sel.data?.metadata && typeof sel.data.metadata === "object" ? sel.data.metadata : {}) as Record<string, unknown>;
    const history = Array.isArray(meta.history) ? (meta.history as unknown[]) : [];
    const nextMeta = {
      ...meta,
      last_event_at: new Date().toISOString(),
      history: [
        ...history.slice(-24),
        {
          at: new Date().toISOString(),
          reason: ev.reason ?? null,
          task: ev.task ?? null,
          deltaPreferenceScore: ev.deltaPreferenceScore,
          deltaUsageCount: ev.deltaUsageCount,
        },
      ],
    };

    await args.admin
      .schema("deal_intel")
      .from("user_research_site_preference")
      .upsert(
        {
          id: sel.data?.id,
          user_id: args.userId,
          domain: ev.domain,
          category: ev.category,
          preference_score: nextPref,
          usage_count: nextUsage,
          success_rate: sel.data?.success_rate == null ? 0.5 : Number(sel.data.success_rate),
          metadata: nextMeta,
        },
        { onConflict: "user_id,domain,category" }
      );
  }

  // 2) Populate the richer preference table (with embeddings), best-effort.
  // This is used later for more context-aware ranking and retrieval-time guidance.
  const companyEmbedding = await getDealCentroidEmbedding(args.admin, args.dealId, args.userId);

  const toEmbed = events.map((e) => ({
    domain: e.domain,
    // Situation: why/when the user uses this site for this category.
    situation: `${e.reason || "Research workflow action"} (category: ${e.category})`.slice(0, 4000),
    // Purpose: what the user is trying to get from the site (task text is best proxy).
    purpose: `${e.task || ""}`.slice(0, 4000),
  }));

  const embedInputs: string[] = [];
  for (const x of toEmbed) {
    embedInputs.push(x.situation || "research situation");
    embedInputs.push(x.purpose || "research purpose");
  }

  let embeds: number[][] = [];
  try {
    embeds = embedInputs.length ? await embedTexts(embedInputs, 24) : [];
  } catch {
    embeds = [];
  }

  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";

  for (let i = 0; i < toEmbed.length; i++) {
    const ev = events[i]!;
    const situationVec = embeds[i * 2] ?? null;
    const purposeVec = embeds[i * 2 + 1] ?? null;

    const existing = await args.admin
      .schema("deal_intel")
      .from("website_preference")
      .select("id, preference_score, frequency_score, quality_score, confidence, recency_weight, task_types")
      .eq("user_id", args.userId)
      .eq("website_domain", ev.domain)
      .maybeSingle();

    const prefPrev = existing.data?.preference_score == null ? 0.5 : Number(existing.data.preference_score);
    const pref01Delta = clamp(Number(ev.deltaPreferenceScore || 0) * 0.1, -0.1, 0.1);
    const prefNext = clamp(prefPrev + pref01Delta, 0, 1);

    const taskTypes = Array.isArray(existing.data?.task_types) ? (existing.data!.task_types as string[]) : [];
    const nextTaskTypes = taskTypes.includes(ev.category) ? taskTypes : [...taskTypes, ev.category].slice(0, 12);

    if (existing.data?.id) {
      await args.admin
        .schema("deal_intel")
        .from("website_preference")
        .update({
          situation_description: toEmbed[i]!.situation,
          focus_guidance: toEmbed[i]!.purpose,
          task_types: nextTaskTypes,
          preference_score: prefNext,
          recency_weight: 1.0,
          confidence: clamp((Number(existing.data.confidence ?? 0.5) + 0.02), 0, 1),
          context_embedding: situationVec ? vectorParam(situationVec) : undefined,
          purpose_embedding: purposeVec ? vectorParam(purposeVec) : undefined,
          company_embedding: companyEmbedding ?? undefined,
          embedding_model: model,
        })
        .eq("id", existing.data.id)
        .eq("user_id", args.userId);
    } else {
      await args.admin.schema("deal_intel").from("website_preference").insert({
        user_id: args.userId,
        website_domain: ev.domain,
        situation_description: toEmbed[i]!.situation,
        task_types: [ev.category],
        focus_guidance: toEmbed[i]!.purpose,
        frequency_score: 0.5,
        quality_score: 0.5,
        preference_score: prefNext,
        confidence: 0.55,
        recency_weight: 1.0,
        is_explicit: false,
        context_embedding: situationVec ? vectorParam(situationVec) : null,
        purpose_embedding: purposeVec ? vectorParam(purposeVec) : null,
        company_embedding: companyEmbedding,
        embedding_model: model,
      });
    }
  }
}

export async function getUserSitePreferences(args: {
  admin: AdminClient;
  userId: string;
  limit?: number;
}): Promise<{
  preferred: UserSitePreference[];
  disliked: UserSitePreference[];
}> {
  const lim = Math.max(10, Math.min(200, args.limit ?? 80));
  const res = await args.admin
    .schema("deal_intel")
    .from("user_research_site_preference")
    .select("domain, preference_score, category, usage_count")
    .eq("user_id", args.userId)
    .order("preference_score", { ascending: false })
    .limit(lim);
  if (res.error) return { preferred: [], disliked: [] };
  const rows = (res.data ?? []) as Array<{
    domain: string | null;
    preference_score: number | null;
    category: string | null;
    usage_count: number | null;
  }>;
  const normalized = rows
    .map((r) => ({
      domain: typeof r.domain === "string" ? asDomain(r.domain) : "",
      preference_score: Number(r.preference_score ?? 0),
      category: typeof r.category === "string" ? r.category : "general",
      usage_count: Number(r.usage_count ?? 0),
    }))
    .filter((r) => !!r.domain);
  return {
    preferred: normalized.filter((r) => r.preference_score >= 0.05).slice(0, 40),
    disliked: normalized.filter((r) => r.preference_score <= -0.05).slice(0, 40),
  };
}

