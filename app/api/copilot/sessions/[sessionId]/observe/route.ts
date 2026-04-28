import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  getRecentDealClaims,
  getSessionForUser,
  insertCopilotEvent,
  insertCopilotEvents,
} from "@/lib/copilot/db";
import { extractFromImage } from "@/lib/copilot/extract";
import { analyzeAgainstDeal } from "@/lib/copilot/analyze";

const MIN_TEXT_CHARS = 40;
const MAX_IMAGE_BASE64_BYTES = 1_400_000; // ~1MB image after base64

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

function stripDataUrl(b64: string): string {
  if (!b64) return "";
  const idx = b64.indexOf(",");
  if (b64.startsWith("data:") && idx > 0) return b64.slice(idx + 1);
  return b64;
}

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        image?: string;
        mimeType?: string;
        capturedAt?: string;
        hostnameHint?: string;
        urlHint?: string;
      }
    | null;
  const rawImage = stripDataUrl(typeof body?.image === "string" ? body.image : "");
  if (!rawImage) return NextResponse.json({ error: "image is required" }, { status: 400 });
  if (rawImage.length > MAX_IMAGE_BASE64_BYTES) {
    return NextResponse.json({ error: "image too large" }, { status: 413 });
  }
  const mime = typeof body?.mimeType === "string" ? body.mimeType : "image/jpeg";

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "active") {
    return NextResponse.json({ error: "Session is not active" }, { status: 409 });
  }

  const dealRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("metadata")
    .eq("id", session.deal_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealRes.error) return NextResponse.json({ error: dealRes.error.message }, { status: 500 });
  const dealMeta = (dealRes.data?.metadata ?? {}) as Record<string, unknown>;
  const companyName = asCompanyName(dealMeta);

  let extracted;
  try {
    extracted = await extractFromImage({ imageBase64: rawImage, mimeType: mime });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "error",
        payload: { stage: "extract", message },
      },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!extracted || (extracted.visible_text || "").length < MIN_TEXT_CHARS) {
    return NextResponse.json({ ok: true, suggestions: [], reason: "no_usable_text" });
  }

  const hostname =
    (typeof body?.hostnameHint === "string" && body.hostnameHint.trim().toLowerCase()) ||
    extracted.hostname ||
    null;

  const obs = await insertCopilotEvent({
    admin,
    event: {
      session_id: sessionId,
      kind: "observation",
      hostname,
      payload: {
        captured_at: typeof body?.capturedAt === "string" ? body.capturedAt : new Date().toISOString(),
        url_hint: typeof body?.urlHint === "string" ? body.urlHint : null,
        page_title: extracted.page_title ?? null,
        visible_text: extracted.visible_text,
        key_value_claims: extracted.key_value_claims,
      },
    },
  });
  if (obs.error) return NextResponse.json({ error: obs.error.message }, { status: 500 });
  const observationEventId = obs.data?.id ?? null;

  const recentClaims = await getRecentDealClaims({ admin, dealId: session.deal_id, userId: user.id, limit: 50 });

  let suggestions;
  try {
    suggestions = await analyzeAgainstDeal({
      extracted,
      hostname,
      deal: { companyName, metadata: dealMeta, recentClaims },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "error",
        hostname,
        payload: { stage: "analyze", message },
        parent_event_id: observationEventId,
      },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (suggestions.length === 0) {
    return NextResponse.json({ ok: true, suggestions: [] });
  }

  const insertedEvents = await insertCopilotEvents({
    admin,
    events: suggestions.map((s) => ({
      session_id: sessionId,
      kind: "suggestion" as const,
      hostname: s.hostname ?? hostname,
      parent_event_id: observationEventId,
      payload: {
        client_id: s.client_id,
        summary: s.summary,
        snippet: s.snippet,
        kind: s.kind,
        confidence: s.confidence,
        source_label: s.source_label,
      },
    })),
  });
  if (insertedEvents.error) {
    return NextResponse.json({ error: insertedEvents.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    observationEventId,
    suggestions: (insertedEvents.data ?? []).map((row, i) => ({
      ...suggestions[i],
      event_id: row.id,
    })),
  });
}
