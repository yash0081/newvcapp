import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { getAutoSteeringNote, getSessionForUser } from "@/lib/copilot/db";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import {
  buildCopilotPreferenceTask,
  inferCopilotPreferenceCategory,
  normalizePreferenceDomain,
} from "@/lib/copilot/preference-signals";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const body = (await req.json().catch(() => null)) as
    | {
        action?: "manual_visit" | "open_link";
        url?: unknown;
        domain?: unknown;
        task?: unknown;
        summary?: unknown;
        snippet?: unknown;
      }
    | null;
  const action = body?.action === "manual_visit" || body?.action === "open_link" ? body.action : null;
  if (!action) return withCopilotCors(req, NextResponse.json({ error: "action is required" }, { status: 400 }));

  const domain = normalizePreferenceDomain(asString(body?.url)) ?? normalizePreferenceDomain(asString(body?.domain));
  if (!domain) return withCopilotCors(req, NextResponse.json({ ok: true, skipped: "no_domain" }));

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  const focus = getAutoSteeringNote(session.metadata);
  const summary = asString(body?.summary);
  const snippet = asString(body?.snippet);
  const task = asString(body?.task);
  await recordResearchPreferenceEvents({
    admin,
    userId: user.id,
    dealId: session.deal_id,
    events: [
      {
        domain,
        category: inferCopilotPreferenceCategory({ focus, task, summary, snippet }),
        deltaPreferenceScore: action === "open_link" ? 0.05 : 0.02,
        deltaUsageCount: 1,
        reason:
          action === "open_link"
            ? "User opened a copilot-suggested research link."
            : "User manually visited this site during a copilot research session.",
        task: buildCopilotPreferenceTask({
          focus,
          summary,
          snippet,
          pageTitle: task,
        }),
      },
    ],
  });

  return withCopilotCors(req, NextResponse.json({ ok: true }));
}
