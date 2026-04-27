import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

function isAbortLike(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e || "");
  return msg.includes("AbortError") || msg.includes("aborted") || msg.includes("The operation was aborted");
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/home/deals";

  // When running behind a proxy/tunnel (ngrok, Cloudflare tunnel, etc),
  // Next's `origin` can appear as `https://localhost:3000` because the proxy
  // terminates TLS but forwards to an HTTP local server. Prefer forwarded headers.
  const xfHost = request.headers.get("x-forwarded-host");
  const xfProto = request.headers.get("x-forwarded-proto");
  const baseOrigin = xfHost ? `${xfProto || "https"}://${xfHost}` : origin;

  try {
    if (code) {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(`${baseOrigin}${next}`);
      }
    }
    return NextResponse.redirect(`${baseOrigin}/?error=auth`);
  } catch (e) {
    // In dev, Next can abort this request while the browser follows redirects / restarts renders.
    // Treat AbortError as a non-fatal cancellation and continue to the next page.
    if (isAbortLike(e)) {
      return NextResponse.redirect(`${baseOrigin}${next}`);
    }
    throw e;
  }
}
