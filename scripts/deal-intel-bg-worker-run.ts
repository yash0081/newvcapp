import "dotenv/config";
import http from "node:http";
import { runBgWorkerLoop } from "@/lib/deal-intel/bg-worker";

/**
 * Cloud Run requires every revision to bind $PORT (default 8080) and accept HTTP traffic.
 * This worker is otherwise a long-polling loop only — without a listener the deploy fails with:
 * "The user-provided container failed to start and listen on the port defined by PORT=8080".
 */
const port = Number(process.env.PORT ?? 8080);
if (!Number.isFinite(port) || port <= 0) {
  console.error("[bg-worker] Invalid PORT");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "/";
  if (path === "/" || path === "/health" || path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[bg-worker] health listen http://0.0.0.0:${port}/health`);
  void runBgWorkerLoop({ workerId: `bg-worker:cli:${process.pid}` }).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
});
