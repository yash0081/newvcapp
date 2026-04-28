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
import type { Extracted } from "@/lib/copilot/types";

const MAX_IMAGE_BASE64_BYTES = 1_400_000;

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
    | { text?: string; image?: string; mimeType?: string; hostnameHint?: string }
    | null;
  const text = String(body?.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

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

  const promptEvent = await insertCopilotEvent({
    admin,
    event: {
      session_id: sessionId,
      kind: "prompt",
      payload: { text },
    },
  });
  const promptEventId = promptEvent.data?.id ?? null;

  let extracted: Extracted | null = null;
  const rawImage = stripDataUrl(typeof body?.image === "string" ? body.image : "");
  if (rawImage) {
    if (rawImage.length > MAX_IMAGE_BASE64_BYTES) {
      return NextResponse.json({ error: "image too large" }, { status: 413 });
    }
    try {
      extracted = await extractFromImage({
        imageBase64: rawImage,
        mimeType: typeof body?.mimeType === "string" ? body.mimeType : "image/jpeg",
        hintText: text,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await insertCopilotEvent({
        admin,
        event: {
          session_id: sessionId,
          kind: "error",
          payload: { stage: "prompt_extract", message },
          parent_event_id: promptEventId,
        },
      });
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } else {
    // Best-effort: pull the most recent observation's extracted text so the
    // user can prompt without a fresh frame upload.
    const last = await admin
      .schema("deal_intel")
      .from("copilot_event")
      .select("hostname, payload")
      .eq("session_id", sessionId)
      .eq("kind", "observation")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last.data?.payload) {
      const p = last.data.payload as Record<string, unknown>;
      extracted = {
        visible_text: typeof p.visible_text === "string" ? p.visible_text : "",
        page_title: typeof p.page_title === "string" ? p.page_title : undefined,
        hostname:
          typeof p.hostname === "string"
            ? p.hostname
            : typeof last.data.hostname === "string"
              ? last.data.hostname
              : undefined,
        key_value_claims: Array.isArray(p.key_value_claims) ? (p.key_value_claims as Extracted["key_value_claims"]) : [],
      };
    }
  }

  if (!extracted || !extracted.visible_text) {
    return NextResponse.json({
      ok: true,
      suggestions: [],
      reason: "no_screen_context",
      message: "I don't have a recent screen capture. Start watching a tab and try again.",
    });
  }

  const hostname =
    (typeof body?.hostnameHint === "string" && body.hostnameHint.trim().toLowerCase()) ||
    extracted.hostname ||
    null;

  const recentClaims = await getRecentDealClaims({ admin, dealId: session.deal_id, userId: user.id, limit: 50 });

  let suggestions;
  try {
    suggestions = await analyzeAgainstDeal({
      extracted,
      hostname,
      userInstruction: text,
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
        payload: { stage: "prompt_analyze", message },
        parent_event_id: promptEventId,
      },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (suggestions.length === 0) {
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "reply",
        hostname,
        parent_event_id: promptEventId,
        payload: { text: "I couldn't find anything matching that on the current screen." },
      },
    });
    return NextResponse.json({ ok: true, suggestions: [], reply: "I couldn't find anything matching that on the current screen." });
  }

  const insertedEvents = await insertCopilotEvents({
    admin,
    events: suggestions.map((s) => ({
      session_id: sessionId,
      kind: "suggestion" as const,
      hostname: s.hostname ?? hostname,
      parent_event_id: promptEventId,
      payload: {
        client_id: s.client_id,
        summary: s.summary,
        snippet: s.snippet,
        kind: s.kind,
        confidence: s.confidence,
        source_label: s.source_label,
        from_prompt: true,
      },
    })),
  });
  if (insertedEvents.error) {
    return NextResponse.json({ error: insertedEvents.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    promptEventId,
    suggestions: (insertedEvents.data ?? []).map((row, i) => ({
      ...suggestions[i],
      event_id: row.id,
    })),
  });
}
