import "server-only";
import { embedTexts } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

type QueryError = { message?: string } | null;
type QueryResult<T> = { data: T; error: QueryError };
type QueryBuilder<T = Array<Record<string, unknown>> | null> = PromiseLike<QueryResult<T>> & {
  select: (...args: unknown[]) => QueryBuilder<T>;
  eq: (...args: unknown[]) => QueryBuilder<T>;
  order: (...args: unknown[]) => QueryBuilder<T>;
  limit: (...args: unknown[]) => QueryBuilder<T>;
  maybeSingle: () => Promise<QueryResult<Record<string, unknown> | null>>;
  upsert: (...args: unknown[]) => QueryBuilder<Record<string, unknown> | null>;
  update: (...args: unknown[]) => QueryBuilder<Record<string, unknown> | null>;
  insert: (...args: unknown[]) => QueryBuilder<Record<string, unknown> | null>;
};

type AdminClient = {
  schema: (s: string) => {
    from: (t: string) => unknown;
  };
};

function dealIntelTable(admin: AdminClient, table: string): QueryBuilder {
  return admin.schema("deal_intel").from(table) as QueryBuilder;
}

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
  focus_guidance?: string;
  confidence?: number;
  recency_weight?: number;
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
  const res = await dealIntelTable(admin, "deal")
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
    const sel = await dealIntelTable(args.admin, "user_research_site_preference")
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

    await dealIntelTable(args.admin, "user_research_site_preference")
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

    const existing = await dealIntelTable(args.admin, "website_preference")
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
      await dealIntelTable(args.admin, "website_preference")
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
      await dealIntelTable(args.admin, "website_preference").insert({
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
  const [siteRes, richRes] = await Promise.all([
    dealIntelTable(args.admin, "user_research_site_preference")
      .select("domain, preference_score, category, usage_count")
      .eq("user_id", args.userId)
      .order("preference_score", { ascending: false })
      .limit(lim),
    dealIntelTable(args.admin, "website_preference")
      .select("website_domain, task_types, focus_guidance, preference_score, confidence, recency_weight")
      .eq("user_id", args.userId)
      .order("updated_at", { ascending: false })
      .limit(Math.min(80, lim)),
  ]);
  if (siteRes.error && richRes.error) return { preferred: [], disliked: [] };
  const siteRows = (siteRes.data ?? []) as Array<{
    domain: string | null;
    preference_score: number | null;
    category: string | null;
    usage_count: number | null;
  }>;
  const normalized: UserSitePreference[] = siteRows
    .map((r) => ({
      domain: typeof r.domain === "string" ? asDomain(r.domain) : "",
      preference_score: Number(r.preference_score ?? 0),
      category: typeof r.category === "string" ? r.category : "general",
      usage_count: Number(r.usage_count ?? 0),
    }))
    .filter((r) => !!r.domain);
  const richRows = ((richRes.data ?? []) as Array<Record<string, unknown>>).flatMap((r): UserSitePreference[] => {
    const domain = typeof r.website_domain === "string" ? asDomain(r.website_domain) : "";
    if (!domain) return [];
    const taskTypes = Array.isArray(r.task_types) && r.task_types.length ? r.task_types : ["general"];
    const pref01 = Number(r.preference_score ?? 0.5);
    const confidence = Number(r.confidence ?? 0.5);
    const recency = Number(r.recency_weight ?? 1);
    const score = clamp((pref01 - 0.5) * 2 + (confidence - 0.5) * 0.25 + Math.min(0.12, Math.max(0, recency - 0.5) * 0.12), -1, 1);
    const focus = typeof r.focus_guidance === "string" ? r.focus_guidance.trim().slice(0, 220) : "";
    return taskTypes.slice(0, 5).map((taskType) => ({
      domain,
      preference_score: score,
      category: String(taskType || "general"),
      usage_count: 0,
      focus_guidance: focus || undefined,
      confidence,
      recency_weight: recency,
    }));
  });

  const byKey = new Map<string, UserSitePreference>();
  for (const row of [...normalized, ...richRows]) {
    if (!row.domain) continue;
    const key = `${row.domain}:${row.category || "general"}`;
    const prev = byKey.get(key);
    if (!prev || Math.abs(row.preference_score) > Math.abs(prev.preference_score)) {
      byKey.set(key, row);
    } else if (prev && row.focus_guidance && !prev.focus_guidance) {
      byKey.set(key, { ...prev, focus_guidance: row.focus_guidance, confidence: row.confidence, recency_weight: row.recency_weight });
    }
  }

  const combined = Array.from(byKey.values());
  return {
    preferred: combined
      .filter((r) => r.preference_score >= 0.05)
      .sort((a, b) => b.preference_score - a.preference_score)
      .slice(0, 40),
    disliked: combined
      .filter((r) => r.preference_score <= -0.05)
      .sort((a, b) => a.preference_score - b.preference_score)
      .slice(0, 40),
  };
}
