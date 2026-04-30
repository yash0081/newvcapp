/**
 * CLI worker runs under `tsx`, not the Next.js bundler. The real `server-only`
 * package throws on import; Next replaces it in app builds. Patch before any
 * `@/` imports so copilot / lib modules can load.
 */
import Module from "node:module";

const origLoad = Module._load.bind(Module);
(Module as { _load: typeof origLoad })._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return origLoad(request, parent, isMain);
};

void import("./deal-intel-bg-worker-run.ts").catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
