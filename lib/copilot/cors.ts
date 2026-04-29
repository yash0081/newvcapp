import { NextResponse } from "next/server";

// Comma-separated list of allowed extension origins (e.g. chrome-extension://abc123).
// In production, set COPILOT_ALLOWED_EXTENSION_ORIGINS to your published id.
// During development, set COPILOT_ALLOW_DEV_EXTENSION=1 to accept any
// chrome-extension://* origin (preflight echo).
function readAllowList(): string[] {
  const raw = process.env.COPILOT_ALLOWED_EXTENSION_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With, X-Copilot-Source";
const ALLOWED_METHODS = "GET, POST, OPTIONS";

function isExtensionOrigin(origin: string): boolean {
  return /^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin);
}

function isAllowedExtensionOrigin(origin: string): boolean {
  if (!isExtensionOrigin(origin)) return false;
  if (process.env.COPILOT_ALLOW_DEV_EXTENSION === "1") return true;
  return readAllowList().includes(origin);
}

/**
 * Build CORS headers if the request's Origin is an allowed browser-extension
 * origin. Returns an empty object for same-origin or other browser requests so
 * the existing cookie-based auth flow is unchanged.
 */
export function copilotCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin) return {};
  if (!isAllowedExtensionOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function withCopilotCors(req: Request, res: NextResponse): NextResponse {
  const headers = copilotCorsHeaders(req);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

/** Standard preflight responder for /api/copilot/* routes. */
export function copilotPreflight(req: Request): NextResponse {
  const headers = copilotCorsHeaders(req);
  if (!Object.keys(headers).length) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers });
}
