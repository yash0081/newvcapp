import "dotenv/config";
import http from "node:http";

/**
 * Cloud Run requires every revision to bind $PORT (default 8080) and accept HTTP traffic.
 *
 * IMPORTANT: Do **not** statically import `@/lib/deal-intel/bg-worker` at the top level — that
 * pulls in the entire dependency graph before `listen()` runs and routinely exceeds Cloud Run's
 * startup probe window ("failed to listen on PORT=8080"). Load the worker loop only **after**
 * the health server is bound (dynamic import inside the listen callback).
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

server.on("error", (err) => {
  console.error("[bg-worker] HTTP server error:", err);
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[bg-worker] health listen http://0.0.0.0:${port}/health pid=${process.pid}`);
  void (async () => {
    try {
      const { runBgWorkerLoop } = await import("@/lib/deal-intel/bg-worker");
      await runBgWorkerLoop({ workerId: `bg-worker:cli:${process.pid}` });
    } catch (e) {
      console.error(e instanceof Error ? e.stack : e);
      process.exit(1);
    }
  })();
});
