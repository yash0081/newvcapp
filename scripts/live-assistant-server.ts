/**
 * HTTP control plane for the LiveKit transcription worker on Cloud Run.
 *
 * Binds `PORT` (default 8080) before doing heavy work so deployment health checks pass.
 * Spawns one `npm run livekit-worker` child per started meeting, same as local dev.
 *
 * **Do not set `LIVE_ASSISTANT_URL` on this service** — that env is for the Vercel app to
 * find *this* URL. This process always uses in-container `getLocalWorkerState` / spawn.
 */
import Module from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ensureGoogleCloudCredentialsFile } from "@/lib/google-cloud-credentials";

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleWithLoad = Module as unknown as ModuleWithLoad;
const origLoad = moduleWithLoad._load.bind(Module);
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad(request, parent, isMain);
};

type WorkerCtl = typeof import("@/lib/live-assistant/worker-manager");

let workerCtlPromise: Promise<WorkerCtl> | null = null;
function loadWorkerCtl(): Promise<WorkerCtl> {
  if (!workerCtlPromise) {
    workerCtlPromise = import("@/lib/live-assistant/worker-manager");
  }
  return workerCtlPromise;
}

const port = Number(process.env.PORT ?? 8080);
if (!Number.isFinite(port) || port <= 0) {
  console.error("[live-assistant] Invalid PORT");
  process.exit(1);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function normalizeControlSecret(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function verifyControlAuth(req: IncomingMessage): { ok: true } | { ok: false; reason: string } {
  const raw = process.env.LIVE_ASSISTANT_CONTROL_SECRET;
  if (!raw?.trim()) {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        reason: "LIVE_ASSISTANT_CONTROL_SECRET must be set on the live-assistant Cloud Run service.",
      };
    }
    return { ok: true };
  }
  const required = normalizeControlSecret(raw);
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? normalizeControlSecret(auth.slice(7)) : null;
  const headerSecret =
    typeof req.headers["x-live-assistant-secret"] === "string"
      ? normalizeControlSecret(req.headers["x-live-assistant-secret"])
      : null;
  const token = bearer || headerSecret;
  if (!token || token !== required) {
    return { ok: false, reason: "Unauthorized" };
  }
  return { ok: true };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const workerPathRe = /^\/v1\/workers\/([^/]+)$/;

const server = createServer(async (req, res) => {
  const host = req.headers.host ?? "localhost";
  const rawUrl = req.url ?? "/";
  let pathname = "/";
  try {
    pathname = new URL(rawUrl, `http://${host}`).pathname;
  } catch {
    json(res, 400, { error: "Bad request URL" });
    return;
  }

  if (pathname === "/" || pathname === "/health" || pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }

  const auth = verifyControlAuth(req);
  if (!auth.ok) {
    json(res, 401, { error: auth.reason });
    return;
  }

  let ctl: WorkerCtl;
  try {
    ctl = await loadWorkerCtl();
  } catch (e) {
    console.error("[live-assistant] failed to load worker manager", e);
    json(res, 500, { error: "Internal server error" });
    return;
  }

  // Control routes — use local registry only (never proxy to self via LIVE_ASSISTANT_URL).
  if (req.method === "POST" && pathname === "/v1/workers") {
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { meetingId?: string; roomName?: string }) : {};
      const meetingId = typeof body.meetingId === "string" ? body.meetingId.trim() : "";
      const roomName = typeof body.roomName === "string" ? body.roomName.trim() : "";
      if (!meetingId || !roomName) {
        json(res, 400, { error: "Body must include meetingId and roomName strings." });
        return;
      }
      const state = ctl.startLocalWorkerForMeeting(meetingId, roomName);
      json(res, 200, { state });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 400, { error: msg });
    }
    return;
  }

  const pathMatch = pathname.match(workerPathRe);
  if (pathMatch && (req.method === "GET" || req.method === "DELETE")) {
    const meetingId = decodeURIComponent(pathMatch[1]!);
    let roomName = "";
    try {
      roomName = new URL(rawUrl, `http://${host}`).searchParams.get("roomName") ?? "";
    } catch {
      json(res, 400, { error: "Bad query" });
      return;
    }
    if (!roomName) {
      json(res, 400, { error: "Query must include roomName." });
      return;
    }
    try {
      if (req.method === "GET") {
        const state = ctl.getLocalWorkerState(meetingId, roomName);
        json(res, 200, { state });
        return;
      }
      const state = ctl.stopLocalWorkerForMeeting(meetingId, roomName);
      json(res, 200, { state });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.on("error", (err) => {
  console.error("[live-assistant] HTTP server error:", err);
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  ensureGoogleCloudCredentialsFile();
  console.log(
    `[live-assistant] listen http://0.0.0.0:${port} health=/health pid=${process.pid} (control /v1/workers)`,
  );
  void loadWorkerCtl().catch((e) => {
    console.error("[live-assistant] preload worker manager failed", e);
    process.exit(1);
  });
});
