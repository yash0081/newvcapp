import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { mergeResearchAgenda } from "@/lib/copilot/db";
import { getSessionForUser } from "@/lib/copilot/db";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import { attributeRankingEvents } from "@/lib/copilot/recommender-weights";

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) {
    return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  let body: { host?: string } | null = null;
  try {
    body = await req.json();
  } catch {
    return withCopilotCors(req, NextResponse.json({ error: "Invalid JSON" }, { status: 400 }));
  }

  const host = body?.host?.trim().toLowerCase();
  if (!host) {
    return withCopilotCors(req, NextResponse.json({ ok: false, error: "Host required" }, { status: 400 }));
  }

  const admin = createAdminClient();
  const normalizedHost = host.replace(/^www\./, "");
  const apex = normalizedHost.split(".").slice(-2).join(".");
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) {
    return withCopilotCors(req, NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 }));
  }

  // Merge the blocked host into the agenda atomically (same pattern as decision route).
  await mergeResearchAgenda({
    admin,
    sessionId,
    userId: user.id,
    transform: (a) => {
      if (!a) return null;
      const blocked = a.blocked_hosts || [];
      for (const h of [host, normalizedHost, apex]) {
        if (h && !blocked.includes(h)) blocked.push(h);
      }
      const avoidHosts = a.intent.avoid_hosts || [];
      for (const h of [host, normalizedHost, apex]) {
        if (h && !avoidHosts.some((note) => note.target === h)) {
          avoidHosts.push({ target: h, reason: "User skipped — paywall/login" });
        }
      }
      return {
        ...a,
        blocked_hosts: blocked,
        intent: { ...a.intent, avoid_hosts: avoidHosts },
      };
    },
  });

  // Label attribution for recommender SGD (non-blocking, bulk mode for all unlabeled events).
  void attributeRankingEvents({
    admin,
    sessionId,
    userId: user.id,
    candidateHost: normalizedHost,
    label: 0,
    labelKind: "skip_host",
    windowMinutes: 30,
    bulk: true,
  }).catch(() => {});

  // Re-fetch the session to return the updated state.
  const updated = await getSessionForUser({ admin, sessionId, userId: user.id });

  return withCopilotCors(req, NextResponse.json({ ok: true, session: updated }));
}
